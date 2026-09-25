"""Idempotent Kafka consumer for asynchronous pose-form analysis."""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from typing import Any

from aiokafka import AIOKafkaProducer, ConsumerRecord
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.db.models import CoachingMemory, ExerciseRep
from app.db.session import SessionLocal
from app.domain import RepFeatures
from app.services.cache import dashboard_key, invalidate
from worker.classifier import PyTorchFormClassifier

logger = logging.getLogger(__name__)

RESULT_TOPIC = "form-analysis-results.v1"
DEAD_LETTER_TOPIC = "form-analysis.dlq.v1"
MAX_RETRIES = 3


def decode_event(value: bytes) -> dict[str, Any]:
    event = json.loads(value.decode("utf-8"))
    required = {"event_version", "rep_id", "session_id", "features"}
    missing = required - event.keys()
    if missing:
        raise ValueError(f"analysis event is missing fields: {sorted(missing)}")
    if event["event_version"] != 1:
        raise ValueError(f"unsupported event version {event['event_version']}")
    if not isinstance(event["features"], dict):
        raise ValueError("analysis event features must be an object")
    return event


def retry_count(record: ConsumerRecord) -> int:
    headers = dict(record.headers)
    raw = headers.get("x-retry-count")
    return int(raw.decode("utf-8")) if raw else 0


async def analyze_event(
    event: dict[str, Any], classifier: PyTorchFormClassifier, producer: AIOKafkaProducer
) -> bool:
    """Persist a final assessment once. Returns false for a harmless duplicate."""

    async with SessionLocal() as db:
        statement = (
            select(ExerciseRep)
            .where(ExerciseRep.id == event["rep_id"])
            .options(selectinload(ExerciseRep.session))
        )
        rep = (await db.execute(statement)).scalar_one_or_none()
        if rep is None:
            raise LookupError(f"rep {event['rep_id']} no longer exists")
        if rep.final_score is not None:
            logger.info("analysis duplicate ignored rep=%s", rep.id)
            return False

        prediction = classifier.predict(RepFeatures(**event["features"]))
        rep.final_score = prediction.assessment.score
        rep.form_label = prediction.assessment.label
        rep.feedback = prediction.assessment.cue
        rep.analysis_status = "complete"
        db.add(
            CoachingMemory(
                user_id=rep.session.user_id,
                session_id=rep.session_id,
                content=(
                    f"Rep {rep.ordinal}: {prediction.assessment.label}; {prediction.assessment.cue}"
                ),
                metadata_json={
                    "rep_id": rep.id,
                    "score": prediction.assessment.score,
                    "label": prediction.assessment.label,
                    "classifier_source": prediction.source,
                    "model_version": prediction.model_version,
                    "model_confidence": prediction.confidence,
                    "component_scores": dict(prediction.assessment.component_scores),
                },
            )
        )
        await db.commit()
        user_id = rep.session.user_id

    await invalidate(dashboard_key(user_id))
    result = {
        "event_version": 1,
        "rep_id": event["rep_id"],
        "session_id": event["session_id"],
        "analyzed_at": datetime.now(UTC).isoformat(),
        "assessment": {
            "score": prediction.assessment.score,
            "label": prediction.assessment.label,
            "cue": prediction.assessment.cue,
            "component_scores": dict(prediction.assessment.component_scores),
        },
        "classifier": {
            "source": prediction.source,
            "model_version": prediction.model_version,
            "confidence": prediction.confidence,
        },
    }
    await producer.send_and_wait(
        RESULT_TOPIC,
        json.dumps(result).encode("utf-8"),
        key=str(event["rep_id"]).encode("utf-8"),
    )
    return True


async def requeue_or_dead_letter(
    record: ConsumerRecord, producer: AIOKafkaProducer, error: Exception
) -> None:
    retries = retry_count(record)
    headers = [("x-retry-count", str(retries + 1).encode("utf-8"))]
    if retries + 1 >= MAX_RETRIES:
        payload = {
            "failed_at": datetime.now(UTC).isoformat(),
            "error": str(error),
            "original_topic": record.topic,
            "original_payload": record.value.decode("utf-8", errors="replace"),
        }
        await producer.send_and_wait(DEAD_LETTER_TOPIC, json.dumps(payload).encode("utf-8"))
        logger.error("analysis moved to DLQ offset=%s error=%s", record.offset, error)
        return
    await producer.send_and_wait(record.topic, record.value, key=record.key, headers=headers)
    logger.warning(
        "analysis requeued retry=%s offset=%s error=%s", retries + 1, record.offset, error
    )
