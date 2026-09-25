"""Environment-backed application settings."""

from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Configuration kept server-side; no secrets are exposed to clients."""

    app_name: str = "RepCoach API"
    app_env: str = "development"
    log_level: str = "INFO"
    database_url: str = "postgresql+asyncpg://repcoach:repcoach_local_only@localhost:5433/repcoach"
    redis_url: str = "redis://localhost:6380/0"
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
    cognito_token_use: str = "access"
    cognito_jwks_cache_seconds: int = Field(default=3_600, ge=60, le=86_400)
    cognito_clock_skew_seconds: int = Field(default=60, ge=0, le=300)

    model_config = SettingsConfigDict(
        env_file="../.env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @property
    def allowed_origins(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
