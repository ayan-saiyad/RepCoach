"""Stripe-backed checkout and subscription entitlement endpoints."""

from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import Principal, get_current_principal, require_user_access
from app.db.models import Subscription
from app.db.session import get_database_session
from app.integrations.stripe_billing import StripeBillingAdapter
from app.schemas import CheckoutResponse, CreateCheckoutRequest, SubscriptionResponse
from app.services.billing import record_stripe_subscription, to_subscription_response

router = APIRouter(prefix="/v1/billing", tags=["billing"])
DbSession = Annotated[AsyncSession, Depends(get_database_session)]
PrincipalDep = Annotated[Principal, Depends(get_current_principal)]


@router.post("/checkout", response_model=CheckoutResponse, status_code=status.HTTP_201_CREATED)
async def create_checkout(
    request: CreateCheckoutRequest, principal: PrincipalDep
) -> CheckoutResponse:
    require_user_access(principal, request.user_id)
    try:
        checkout = StripeBillingAdapter().create_checkout(request.user_id, request.plan)
    except RuntimeError as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(error)
        ) from error
    return CheckoutResponse(
        checkout_url=checkout.checkout_url,
        provider=checkout.provider,
        session_id=checkout.session_id,
    )


@router.get("/{user_id}", response_model=SubscriptionResponse)
async def read_subscription(
    user_id: str, principal: PrincipalDep, db: DbSession
) -> SubscriptionResponse:
    require_user_access(principal, user_id)
    subscription = await db.scalar(select(Subscription).where(Subscription.user_id == user_id))
    if subscription is None:
        return SubscriptionResponse(
            user_id=user_id, plan="free", status="inactive", current_period_ends_at=None
        )
    return to_subscription_response(subscription)


@router.post("/webhook", status_code=status.HTTP_204_NO_CONTENT)
async def stripe_webhook(
    request: Request,
    db: DbSession,
    stripe_signature: Annotated[str | None, Header(alias="Stripe-Signature")] = None,
) -> None:
    # Stripe is authenticated by its signed webhook payload rather than an
    # athlete token. It must remain reachable by Stripe's webhook dispatcher.
    try:
        event = StripeBillingAdapter().construct_webhook(await request.body(), stripe_signature)
        await record_stripe_subscription(db, event)
    except RuntimeError as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(error)
        ) from error
    except Exception as error:  # Stripe signature failures intentionally reveal no payload details.
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid Stripe webhook"
        ) from error
