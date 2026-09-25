"""RepCoach HTTP entrypoint."""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import health, sessions
from app.core.config import get_settings
from app.core.logging import configure_logging
from app.db.session import dispose_database, initialize_database

settings = get_settings()
configure_logging(settings.log_level)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_: FastAPI):
    if settings.auto_create_schema:
        await initialize_database()
        logger.info("database schema initialized")
    yield
    await dispose_database()


app = FastAPI(
    title="RepCoach API",
    version="0.1.0",
    summary="Pose-derived strength training feedback and workout history.",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Idempotency-Key"],
)
app.include_router(health.router)
app.include_router(sessions.router)


@app.get("/", include_in_schema=False)
async def root() -> dict[str, str]:
    return {"service": "RepCoach API", "docs": "/docs"}
