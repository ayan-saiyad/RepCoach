"""Managed-service connection settings remain testable without cloud credentials."""

from app.core.config import Settings


def test_managed_database_url_uses_individual_secret_fields() -> None:
    settings = Settings(
        _env_file=None,
        database_host="repcoach-db.example.amazonaws.com",
        database_port=5432,
        database_name="repcoach",
        database_user="repcoach",
        database_password="unsafe:/ password",
        database_ssl=True,
    )

    assert settings.resolved_database_url == (
        "postgresql+asyncpg://repcoach:unsafe%3A%2F%20password@"
        "repcoach-db.example.amazonaws.com:5432/repcoach"
    )
    assert settings.database_ssl is True


def test_managed_redis_url_uses_tls_when_requested() -> None:
    settings = Settings(
        _env_file=None,
        redis_host="repcoach-cache.example.amazonaws.com",
        redis_port=6379,
        redis_ssl=True,
    )

    assert settings.resolved_redis_url == "rediss://repcoach-cache.example.amazonaws.com:6379/0"


def test_local_urls_remain_the_default_developer_path() -> None:
    settings = Settings(_env_file=None)

    assert settings.resolved_database_url == settings.database_url
    assert settings.resolved_redis_url == settings.redis_url
