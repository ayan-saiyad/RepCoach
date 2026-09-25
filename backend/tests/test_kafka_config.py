"""Kafka transport configuration stays secure in AWS and simple locally."""

import asyncio
import ssl
import time

import pytest

from app.core.config import Settings
from worker import main as worker_main
from worker.kafka import MskIamTokenProvider, kafka_client_kwargs


def test_plaintext_kafka_defaults_match_local_compose() -> None:
    kwargs = kafka_client_kwargs(
        Settings(kafka_bootstrap_servers="localhost:19092"), client_id="test-client"
    )

    assert kwargs == {
        "bootstrap_servers": "localhost:19092",
        "client_id": "test-client",
    }


def test_msk_iam_configures_tls_and_oauth() -> None:
    kwargs = kafka_client_kwargs(
        Settings(
            kafka_bootstrap_servers="b-1.repcoach.kafka.us-east-1.amazonaws.com:9098",
            kafka_auth_mode="msk_iam",
            kafka_aws_region="us-east-1",
        ),
        client_id="test-client",
    )

    assert kwargs["security_protocol"] == "SASL_SSL"
    assert kwargs["sasl_mechanism"] == "OAUTHBEARER"
    assert isinstance(kwargs["ssl_context"], ssl.SSLContext)
    assert kwargs["ssl_context"].verify_mode == ssl.CERT_REQUIRED
    assert isinstance(kwargs["sasl_oauth_token_provider"], MskIamTokenProvider)


def test_msk_iam_requires_an_explicit_region() -> None:
    with pytest.raises(ValueError, match="KAFKA_AWS_REGION"):
        kafka_client_kwargs(Settings(kafka_auth_mode="msk_iam"), client_id="test-client")


@pytest.mark.asyncio
async def test_msk_token_provider_reuses_a_valid_token(monkeypatch: pytest.MonkeyPatch) -> None:
    provider = MskIamTokenProvider("us-east-1")
    generated: list[str] = []

    def generate() -> tuple[str, int]:
        generated.append("token")
        return "signed-token", int(time.time() * 1000) + 300_000

    monkeypatch.setattr(provider, "_generate_token", generate)

    assert await provider.token() == "signed-token"
    assert await provider.token() == "signed-token"
    assert generated == ["token"]


@pytest.mark.asyncio
async def test_worker_closes_started_kafka_clients_on_shutdown(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeProducer:
        def __init__(self, **kwargs: object) -> None:
            self.kwargs = kwargs
            self.started = False
            self.stopped = False

        async def start(self) -> None:
            self.started = True

        async def stop(self) -> None:
            self.stopped = True

    class FakeConsumer:
        def __init__(self, *_topics: object, **kwargs: object) -> None:
            self.kwargs = kwargs
            self.started = False
            self.stopped = False

        async def start(self) -> None:
            self.started = True

        async def stop(self) -> None:
            self.stopped = True

    producer = FakeProducer()
    consumer = FakeConsumer()
    stopped_database = False

    monkeypatch.setattr(worker_main, "AIOKafkaProducer", lambda **_kwargs: producer)
    monkeypatch.setattr(worker_main, "AIOKafkaConsumer", lambda *_args, **_kwargs: consumer)
    monkeypatch.setattr(worker_main, "get_settings", lambda: Settings())
    monkeypatch.setattr(worker_main, "dispose_database", lambda: _mark_database_stopped())

    async def _mark_database_stopped() -> None:
        nonlocal stopped_database
        stopped_database = True

    stop_event = asyncio.Event()
    stop_event.set()
    await worker_main.run_worker(stop_event)

    assert producer.started and producer.stopped
    assert consumer.started and consumer.stopped
    assert stopped_database
