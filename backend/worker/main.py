"""Run the durable outbox publisher and Kafka analysis consumer."""

from __future__ import annotations

import asyncio
import logging
import signal

from aiokafka import AIOKafkaConsumer, AIOKafkaProducer

from app.core.config import get_settings
from app.core.logging import configure_logging
from app.db.session import dispose_database
from worker.classifier import PyTorchFormClassifier
from worker.consumer import analyze_event, decode_event, requeue_or_dead_letter
from worker.kafka import kafka_client_kwargs
from worker.outbox import publish_pending_events

logger = logging.getLogger(__name__)
TOPIC = "form-analysis.v1"


async def run_worker(stop_event: asyncio.Event | None = None) -> None:
    """Run the worker until interrupted, closing Kafka clients in all paths."""

    settings = get_settings()
    classifier = PyTorchFormClassifier(settings.form_model_path)
    producer = AIOKafkaProducer(
        **kafka_client_kwargs(settings, client_id="repcoach-analysis-producer")
    )
    consumer = AIOKafkaConsumer(
        TOPIC,
        group_id="repcoach-form-analysis-v1",
        enable_auto_commit=False,
        auto_offset_reset="earliest",
        **kafka_client_kwargs(settings, client_id="repcoach-analysis-worker"),
    )
    producer_started = False
    consumer_started = False
    try:
        await producer.start()
        producer_started = True
        await consumer.start()
        consumer_started = True
        logger.info(
            "worker ready model_loaded=%s kafka_auth_mode=%s",
            classifier.is_model_loaded,
            settings.kafka_auth_mode,
        )
        while stop_event is None or not stop_event.is_set():
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
    except asyncio.CancelledError:
        logger.info("worker shutdown requested")
        raise
    finally:
        if consumer_started:
            await consumer.stop()
        if producer_started:
            await producer.stop()
        await dispose_database()


async def run_worker_until_signalled() -> None:
    """Translate container shutdown signals into a bounded, clean drain."""

    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    installed_signals: list[signal.Signals] = []
    for shutdown_signal in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(shutdown_signal, stop_event.set)
            installed_signals.append(shutdown_signal)
        except NotImplementedError:  # pragma: no cover - Windows lacks signal handlers.
            pass
    try:
        await run_worker(stop_event)
    finally:
        for shutdown_signal in installed_signals:
            loop.remove_signal_handler(shutdown_signal)


def main() -> None:
    settings = get_settings()
    configure_logging(settings.log_level)
    asyncio.run(run_worker_until_signalled())


if __name__ == "__main__":
    main()
