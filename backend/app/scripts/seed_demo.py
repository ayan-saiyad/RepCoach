"""Seed a small, non-sensitive RepCoach demo history.

Run with ``python -m app.scripts.seed_demo`` after applying migrations. The
script is idempotent so a repeat invocation never duplicates a demo session.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from app.db.models import ExerciseRep, OutboxEvent, User, WorkoutSession
from app.db.session import SessionLocal
from app.domain import RepFeatures, score_rep

DEMO_USER_ID = "demo-athlete"

FEATURES = (
    RepFeatures(98, 18, 4, 820, 760, 0.96),
    RepFeatures(113, 22, 5, 760, 690, 0.94),
    RepFeatures(128, 20, 4, 730, 680, 0.94),
    RepFeatures(101, 16, 11, 840, 750, 0.95),
)


async def seed() -> int:
    async with SessionLocal() as db:
        existing = await db.scalar(
            select(WorkoutSession.id).where(WorkoutSession.user_id == DEMO_USER_ID).limit(1)
        )
        if existing is not None:
            print("Demo workout history already exists; nothing to seed.")
            return 0
        if await db.get(User, DEMO_USER_ID) is None:
            db.add(User(id=DEMO_USER_ID, display_name="Alex Athlete"))

        now = datetime.now(UTC)
        for offset, rep_features in enumerate(FEATURES):
            completed_at = now - timedelta(days=len(FEATURES) - offset - 1)
            assessment = score_rep(rep_features)
            workout = WorkoutSession(
                user_id=DEMO_USER_ID,
                exercise_slug="bodyweight-squat",
                status="completed",
                target_reps=1,
                rep_count=1,
                average_form_score=assessment.score,
                source="demo-seed",
                started_at=completed_at - timedelta(minutes=2),
                completed_at=completed_at,
            )
            db.add(workout)
            await db.flush()
            rep = ExerciseRep(
                session_id=workout.id,
                ordinal=1,
                idempotency_key=f"seed-{offset:02d}-form-rep",
                preliminary_score=assessment.score,
                form_label=assessment.label,
                feedback=assessment.cue,
                analysis_status="queued",
                feature_payload={
                    "minimum_knee_angle": rep_features.minimum_knee_angle,
                    "maximum_torso_lean": rep_features.maximum_torso_lean,
                    "maximum_knee_valgus": rep_features.maximum_knee_valgus,
                    "eccentric_duration_ms": rep_features.eccentric_duration_ms,
                    "concentric_duration_ms": rep_features.concentric_duration_ms,
                    "landmark_confidence": rep_features.landmark_confidence,
                },
                client_completed_at=completed_at,
                created_at=completed_at,
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
                        "features": rep.feature_payload,
                        "preliminary_score": assessment.score,
                    },
                    created_at=completed_at,
                )
            )
        await db.commit()
    print(f"Seeded {len(FEATURES)} demo sessions for {DEMO_USER_ID}.")
    return len(FEATURES)


def main() -> None:
    asyncio.run(seed())


if __name__ == "__main__":
    main()
