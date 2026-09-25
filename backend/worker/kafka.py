"""Kafka client configuration for local Redpanda and Amazon MSK IAM."""

from __future__ import annotations

import asyncio
import ssl
import time
from typing import Any

from aiokafka.abc import AbstractTokenProvider

from app.core.config import Settings


class MskIamTokenProvider(AbstractTokenProvider):
    """Refresh AWS MSK IAM SASL/OAUTHBEARER tokens before they expire.

    The signer obtains credentials through Boto3's default credential chain, so
    an ECS task role works without placing AWS credentials in environment
    variables or Secrets Manager.
    """

    _refresh_skew_ms = 60_000

    def __init__(self, region: str) -> None:
        self.region = region
        self._token: str | None = None
        self._expires_at_ms = 0
        self._lock = asyncio.Lock()

    def _generate_token(self) -> tuple[str, int]:
        try:
            from aws_msk_iam_sasl_signer import MSKAuthTokenProvider
        except ImportError as error:  # Defensive for custom development images.
            raise RuntimeError(
                "MSK IAM auth requires aws-msk-iam-sasl-signer-python. "
                "Install the backend production dependencies."
            ) from error
        return MSKAuthTokenProvider.generate_auth_token(self.region)

    async def token(self) -> str:
        now_ms = int(time.time() * 1000)
        if self._token is not None and now_ms < self._expires_at_ms - self._refresh_skew_ms:
            return self._token

        async with self._lock:
            now_ms = int(time.time() * 1000)
            if self._token is not None and now_ms < self._expires_at_ms - self._refresh_skew_ms:
                return self._token
            token, expires_at_ms = await asyncio.to_thread(self._generate_token)
            self._token = token
            self._expires_at_ms = expires_at_ms
            return token


def kafka_client_kwargs(settings: Settings, *, client_id: str) -> dict[str, Any]:
    """Build aiokafka kwargs without weakening local development defaults."""

    kwargs: dict[str, Any] = {
        "bootstrap_servers": settings.kafka_bootstrap_servers,
        "client_id": client_id,
    }
    if settings.kafka_auth_mode == "plaintext":
        return kwargs

    if not settings.kafka_aws_region:
        raise ValueError("KAFKA_AWS_REGION is required when KAFKA_AUTH_MODE=msk_iam")

    # aiokafka requires an explicit SSL context for SASL_SSL. The default
    # context validates Amazon's public broker certificates and hostnames.
    kwargs.update(
        security_protocol="SASL_SSL",
        ssl_context=ssl.create_default_context(),
        sasl_mechanism="OAUTHBEARER",
        sasl_oauth_token_provider=MskIamTokenProvider(settings.kafka_aws_region),
    )
    return kwargs
