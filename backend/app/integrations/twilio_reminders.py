"""Opt-in Twilio SMS delivery with deterministic local development behavior."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import UTC, datetime

from app.core.config import get_settings


@dataclass(frozen=True, slots=True)
class ReminderDelivery:
    provider: str
    delivery_id: str
    status: str


class TwilioReminderAdapter:
    def __init__(self) -> None:
        self.settings = get_settings()

    @property
    def is_configured(self) -> bool:
        return bool(
            self.settings.twilio_account_sid
            and self.settings.twilio_auth_token
            and self.settings.twilio_from_number
        )

    async def send(self, phone_number: str, body: str) -> ReminderDelivery:
        if not self.is_configured:
            return ReminderDelivery(
                provider="local",
                delivery_id=f"local-{datetime.now(UTC).timestamp():.0f}",
                status="simulated",
            )
        try:
            from twilio.rest import Client
        except ImportError as error:
            raise RuntimeError("Install the integrations extra to send Twilio reminders") from error

        def send_message() -> object:
            client = Client(self.settings.twilio_account_sid, self.settings.twilio_auth_token)
            return client.messages.create(
                from_=self.settings.twilio_from_number, to=phone_number, body=body
            )

        message = await asyncio.to_thread(send_message)
        return ReminderDelivery(
            provider="twilio", delivery_id=str(message.sid), status=str(message.status)
        )
