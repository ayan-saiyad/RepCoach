"""Run the durable outbox publisher and Kafka analysis consumer."""

from __future__ import annotations

import asyncio
import logging

from aiokafka import AIOKafkaConsumer, AIOKafkaProducer

from app.core.config import get_settings
from app.core.logging import configure_logging
from app.db.session import dispose_database
from worker.classifier import PyTorchFormClassifier
from worker.consumer import analyze_event, decode_event, requeue_or_dead_letter
from worker.outbox import publish_pending_events

logger = logging.getLogger(__name__)
TOPIC = "form-analysis.v1"


async def run_worker() -> None:
    settings = get_settings()
    classifier = PyTorchFormClassifier(settings.form_model_path)
    producer = AIOKafkaProducer(bootstrap_servers=settings.kafka_bootstrap_servers)
    consumer = AIOKafkaConsumer(
        TOPIC,
        bootstrap_servers=settings.kafka_bootstrap_servers,
        group_id="repcoach-form-analysis-v1",
        enable_auto_commit=False,
        auto_offset_reset="earliest",
    )
    await producer.start()
    await consumer.start()
    logger.info("worker started model_loaded=%s", classifier.is_model_loaded)
    try:
        while True:
            published = await publish_pending_events(producer)
            if published:
                logger.info("published outbox events count=%s", published)

            batches = await consumer.getmany(timeout_ms=750, max_records=50)
            for _, records in batches.items():
                for record in records:
                    try:
                        await analyze_event(decode_event(record.value), classifier, producer)
                    except Exception as error:  # noqa: BLE001 - retry/DLQ is the recovery boundary.
                        await requeue_or_dead_letter(record, producer, error)
                await consumer.commit()
    finally:
        await consumer.stop()
        await producer.stop()
        await dispose_database()


def main() -> None:
    settings = get_settings()
    configure_logging(settings.log_level)
    asyncio.run(run_worker())


if __name__ == "__main__":
    main()
