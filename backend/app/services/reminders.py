"""Opt-in reminder persistence and test delivery orchestration."""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Reminder, User
from app.integrations.twilio_reminders import ReminderDelivery, TwilioReminderAdapter
from app.schemas import ReminderResponse, UpsertReminderRequest


def to_reminder_response(reminder: Reminder) -> ReminderResponse:
    return ReminderResponse(
        id=reminder.id,
        user_id=reminder.user_id,
        phone_number=reminder.phone_number,
        timezone=reminder.timezone,
        local_time=reminder.local_time,
        enabled=reminder.enabled,
        last_delivery_status=reminder.last_delivery_status,
        last_sent_at=reminder.last_sent_at,
    )


async def upsert_reminder(
    db: AsyncSession, user_id: str, request: UpsertReminderRequest
) -> Reminder:
    user = await db.get(User, user_id)
    if user is None:
        user = User(id=user_id, display_name="Athlete")
        db.add(user)
    reminder = await db.scalar(select(Reminder).where(Reminder.user_id == user_id))
    if reminder is None:
        reminder = Reminder(user_id=user_id, **request.model_dump())
        db.add(reminder)
    else:
        for field, value in request.model_dump().items():
            setattr(reminder, field, value)
    await db.commit()
    await db.refresh(reminder)
    return reminder


async def send_test_reminder(db: AsyncSession, user_id: str) -> tuple[Reminder, ReminderDelivery]:
    reminder = await db.scalar(select(Reminder).where(Reminder.user_id == user_id))
    if reminder is None:
        raise LookupError(user_id)
    if not reminder.enabled:
        raise ValueError("Reminder is disabled")
    delivery = await TwilioReminderAdapter().send(
        reminder.phone_number,
        "RepCoach: your planned strength session is ready when you are. Reply STOP to opt out.",
    )
    reminder.last_delivery_status = delivery.status
    reminder.last_sent_at = datetime.now(UTC)
    await db.commit()
    await db.refresh(reminder)
    return reminder, delivery
