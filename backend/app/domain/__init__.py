"""Pure domain contracts for RepCoach pose and rep analysis."""

from .rep_engine import (
    FormAssessment,
    PoseFrame,
    RepEvent,
    RepFeatures,
    SquatPhase,
    SquatRepEngine,
    SquatThresholds,
    score_rep,
)

__all__ = [
    "FormAssessment",
    "PoseFrame",
    "RepEvent",
    "RepFeatures",
    "SquatPhase",
    "SquatRepEngine",
    "SquatThresholds",
    "score_rep",
]
