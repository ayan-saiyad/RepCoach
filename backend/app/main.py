"""RepCoach HTTP entrypoint."""

import hmac
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.routes import billing, coach, health, reminders, sessions
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
    allow_headers=["Authorization", "Content-Type", "Idempotency-Key", "X-RepCoach-Dev-User"],
)


@app.middleware("http")
async def require_trusted_edge(request: Request, call_next):
    """Reject direct ALB requests when production is fronted by CloudFront.

    ECS target health probes remain deliberately available so the load balancer
    can remove unhealthy tasks. Every product/API route requires the random
    origin header that only the CloudFront distribution receives from Secrets
    Manager at deploy time.
    """

    if (
        settings.edge_origin_required
        and request.url.path not in {"/health", "/livez", "/readyz"}
        and (
            not settings.edge_origin_token
            or not hmac.compare_digest(
                request.headers.get("X-RepCoach-Origin", ""), settings.edge_origin_token
            )
        )
    ):
        return JSONResponse(status_code=403, content={"detail": "Trusted edge required"})
    return await call_next(request)
app.include_router(health.router)
app.include_router(sessions.router)
app.include_router(coach.router)
app.include_router(billing.router)
app.include_router(reminders.router)


@app.get("/", include_in_schema=False)
async def root() -> dict[str, str]:
    return {"service": "RepCoach API", "docs": "/docs"}
