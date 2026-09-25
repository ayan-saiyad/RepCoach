"""Public API contracts. These models deliberately contain only pose-derived data."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class RepFeaturesInput(BaseModel):
    minimum_knee_angle: float = Field(ge=35, le=180)
    maximum_torso_lean: float = Field(ge=0, le=90)
    maximum_knee_valgus: float = Field(ge=0, le=60)
    eccentric_duration_ms: int = Field(ge=100, le=10_000)
    concentric_duration_ms: int = Field(ge=100, le=10_000)
    landmark_confidence: float = Field(ge=0, le=1)

    def as_payload(self) -> dict[str, float | int]:
        return self.model_dump()


class CreateSessionRequest(BaseModel):
    user_id: str = Field(default="demo-athlete", min_length=3, max_length=36)
    display_name: str = Field(default="Athlete", min_length=1, max_length=100)
    exercise_slug: str = Field(default="bodyweight-squat", pattern=r"^[a-z0-9-]+$")
    target_reps: int = Field(default=10, ge=1, le=100)
    source: str = Field(default="mobile", max_length=32)


class RecordRepRequest(BaseModel):
    idempotency_key: str = Field(min_length=8, max_length=128)
    client_completed_at: datetime | None = None
    features: RepFeaturesInput


class FormAssessmentResponse(BaseModel):
    score: float
    label: str
    cue: str
    component_scores: dict[str, float]


class RepResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    ordinal: int
    preliminary_score: float
    final_score: float | None
    form_label: str
    feedback: str
    analysis_status: str
    features: RepFeaturesInput
    created_at: datetime


class SessionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    user_id: str
    exercise_slug: str
    status: str
    target_reps: int
    rep_count: int
    average_form_score: float | None
    source: str
    started_at: datetime
    completed_at: datetime | None


class SessionDetailResponse(SessionResponse):
    reps: list[RepResponse]


class TrendPoint(BaseModel):
    date: str
    average_score: float
    reps: int


class DashboardSummaryResponse(BaseModel):
    user_id: str
    total_sessions: int
    total_reps: int
    weekly_reps: int
    average_form_score: float | None
    current_streak_days: int
    common_cue: str | None
    recent_sessions: list[SessionResponse]
    form_trend: list[TrendPoint]
    generated_at: datetime


class CompleteSessionResponse(BaseModel):
    session: SessionResponse
    coaching_note: str
