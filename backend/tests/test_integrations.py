"""Local-safe adapter behavior for optional cloud and messaging services."""

from types import SimpleNamespace

import pytest

from app.integrations.stripe_billing import StripeBillingAdapter
from app.integrations.twilio_reminders import TwilioReminderAdapter
from app.services.coaching import local_coach_answer


def test_local_billing_checkout_is_available_without_a_stripe_key() -> None:
    checkout = StripeBillingAdapter().create_checkout("demo-athlete", "pro")

    assert checkout.provider == "local"
    assert checkout.session_id == "local-pro-demo-athlete"


@pytest.mark.asyncio
async def test_local_reminder_delivery_never_sends_an_sms() -> None:
    delivery = await TwilioReminderAdapter().send("+15551234567", "Test reminder")

    assert delivery.provider == "local"
    assert delivery.status == "simulated"


def test_local_coach_grounds_advice_in_the_latest_memory() -> None:
    memory = SimpleNamespace(content="Rep 5: shallow_depth; Squat deeper with control.")

    answer = local_coach_answer("How can I improve my depth?", [memory])

    assert "heels grounded" in answer
    assert "shallow_depth" in answer
