"""Create RepCoach's Kafka topics before production workers are enabled.

Amazon MSK Serverless intentionally does not offer CloudFormation topic
resources.  This module is therefore run once as a narrowly scoped ECS task
after the cluster and immutable worker image exist, and before the long-lived
worker service begins consuming records.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Iterable

from aiokafka.admin import AIOKafkaAdminClient, NewTopic
from aiokafka.errors import for_code

from app.core.config import Settings, get_settings
from app.core.logging import configure_logging
from worker.kafka import kafka_client_kwargs

logger = logging.getLogger(__name__)

TOPIC_NAMES = (
    "form-analysis.v1",
    "form-analysis-results.v1",
    "form-analysis.dlq.v1",
)
_TOPIC_ALREADY_EXISTS_ERROR_CODE = 36


def required_topics(settings: Settings) -> tuple[NewTopic, ...]:
    """Return portable topic specs for local Redpanda and MSK Serverless."""

    is_serverless = settings.kafka_auth_mode == "msk_iam"
    return tuple(
        NewTopic(
            name,
            num_partitions=3 if is_serverless else 1,
            replication_factor=3 if is_serverless else 1,
        )
        for name in TOPIC_NAMES
    )


def _raise_topic_errors(errors: Iterable[tuple[object, ...]]) -> None:
    """Treat an idempotent create race as success and fail for every other error."""

    for topic_error in errors:
        if len(topic_error) < 2:
            raise RuntimeError(f"Kafka returned malformed topic creation response: {topic_error!r}")
        topic_name, code = topic_error[0], topic_error[1]
        if code in {0, _TOPIC_ALREADY_EXISTS_ERROR_CODE}:
            continue
        message = topic_error[2] if len(topic_error) > 2 else None
        error_type = for_code(code)
        raise error_type(f"Could not create topic {topic_name}: {message or 'unknown error'}")


async def ensure_topics(settings: Settings) -> tuple[str, ...]:
    """Create missing RepCoach topics and return the topic names created now."""

    admin = AIOKafkaAdminClient(
        **kafka_client_kwargs(settings, client_id="repcoach-topic-bootstrap")
    )
    started = False
    try:
        await admin.start()
        started = True
        existing_topics = set(await admin.list_topics())
        missing_topics = [
            topic for topic in required_topics(settings) if topic.name not in existing_topics
        ]
        if not missing_topics:
            logger.info("Kafka topics already exist count=%s", len(TOPIC_NAMES))
            return ()
        response = await admin.create_topics(missing_topics)
        _raise_topic_errors(getattr(response, "topic_errors", ()))
        created = tuple(topic.name for topic in missing_topics)
        logger.info("Kafka topics created topics=%s", ",".join(created))
        return created
    finally:
        if started:
            await admin.close()


async def main_async() -> None:
    settings = get_settings()
    configure_logging(settings.log_level)
    await ensure_topics(settings)


def main() -> None:
    asyncio.run(main_async())


if __name__ == "__main__":
    main()
