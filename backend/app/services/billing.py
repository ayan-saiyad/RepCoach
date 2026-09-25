"""Entitlement persistence after a verified Stripe lifecycle event."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Subscription
from app.schemas import SubscriptionResponse


def to_subscription_response(subscription: Subscription) -> SubscriptionResponse:
    return SubscriptionResponse(
        user_id=subscription.user_id,
        plan=subscription.plan,
        status=subscription.status,
        current_period_ends_at=subscription.current_period_ends_at,
    )


async def record_stripe_subscription(db: AsyncSession, event: Any) -> Subscription | None:
    """Map a verified checkout/subscription event to one entitlement record."""

    event_type = str(event["type"])
    data = event["data"]["object"]
    if event_type == "checkout.session.completed":
        user_id = data.get("client_reference_id") or data.get("metadata", {}).get(
            "repcoach_user_id"
        )
        subscription_id = data.get("subscription")
        customer_id = data.get("customer")
        status = "active"
    elif event_type.startswith("customer.subscription."):
        user_id = data.get("metadata", {}).get("repcoach_user_id")
        subscription_id = data.get("id")
        customer_id = data.get("customer")
        status = str(data.get("status", "inactive"))
    else:
        return None
    if not user_id:
        return None

    subscription = await db.scalar(select(Subscription).where(Subscription.user_id == user_id))
    if subscription is None:
        subscription = Subscription(user_id=user_id)
        db.add(subscription)
    subscription.plan = "pro" if status in {"active", "trialing", "past_due"} else "free"
    subscription.status = status
    subscription.stripe_customer_id = str(customer_id) if customer_id else None
    subscription.stripe_subscription_id = str(subscription_id) if subscription_id else None
    period_end = data.get("current_period_end")
    subscription.current_period_ends_at = (
        datetime.fromtimestamp(period_end, UTC) if isinstance(period_end, int) else None
    )
    await db.commit()
    await db.refresh(subscription)
    return subscription
