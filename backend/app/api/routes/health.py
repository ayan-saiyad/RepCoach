"""Liveness and readiness endpoints for orchestration probes."""

import asyncio
import logging
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, status

from app.db.session import check_database_connection
from app.services.cache import check_cache_connection

router = APIRouter(tags=["health"])
logger = logging.getLogger(__name__)


def response(status_value: str) -> dict[str, str]:
    return {
        "status": status_value,
        "service": "repcoach-api",
        "timestamp": datetime.now(UTC).isoformat(),
    }


@router.get("/health")
async def health() -> dict[str, str]:
    """Backward-compatible liveness endpoint."""

    return response("ok")


@router.get("/livez", include_in_schema=False)
async def livez() -> dict[str, str]:
    """Report that this process can serve requests without external I/O."""

    return response("live")


@router.get("/readyz", include_in_schema=False)
async def readyz() -> dict[str, str]:
    """Report dependency reachability needed for normal API operation."""

    database_check, cache_check = await asyncio.gather(
        check_database_connection(), check_cache_connection(), return_exceptions=True
    )
    failures = [
        name
        for name, result in (("database", database_check), ("cache", cache_check))
        if isinstance(result, Exception)
    ]
    if failures:
        logger.warning("readiness probe failed dependencies=%s", ",".join(failures))
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Service dependencies are unavailable",
        )
    return response("ready")
