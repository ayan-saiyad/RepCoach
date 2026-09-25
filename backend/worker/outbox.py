"""Transactional-outbox publisher for reliable Kafka delivery."""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime

from aiokafka import AIOKafkaProducer
from sqlalchemy import select

from app.db.models import OutboxEvent
from app.db.session import SessionLocal

logger = logging.getLogger(__name__)


async def publish_pending_events(producer: AIOKafkaProducer, batch_size: int = 50) -> int:
    """Publish a bounded outbox batch and mark only acknowledged events sent.

    A crash after Kafka acknowledges but before the database commit may publish a
    duplicate. The consumer is deliberately idempotent, which is the correct
    trade-off for at-least-once delivery without a distributed transaction.
    """

    sent = 0
    async with SessionLocal() as db:
        statement = (
            select(OutboxEvent)
            .where(OutboxEvent.published_at.is_(None))
            .order_by(OutboxEvent.created_at)
            .limit(batch_size)
            .with_for_update(skip_locked=True)
        )
        events = list((await db.execute(statement)).scalars())
        for event in events:
            try:
                await producer.send_and_wait(
                    event.topic,
                    json.dumps(event.payload).encode("utf-8"),
                    key=event.aggregate_id.encode("utf-8"),
                )
                event.published_at = datetime.now(UTC)
                event.attempts += 1
                sent += 1
            except Exception as error:  # noqa: BLE001 - a transport failure is retryable.
                event.attempts += 1
                logger.warning("outbox publish failed event=%s error=%s", event.id, error)
                break
        await db.commit()
    return sent
