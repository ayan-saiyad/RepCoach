"""Environment-backed application settings."""

from functools import lru_cache
from typing import Literal
from urllib.parse import quote

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Configuration kept server-side; no secrets are exposed to clients."""

    app_name: str = "RepCoach API"
    app_env: str = "development"
    log_level: str = "INFO"
    database_url: str = "postgresql+asyncpg://repcoach:repcoach_local_only@localhost:5433/repcoach"
    database_host: str | None = None
    database_port: int = Field(default=5432, ge=1, le=65535)
    database_name: str = "repcoach"
    database_user: str | None = None
    database_password: str | None = None
    database_ssl: bool = False
    redis_url: str = "redis://localhost:6380/0"
    redis_host: str | None = None
    redis_port: int = Field(default=6379, ge=1, le=65535)
    redis_ssl: bool = False
    kafka_bootstrap_servers: str = "localhost:19092"
    kafka_auth_mode: Literal["plaintext", "msk_iam"] = "plaintext"
    kafka_aws_region: str | None = None
    cors_origins: str = "http://localhost:3000,http://localhost:8081"
    form_model_path: str | None = None
    bedrock_region: str = "us-east-1"
    bedrock_model_id: str | None = None
    bedrock_embedding_model_id: str | None = None
    stripe_secret_key: str | None = None
    stripe_webhook_secret: str | None = None
    stripe_price_pro: str | None = None
    stripe_success_url: str = (
        "http://localhost:3000/billing/success?session_id={CHECKOUT_SESSION_ID}"
    )
    stripe_cancel_url: str = "http://localhost:3000/billing/cancelled"
    twilio_account_sid: str | None = None
    twilio_auth_token: str | None = None
    twilio_from_number: str | None = None
    auto_create_schema: bool = Field(default=True)
    # Local demos intentionally work without an identity provider. Production
    # requests fail closed if this remains enabled.
    auth_disabled: bool = True
    cognito_region: str | None = None
    cognito_user_pool_id: str | None = None
    cognito_app_client_id: str | None = None
    # A public native client has a distinct Cognito client ID from the
    # dashboard. Keep the first field for compatibility and add any additional
    # approved clients as a comma-separated, server-only allow-list.
    cognito_app_client_ids: str | None = None
    cognito_token_use: str = "access"
    cognito_jwks_cache_seconds: int = Field(default=3_600, ge=60, le=86_400)
    cognito_clock_skew_seconds: int = Field(default=60, ge=0, le=300)
    edge_origin_required: bool = False
    edge_origin_token: str | None = None

    model_config = SettingsConfigDict(
        env_file="../.env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @property
    def allowed_origins(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def resolved_database_url(self) -> str:
        """Construct a DSN from ECS-friendly individual secret/environment fields.

        Local developers can continue using DATABASE_URL. Production tasks never
        need to materialize the full connection string in CloudFormation because
        only DATABASE_PASSWORD is injected from the RDS-managed secret.
        """

        if not self.database_host:
            return self.database_url
        if not self.database_user or self.database_password is None:
            raise ValueError(
                "DATABASE_USER and DATABASE_PASSWORD are required when DATABASE_HOST is set"
            )
        user = quote(self.database_user, safe="")
        password = quote(self.database_password, safe="")
        name = quote(self.database_name, safe="")
        return (
            f"postgresql+asyncpg://{user}:{password}@{self.database_host}:"
            f"{self.database_port}/{name}"
        )

    @property
    def resolved_redis_url(self) -> str:
        """Construct a TLS-aware Redis/Valkey URL for managed-cache tasks."""

        if not self.redis_host:
            return self.redis_url
        scheme = "rediss" if self.redis_ssl else "redis"
        return f"{scheme}://{self.redis_host}:{self.redis_port}/0"

    @property
    def allowed_cognito_app_client_ids(self) -> tuple[str, ...]:
        """Return the explicit audience allow-list for Cognito access tokens."""

        values = [self.cognito_app_client_id or ""]
        values.extend((self.cognito_app_client_ids or "").split(","))
        return tuple(dict.fromkeys(value.strip() for value in values if value.strip()))


@lru_cache
def get_settings() -> Settings:
    return Settings()
