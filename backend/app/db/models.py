"""Durable workout, assessment, and outbox records."""

from __future__ import annotations

from datetime import datetime
from uuid import uuid4

from pgvector.sqlalchemy import Vector
from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


def new_id() -> str:
    return str(uuid4())


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    email: Mapped[str | None] = mapped_column(String(320), unique=True, nullable=True)
    display_name: Mapped[str] = mapped_column(String(100), default="Athlete")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    sessions: Mapped[list[WorkoutSession]] = relationship(back_populates="user")


class WorkoutSession(Base):
    __tablename__ = "workout_sessions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    exercise_slug: Mapped[str] = mapped_column(String(64), default="bodyweight-squat")
    status: Mapped[str] = mapped_column(String(24), default="active", index=True)
    target_reps: Mapped[int] = mapped_column(Integer, default=10)
    rep_count: Mapped[int] = mapped_column(Integer, default=0)
    average_form_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    source: Mapped[str] = mapped_column(String(32), default="mobile")
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    user: Mapped[User] = relationship(back_populates="sessions")
    reps: Mapped[list[ExerciseRep]] = relationship(
        back_populates="session", cascade="all, delete-orphan", order_by="ExerciseRep.ordinal"
    )


class ExerciseRep(Base):
    __tablename__ = "exercise_reps"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    session_id: Mapped[str] = mapped_column(ForeignKey("workout_sessions.id"), index=True)
    ordinal: Mapped[int] = mapped_column(Integer)
    idempotency_key: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    preliminary_score: Mapped[float] = mapped_column(Float)
    final_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    form_label: Mapped[str] = mapped_column(String(40))
    feedback: Mapped[str] = mapped_column(Text)
    analysis_status: Mapped[str] = mapped_column(String(24), default="queued")
    feature_payload: Mapped[dict[str, float | int]] = mapped_column(JSON)
    client_completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    session: Mapped[WorkoutSession] = relationship(back_populates="reps")


class OutboxEvent(Base):
    """Transactional event record. A publisher claims it after the DB commit."""

    __tablename__ = "outbox_events"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    topic: Mapped[str] = mapped_column(String(120), index=True)
    aggregate_id: Mapped[str] = mapped_column(String(36), index=True)
    payload: Mapped[dict[str, object]] = mapped_column(JSON)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class CoachingMemory(Base):
    """Textual coaching context with an optional pgvector embedding."""

    __tablename__ = "coaching_memories"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    session_id: Mapped[str | None] = mapped_column(
        ForeignKey("workout_sessions.id"), nullable=True, index=True
    )
    content: Mapped[str] = mapped_column(Text)
    embedding: Mapped[list[float] | None] = mapped_column(Vector(1536), nullable=True)
    metadata_json: Mapped[dict[str, object]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class Subscription(Base):
    """Server-side entitlement state reconciled from verified Stripe events."""

    __tablename__ = "subscriptions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), unique=True, index=True)
    plan: Mapped[str] = mapped_column(String(32), default="free")
    status: Mapped[str] = mapped_column(String(32), default="inactive")
    stripe_customer_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    stripe_subscription_id: Mapped[str | None] = mapped_column(
        String(128), unique=True, nullable=True
    )
    current_period_ends_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class Reminder(Base):
    """An explicit, opt-in workout reminder with provider delivery metadata."""

    __tablename__ = "reminders"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), unique=True, index=True)
    phone_number: Mapped[str] = mapped_column(String(32))
    timezone: Mapped[str] = mapped_column(String(64), default="America/Chicago")
    local_time: Mapped[str] = mapped_column(String(5), default="18:00")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    last_delivery_status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    last_sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
