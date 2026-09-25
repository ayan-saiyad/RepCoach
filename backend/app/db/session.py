"""Async database session lifecycle."""

from collections.abc import AsyncIterator

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import get_settings

# Import models before metadata creation so every table is registered.
from app.db import models  # noqa: F401
from app.db.base import Base

settings = get_settings()
engine = create_async_engine(settings.database_url, pool_pre_ping=True)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


async def initialize_database() -> None:
    """Provision local schema; production deploys should use Alembic instead."""

    async with engine.begin() as connection:
        if connection.dialect.name == "postgresql":
            await connection.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        await connection.run_sync(Base.metadata.create_all)


async def check_database_connection() -> None:
    """Execute a minimal query for readiness probes without mutating state."""

    async with engine.connect() as connection:
        await connection.execute(text("SELECT 1"))


async def dispose_database() -> None:
    await engine.dispose()


async def get_database_session() -> AsyncIterator[AsyncSession]:
    async with SessionLocal() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise
