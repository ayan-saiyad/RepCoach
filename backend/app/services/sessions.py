"""Workout session orchestration and deterministic server-side feedback."""

from __future__ import annotations

from collections import Counter, defaultdict
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.db.models import ExerciseRep, OutboxEvent, User, WorkoutSession
from app.domain.rep_engine import RepFeatures, score_rep
from app.schemas import (
    CreateSessionRequest,
    DashboardSummaryResponse,
    RecordRepRequest,
    RepFeaturesInput,
    RepResponse,
    SessionDetailResponse,
    SessionResponse,
    TrendPoint,
)
from app.services.cache import dashboard_key, invalidate


class SessionNotFoundError(LookupError):
    pass


class SessionNotActiveError(ValueError):
    pass


def to_session_response(session: WorkoutSession) -> SessionResponse:
    return SessionResponse(
        id=session.id,
        user_id=session.user_id,
        exercise_slug=session.exercise_slug,
        status=session.status,
        target_reps=session.target_reps,
        rep_count=session.rep_count,
        average_form_score=session.average_form_score,
        source=session.source,
        started_at=session.started_at,
        completed_at=session.completed_at,
    )


def to_rep_response(rep: ExerciseRep) -> RepResponse:
    return RepResponse(
        id=rep.id,
        ordinal=rep.ordinal,
        preliminary_score=round(rep.preliminary_score, 1),
        final_score=round(rep.final_score, 1) if rep.final_score is not None else None,
        form_label=rep.form_label,
        feedback=rep.feedback,
        analysis_status=rep.analysis_status,
        features=RepFeaturesInput.model_validate(rep.feature_payload),
        created_at=rep.created_at,
    )


def to_session_detail_response(session: WorkoutSession) -> SessionDetailResponse:
    response = to_session_response(session)
    return SessionDetailResponse(
        **response.model_dump(), reps=[to_rep_response(rep) for rep in session.reps]
    )


async def create_session(db: AsyncSession, request: CreateSessionRequest) -> WorkoutSession:
    user = await db.get(User, request.user_id)
    if user is None:
        user = User(id=request.user_id, display_name=request.display_name)
        db.add(user)

    workout = WorkoutSession(
        user_id=request.user_id,
        exercise_slug=request.exercise_slug,
        target_reps=request.target_reps,
        source=request.source,
    )
    db.add(workout)
    await db.commit()
    await db.refresh(workout)
    return workout


async def get_session(db: AsyncSession, session_id: str) -> WorkoutSession:
    statement = (
        select(WorkoutSession)
        .where(WorkoutSession.id == session_id)
        .options(selectinload(WorkoutSession.reps))
    )
    workout = (await db.execute(statement)).scalar_one_or_none()
    if workout is None:
        raise SessionNotFoundError(session_id)
    return workout


async def record_rep(
    db: AsyncSession, session_id: str, request: RecordRepRequest
) -> tuple[ExerciseRep, bool]:
    """Persist a rep and its outbox event atomically. Returns (rep, was_replayed)."""

    replay = await db.scalar(
        select(ExerciseRep).where(ExerciseRep.idempotency_key == request.idempotency_key)
    )
    if replay is not None:
        return replay, True

    workout = await db.get(WorkoutSession, session_id)
    if workout is None:
        raise SessionNotFoundError(session_id)
    if workout.status != "active":
        raise SessionNotActiveError(session_id)

    features = RepFeatures(**request.features.model_dump())
    assessment = score_rep(features)
    rep = ExerciseRep(
        session_id=workout.id,
        ordinal=workout.rep_count + 1,
        idempotency_key=request.idempotency_key,
        preliminary_score=assessment.score,
        form_label=assessment.label,
        feedback=assessment.cue,
        feature_payload=request.features.as_payload(),
        client_completed_at=request.client_completed_at,
    )
    db.add(rep)
    await db.flush()

    db.add(
        OutboxEvent(
            topic="form-analysis.v1",
            aggregate_id=rep.id,
            payload={
                "event_version": 1,
                "rep_id": rep.id,
                "session_id": workout.id,
                "features": request.features.as_payload(),
                "preliminary_score": assessment.score,
            },
        )
    )
    workout.rep_count += 1
    previous_total = (workout.average_form_score or 0) * (workout.rep_count - 1)
    workout.average_form_score = (previous_total + assessment.score) / workout.rep_count
    await db.commit()
    await db.refresh(rep)
    await invalidate(dashboard_key(workout.user_id))
    return rep, False


async def complete_session(db: AsyncSession, session_id: str) -> WorkoutSession:
    workout = await db.get(WorkoutSession, session_id)
    if workout is None:
        raise SessionNotFoundError(session_id)
    if workout.status == "active":
        workout.status = "completed"
        workout.completed_at = datetime.now(UTC)
        await db.commit()
        await db.refresh(workout)
        await invalidate(dashboard_key(workout.user_id))
    return workout


async def dashboard_summary(db: AsyncSession, user_id: str) -> DashboardSummaryResponse:
    statement = (
        select(WorkoutSession)
        .where(WorkoutSession.user_id == user_id)
        .order_by(WorkoutSession.started_at.desc())
        .options(selectinload(WorkoutSession.reps))
    )
    sessions = list((await db.execute(statement)).scalars().unique())
    reps = [rep for workout in sessions for rep in workout.reps]
    scored_reps = [
        rep.final_score if rep.final_score is not None else rep.preliminary_score for rep in reps
    ]
    now = datetime.now(UTC)
    week_ago = now - timedelta(days=7)
    weekly_reps = sum(1 for rep in reps if rep.created_at >= week_ago)
    cues = Counter(
        rep.feedback for rep in reps if rep.form_label not in {"good", "excellent"}
    )

    trend: dict[str, list[float]] = defaultdict(list)
    trend_counts: Counter[str] = Counter()
    for rep in reps:
        day = rep.created_at.date().isoformat()
        trend[day].append(rep.final_score if rep.final_score is not None else rep.preliminary_score)
        trend_counts[day] += 1
    form_trend = [
        TrendPoint(
            date=day, average_score=round(sum(scores) / len(scores), 1), reps=trend_counts[day]
        )
        for day, scores in sorted(trend.items())[-7:]
    ]

    completed_days = {
        session.completed_at.date()
        for session in sessions
        if session.completed_at is not None and session.status == "completed"
    }
    streak = 0
    cursor = now.date()
    while cursor in completed_days:
        streak += 1
        cursor -= timedelta(days=1)

    return DashboardSummaryResponse(
        user_id=user_id,
        total_sessions=len(sessions),
        total_reps=len(reps),
        weekly_reps=weekly_reps,
        average_form_score=round(sum(scored_reps) / len(scored_reps), 1) if scored_reps else None,
        current_streak_days=streak,
        common_cue=cues.most_common(1)[0][0] if cues else None,
        recent_sessions=[to_session_response(session) for session in sessions[:5]],
        form_trend=form_trend,
        generated_at=now,
    )
