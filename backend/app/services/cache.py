"""Best-effort Redis cache for read-heavy dashboard aggregates."""

from __future__ import annotations

import json
import logging
from typing import Any

from redis.asyncio import Redis, from_url
from redis.exceptions import RedisError

from app.core.config import get_settings

logger = logging.getLogger(__name__)
_client: Redis | None = None


def dashboard_key(user_id: str) -> str:
    return f"dashboard-summary:v1:{user_id}"


def get_cache() -> Redis:
    global _client
    if _client is None:
        _client = from_url(get_settings().resolved_redis_url, decode_responses=True)
    return _client


async def check_cache_connection() -> None:
    """Ping Redis for an orchestration readiness probe."""

    await get_cache().ping()


async def read_json(key: str) -> dict[str, Any] | None:
    try:
        cached = await get_cache().get(key)
        return json.loads(cached) if cached else None
    except (RedisError, json.JSONDecodeError) as error:
        logger.warning("cache read skipped: %s", error)
        return None


async def write_json(key: str, value: dict[str, Any], ttl_seconds: int = 60) -> None:
    try:
        await get_cache().set(key, json.dumps(value, default=str), ex=ttl_seconds)
    except RedisError as error:
        logger.warning("cache write skipped: %s", error)


async def invalidate(key: str) -> None:
    try:
        await get_cache().delete(key)
    except RedisError as error:
        logger.warning("cache invalidation skipped: %s", error)
