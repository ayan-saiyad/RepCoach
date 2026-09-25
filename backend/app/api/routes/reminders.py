"""Explicit opt-in SMS reminder settings and safe test delivery."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Reminder
from app.db.session import get_database_session
from app.schemas import (
    ReminderDeliveryResponse,
    ReminderResponse,
    UpsertReminderRequest,
)
from app.services.reminders import send_test_reminder, to_reminder_response, upsert_reminder

router = APIRouter(prefix="/v1/reminders", tags=["reminders"])
DbSession = Annotated[AsyncSession, Depends(get_database_session)]


@router.put("/{user_id}", response_model=ReminderResponse)
async def save_reminder(
    user_id: str, request: UpsertReminderRequest, db: DbSession
) -> ReminderResponse:
    return to_reminder_response(await upsert_reminder(db, user_id, request))


@router.get("/{user_id}", response_model=ReminderResponse)
async def read_reminder(user_id: str, db: DbSession) -> ReminderResponse:
    reminder = await db.scalar(select(Reminder).where(Reminder.user_id == user_id))
    if reminder is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No reminder configured")
    return to_reminder_response(reminder)


@router.post("/{user_id}/test", response_model=ReminderDeliveryResponse)
async def test_reminder(user_id: str, db: DbSession) -> ReminderDeliveryResponse:
    try:
        reminder, delivery = await send_test_reminder(db, user_id)
    except LookupError as error:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="No reminder configured"
        ) from error
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(error)
        ) from error
    return ReminderDeliveryResponse(
        reminder=to_reminder_response(reminder),
        provider=delivery.provider,
        delivery_id=delivery.delivery_id,
        status=delivery.status,
    )
