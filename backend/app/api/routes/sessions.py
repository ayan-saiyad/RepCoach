"""Workout session and rep ingestion endpoints."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import Principal, get_current_principal, require_user_access
from app.db.session import get_database_session
from app.schemas import (
    CompleteSessionResponse,
    CreateSessionRequest,
    DashboardSummaryResponse,
    RecordRepRequest,
    RepResponse,
    SessionDetailResponse,
    SessionResponse,
)
from app.services.cache import dashboard_key, read_json, write_json
from app.services.sessions import (
    SessionNotActiveError,
    SessionNotFoundError,
    complete_session,
    create_session,
    dashboard_summary,
    get_session,
    record_rep,
    to_rep_response,
    to_session_detail_response,
    to_session_response,
)

router = APIRouter(prefix="/v1", tags=["workouts"])
DbSession = Annotated[AsyncSession, Depends(get_database_session)]
PrincipalDep = Annotated[Principal, Depends(get_current_principal)]


def missing_session(session_id: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND, detail=f"Session {session_id} was not found"
    )


async def read_owned_session(
    session_id: str, principal: Principal, db: AsyncSession
):
    """Load a session and ensure its owner is the authenticated athlete."""

    try:
        workout = await get_session(db, session_id)
    except SessionNotFoundError as error:
        raise missing_session(session_id) from error
    require_user_access(principal, workout.user_id)
    return workout


@router.post("/sessions", response_model=SessionResponse, status_code=status.HTTP_201_CREATED)
async def start_session(
    request: CreateSessionRequest, principal: PrincipalDep, db: DbSession
) -> SessionResponse:
    require_user_access(principal, request.user_id)
    return to_session_response(await create_session(db, request))


@router.get("/sessions/{session_id}", response_model=SessionDetailResponse)
async def read_session(
    session_id: str, principal: PrincipalDep, db: DbSession
) -> SessionDetailResponse:
    return to_session_detail_response(await read_owned_session(session_id, principal, db))


@router.post(
    "/sessions/{session_id}/reps", response_model=RepResponse, status_code=status.HTTP_201_CREATED
)
async def ingest_rep(
    session_id: str,
    request: RecordRepRequest,
    response: Response,
    principal: PrincipalDep,
    db: DbSession,
) -> RepResponse:
    await read_owned_session(session_id, principal, db)
    try:
        rep, was_replayed = await record_rep(db, session_id, request)
    except SessionNotFoundError as error:
        raise missing_session(session_id) from error
    except SessionNotActiveError as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Cannot append a rep to a completed session",
        ) from error
    if was_replayed:
        response.status_code = status.HTTP_200_OK
        response.headers["Idempotent-Replay"] = "true"
    return to_rep_response(rep)


@router.post("/sessions/{session_id}/complete", response_model=CompleteSessionResponse)
async def finish_session(
    session_id: str, principal: PrincipalDep, db: DbSession
) -> CompleteSessionResponse:
    await read_owned_session(session_id, principal, db)
    try:
        workout = await complete_session(db, session_id)
    except SessionNotFoundError as error:
        raise missing_session(session_id) from error
    score = workout.average_form_score
    note = (
        "Nice work. Your movement quality held steady through the set."
        if score is not None and score >= 85
        else "Review your lowest-scoring rep and keep the next set smooth and controlled."
    )
    return CompleteSessionResponse(session=to_session_response(workout), coaching_note=note)


@router.get("/dashboard/{user_id}/summary", response_model=DashboardSummaryResponse)
async def get_dashboard_summary(
    user_id: str, principal: PrincipalDep, db: DbSession
) -> DashboardSummaryResponse:
    require_user_access(principal, user_id)
    cache_key = dashboard_key(user_id)
    cached = await read_json(cache_key)
    if cached is not None:
        return DashboardSummaryResponse.model_validate(cached)
    summary = await dashboard_summary(db, user_id)
    await write_json(cache_key, summary.model_dump(mode="json"))
    return summary
