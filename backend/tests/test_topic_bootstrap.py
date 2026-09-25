from __future__ import annotations

from types import SimpleNamespace

import pytest
from aiokafka.errors import InvalidTopicError

from app.core.config import Settings
from worker import bootstrap_topics


def settings(**overrides: object) -> Settings:
    values: dict[str, object] = {
        "kafka_bootstrap_servers": "broker.example:9098",
        "kafka_auth_mode": "msk_iam",
        "kafka_aws_region": "us-east-1",
    }
    values.update(overrides)
    return Settings(**values)


def test_required_topics_use_serverless_durability() -> None:
    topics = bootstrap_topics.required_topics(settings())

    assert [topic.name for topic in topics] == list(bootstrap_topics.TOPIC_NAMES)
    assert {(topic.num_partitions, topic.replication_factor) for topic in topics} == {(3, 3)}


def test_required_topics_keep_local_single_broker_compatible() -> None:
    topics = bootstrap_topics.required_topics(
        settings(kafka_auth_mode="plaintext", kafka_aws_region=None)
    )

    assert {(topic.num_partitions, topic.replication_factor) for topic in topics} == {(1, 1)}


def test_creation_race_is_idempotent() -> None:
    bootstrap_topics._raise_topic_errors(
        (("form-analysis.v1", 0, None), ("form-analysis-results.v1", 36, "already exists"))
    )


def test_creation_error_preserves_broker_failure() -> None:
    with pytest.raises(InvalidTopicError):
        bootstrap_topics._raise_topic_errors((("form-analysis.v1", 17, "invalid topic"),))


@pytest.mark.asyncio
async def test_ensure_topics_creates_only_missing_topics(monkeypatch: pytest.MonkeyPatch) -> None:
    created: list[object] = []

    class FakeAdmin:
        async def start(self) -> None:
            return None

        async def close(self) -> None:
            return None

        async def list_topics(self) -> list[str]:
            return ["form-analysis.v1"]

        async def create_topics(self, topics: list[object]) -> SimpleNamespace:
            created.extend(topics)
            return SimpleNamespace(topic_errors=())

    monkeypatch.setattr(bootstrap_topics, "AIOKafkaAdminClient", lambda **_: FakeAdmin())

    result = await bootstrap_topics.ensure_topics(settings())

    assert result == ("form-analysis-results.v1", "form-analysis.dlq.v1")
    assert [topic.name for topic in created] == list(result)
