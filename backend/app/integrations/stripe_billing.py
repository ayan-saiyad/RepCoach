"""Stripe Checkout and verified-webhook adapter, imported only when configured."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from app.core.config import get_settings

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class CheckoutSession:
    checkout_url: str
    session_id: str
    provider: str


class StripeBillingAdapter:
    """Keep Stripe transport at the server boundary and never expose secret keys."""

    def __init__(self) -> None:
        self.settings = get_settings()

    @property
    def is_configured(self) -> bool:
        return bool(self.settings.stripe_secret_key and self.settings.stripe_price_pro)

    def create_checkout(self, user_id: str, plan: str) -> CheckoutSession:
        if plan == "free":
            return CheckoutSession(
                checkout_url="http://localhost:3000/billing/free",
                session_id=f"local-free-{user_id}",
                provider="local",
            )
        if not self.is_configured:
            return CheckoutSession(
                checkout_url="http://localhost:3000/billing/demo",
                session_id=f"local-pro-{user_id}",
                provider="local",
            )
        try:
            import stripe

            stripe.api_key = self.settings.stripe_secret_key
            checkout = stripe.checkout.Session.create(
                mode="subscription",
                line_items=[{"price": self.settings.stripe_price_pro, "quantity": 1}],
                client_reference_id=user_id,
                success_url=self.settings.stripe_success_url,
                cancel_url=self.settings.stripe_cancel_url,
                metadata={"repcoach_user_id": user_id, "plan": plan},
            )
            return CheckoutSession(
                checkout_url=str(checkout.url),
                session_id=str(checkout.id),
                provider="stripe",
            )
        except (ImportError, AttributeError, KeyError, TypeError) as error:
            logger.exception("Stripe checkout setup failed: %s", error)
            raise RuntimeError("Stripe checkout is unavailable") from error

    def construct_webhook(self, payload: bytes, signature: str | None) -> Any:
        if not (
            self.settings.stripe_secret_key and self.settings.stripe_webhook_secret and signature
        ):
            raise RuntimeError("Stripe webhook verification is not configured")
        try:
            import stripe

            stripe.api_key = self.settings.stripe_secret_key
            return stripe.Webhook.construct_event(
                payload, signature, self.settings.stripe_webhook_secret
            )
        except ImportError as error:
            raise RuntimeError(
                "Install the integrations extra to verify Stripe webhooks"
            ) from error
