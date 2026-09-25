"""Liveness endpoint kept dependency-free for orchestration probes."""

from datetime import UTC, datetime

from fastapi import APIRouter

router = APIRouter(tags=["health"])


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "repcoach-api", "timestamp": datetime.now(UTC).isoformat()}
