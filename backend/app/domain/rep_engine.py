"""Deterministic, dependency-free squat repetition analysis.

This module deliberately owns only the small, explainable part of pose
analysis.  A camera or MediaPipe adapter turns landmarks into :class:`PoseFrame`
objects, and the :class:`SquatRepEngine` turns that ordered stream into one
completed-rep event at a time.  Model-backed classification can be layered on
top of the resulting ``RepFeatures`` without changing the counting contract.

Angles are expressed in degrees:

* ``knee_angle`` is the hip-knee-ankle angle, where a straight standing leg is
  roughly 180 degrees and a deeper squat has a smaller value.
* ``torso_lean`` and ``knee_valgus`` are signed or unsigned deviations from a
  neutral alignment.  The engine uses their absolute magnitude so either
  camera orientation is handled consistently.

The state machine uses hysteresis (separate descent, bottom, ascent and
standing thresholds) and minimum phase durations.  That makes a completed
event an auditable fact rather than a side effect of a single noisy frame.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from enum import StrEnum
from math import isfinite


class SquatPhase(StrEnum):
    """The lifecycle of one squat attempt."""

    STANDING = "standing"
    DESCENDING = "descending"
    BOTTOM = "bottom"
    ASCENDING = "ascending"


@dataclass(frozen=True, slots=True)
class PoseFrame:
    """A normalized pose observation for a single instant.

    ``timestamp_ms`` must be non-negative and frames passed to an engine must
    be chronologically ordered.  ``confidence`` is a normalized landmark
    confidence in ``[0, 1]``.  The frame stays intentionally compact so it is
    safe to transmit or persist without raw video.
    """

    timestamp_ms: int
    knee_angle: float
    torso_lean: float
    knee_valgus: float
    confidence: float

    def __post_init__(self) -> None:
        if isinstance(self.timestamp_ms, bool) or not isinstance(self.timestamp_ms, int):
            raise TypeError("timestamp_ms must be an integer number of milliseconds")
        if self.timestamp_ms < 0:
            raise ValueError("timestamp_ms must be non-negative")

        for name, value in (
            ("knee_angle", self.knee_angle),
            ("torso_lean", self.torso_lean),
            ("knee_valgus", self.knee_valgus),
            ("confidence", self.confidence),
        ):
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise TypeError(f"{name} must be a finite number")
            if not isfinite(value):
                raise ValueError(f"{name} must be finite")

        if self.knee_angle < 0:
            raise ValueError("knee_angle cannot be negative")
        if not 0.0 <= self.confidence <= 1.0:
            raise ValueError("confidence must be between 0 and 1")


@dataclass(frozen=True, slots=True)
class RepFeatures:
    """A compact, explainable feature packet captured for one completed rep.

    ``landmark_confidence`` is the *minimum* confidence seen while the rep was
    active.  A confidence floor is more useful for safety and auditing than an
    average that might hide a briefly lost subject.
    """

    minimum_knee_angle: float
    maximum_torso_lean: float
    maximum_knee_valgus: float
    eccentric_duration_ms: int
    concentric_duration_ms: int
    landmark_confidence: float

    def __post_init__(self) -> None:
        for name, value in (
            ("minimum_knee_angle", self.minimum_knee_angle),
            ("maximum_torso_lean", self.maximum_torso_lean),
            ("maximum_knee_valgus", self.maximum_knee_valgus),
            ("landmark_confidence", self.landmark_confidence),
        ):
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise TypeError(f"{name} must be a finite number")
            if not isfinite(value):
                raise ValueError(f"{name} must be finite")

        if self.minimum_knee_angle < 0:
            raise ValueError("minimum_knee_angle cannot be negative")
        if self.maximum_torso_lean < 0 or self.maximum_knee_valgus < 0:
            raise ValueError("maximum deviation features cannot be negative")
        if not 0.0 <= self.landmark_confidence <= 1.0:
            raise ValueError("landmark_confidence must be between 0 and 1")

        for name, value in (
            ("eccentric_duration_ms", self.eccentric_duration_ms),
            ("concentric_duration_ms", self.concentric_duration_ms),
        ):
            if isinstance(value, bool) or not isinstance(value, int):
                raise TypeError(f"{name} must be an integer number of milliseconds")
            if value < 0:
                raise ValueError(f"{name} cannot be negative")


@dataclass(frozen=True, slots=True)
class FormAssessment:
    """An explainable score and the one most useful next coaching cue.

    ``component_scores`` contains five integer scores in the ``0..100`` range:
    ``depth``, ``knee_tracking``, ``torso_position``, ``tempo``, and
    ``landmark_confidence``.  Keeping those components alongside a top-level
    score makes the rule-based decision inspectable by an API or UI.
    """

    score: int
    label: str
    cue: str
    component_scores: Mapping[str, int]

    def __post_init__(self) -> None:
        if isinstance(self.score, bool) or not isinstance(self.score, int):
            raise TypeError("score must be an integer")
        if not 0 <= self.score <= 100:
            raise ValueError("score must be between 0 and 100")
        if not self.label:
            raise ValueError("label cannot be empty")
        if not self.cue:
            raise ValueError("cue cannot be empty")
        for name, component_score in self.component_scores.items():
            if isinstance(component_score, bool) or not isinstance(component_score, int):
                raise TypeError(f"component score {name!r} must be an integer")
            if not 0 <= component_score <= 100:
                raise ValueError(f"component score {name!r} must be between 0 and 100")


@dataclass(frozen=True, slots=True)
class RepEvent:
    """The single event emitted when a full, valid squat cycle completes."""

    rep_number: int
    completed_at_ms: int
    features: RepFeatures
    assessment: FormAssessment

    @property
    def rep_index(self) -> int:
        """One-based alias retained for consumers that call this an index."""

        return self.rep_number


@dataclass(frozen=True, slots=True)
class SquatThresholds:
    """Calibratable guardrails for the squat state machine.

    Defaults suit a frontal or three-quarter view with a knee angle measured as
    hip-knee-ankle.  They are intentionally exposed for exercise calibration
    and fixture replay, rather than being unexplained magic numbers.
    """

    descent_knee_angle: float = 150.0
    bottom_knee_angle: float = 105.0
    ascent_knee_angle: float = 125.0
    standing_knee_angle: float = 165.0
    minimum_tracking_confidence: float = 0.45
    minimum_eccentric_duration_ms: int = 200
    minimum_concentric_duration_ms: int = 200
    maximum_rep_duration_ms: int = 10_000

    def __post_init__(self) -> None:
        for name, value in (
            ("descent_knee_angle", self.descent_knee_angle),
            ("bottom_knee_angle", self.bottom_knee_angle),
            ("ascent_knee_angle", self.ascent_knee_angle),
            ("standing_knee_angle", self.standing_knee_angle),
            ("minimum_tracking_confidence", self.minimum_tracking_confidence),
        ):
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise TypeError(f"{name} must be a finite number")
            if not isfinite(value):
                raise ValueError(f"{name} must be finite")

        if not (
            0
            < self.bottom_knee_angle
            < self.ascent_knee_angle
            < self.descent_knee_angle
            < self.standing_knee_angle
        ):
            raise ValueError(
                "knee-angle thresholds must satisfy bottom < ascent < descent < standing"
            )
        if not 0.0 <= self.minimum_tracking_confidence <= 1.0:
            raise ValueError("minimum_tracking_confidence must be between 0 and 1")
        for name, value in (
            ("minimum_eccentric_duration_ms", self.minimum_eccentric_duration_ms),
            ("minimum_concentric_duration_ms", self.minimum_concentric_duration_ms),
            ("maximum_rep_duration_ms", self.maximum_rep_duration_ms),
        ):
            if isinstance(value, bool) or not isinstance(value, int):
                raise TypeError(f"{name} must be an integer number of milliseconds")
            if value < 0:
                raise ValueError(f"{name} cannot be negative")
        if self.maximum_rep_duration_ms == 0:
            raise ValueError("maximum_rep_duration_ms must be positive")


def _clamp_score(value: float) -> int:
    """Round and bound a component score without relying on a model runtime."""

    return max(0, min(100, int(round(value))))


def _depth_score(minimum_knee_angle: float) -> int:
    if minimum_knee_angle <= 100.0:
        return 100
    if minimum_knee_angle <= 120.0:
        return _clamp_score(100.0 - (minimum_knee_angle - 100.0) * 3.0)
    return _clamp_score(40.0 - (minimum_knee_angle - 120.0) * 1.5)


def _knee_tracking_score(maximum_knee_valgus: float) -> int:
    if maximum_knee_valgus <= 4.0:
        return 100
    if maximum_knee_valgus <= 8.0:
        return _clamp_score(100.0 - (maximum_knee_valgus - 4.0) * 8.0)
    return _clamp_score(68.0 - (maximum_knee_valgus - 8.0) * 7.0)


def _torso_position_score(maximum_torso_lean: float) -> int:
    if maximum_torso_lean <= 20.0:
        return 100
    if maximum_torso_lean <= 35.0:
        return _clamp_score(100.0 - (maximum_torso_lean - 20.0) * 3.0)
    return _clamp_score(55.0 - (maximum_torso_lean - 35.0) * 2.0)


def _single_phase_tempo_score(duration_ms: int) -> int:
    """Score one movement phase; controlled is preferred over merely fast."""

    if duration_ms < 350:
        return _clamp_score(35.0 * duration_ms / 350.0)
    if duration_ms < 600:
        return _clamp_score(35.0 + (duration_ms - 350) * 65.0 / 250.0)
    if duration_ms <= 2_500:
        return 100
    if duration_ms <= 4_000:
        return _clamp_score(100.0 - (duration_ms - 2_500) * 20.0 / 1_500.0)
    return _clamp_score(80.0 - (duration_ms - 4_000) * 30.0 / 2_000.0)


def _tempo_score(eccentric_duration_ms: int, concentric_duration_ms: int) -> int:
    return _clamp_score(
        (
            _single_phase_tempo_score(eccentric_duration_ms)
            + _single_phase_tempo_score(concentric_duration_ms)
        )
        / 2
    )


def _confidence_score(landmark_confidence: float) -> int:
    if landmark_confidence >= 0.9:
        return 100
    if landmark_confidence >= 0.75:
        return _clamp_score(80.0 + (landmark_confidence - 0.75) * 20.0 / 0.15)
    if landmark_confidence >= 0.5:
        return _clamp_score(40.0 + (landmark_confidence - 0.5) * 40.0 / 0.25)
    return _clamp_score(landmark_confidence * 80.0)


def score_rep(features: RepFeatures) -> FormAssessment:
    """Return a reproducible form assessment for one completed squat.

    The weighted score deliberately favors movement quality over camera quality:
    depth 35%, knee tracking 25%, torso position 20%, tempo 10%, and landmark
    confidence 10%.  The label and cue prioritize the most actionable
    threshold violation, while ``component_scores`` exposes every reason.

    This is coaching feedback, not medical advice or an injury-risk diagnosis.
    """

    depth = _depth_score(features.minimum_knee_angle)
    knee_tracking = _knee_tracking_score(abs(features.maximum_knee_valgus))
    torso_position = _torso_position_score(abs(features.maximum_torso_lean))
    tempo = _tempo_score(features.eccentric_duration_ms, features.concentric_duration_ms)
    confidence = _confidence_score(features.landmark_confidence)
    component_scores = {
        "depth": depth,
        "knee_tracking": knee_tracking,
        "torso_position": torso_position,
        "tempo": tempo,
        "landmark_confidence": confidence,
    }
    score = _clamp_score(
        depth * 0.35
        + knee_tracking * 0.25
        + torso_position * 0.20
        + tempo * 0.10
        + confidence * 0.10
    )

    # The priority order favors signals that make the observation itself less
    # trustworthy, then alignment, then depth/tempo.  Each cue includes the
    # measured value and its target so a consumer never has to infer why it was
    # selected.
    if features.landmark_confidence < 0.55:
        label = "low_confidence"
        cue = (
            "Improve camera framing before the next rep; landmark confidence "
            f"was {features.landmark_confidence:.0%} (target at least 70%)."
        )
    elif abs(features.maximum_knee_valgus) > 8.0:
        label = "knee_valgus"
        cue = (
            "Keep your knees tracking over your toes; inward drift peaked at "
            f"{abs(features.maximum_knee_valgus):.1f}° (target 8° or less)."
        )
    elif abs(features.maximum_torso_lean) > 35.0:
        label = "excessive_torso_lean"
        cue = (
            "Keep your chest tall through the rep; torso lean peaked at "
            f"{abs(features.maximum_torso_lean):.1f}° (target 35° or less)."
        )
    elif features.minimum_knee_angle > 120.0:
        label = "shallow_depth"
        cue = (
            "Squat deeper; minimum knee angle was "
            f"{features.minimum_knee_angle:.1f}° (target 105° or less)."
        )
    elif features.eccentric_duration_ms < 500:
        label = "rushed_eccentric"
        cue = (
            "Control the lowering phase; eccentric time was "
            f"{features.eccentric_duration_ms} ms (target at least 500 ms)."
        )
    elif features.concentric_duration_ms < 500:
        label = "rushed_concentric"
        cue = (
            "Control the ascent; concentric time was "
            f"{features.concentric_duration_ms} ms (target at least 500 ms)."
        )
    elif features.eccentric_duration_ms > 4_000 or features.concentric_duration_ms > 4_000:
        label = "slow_tempo"
        cue = "Keep a steady tempo; aim for each phase to finish within about 4 seconds."
    elif score >= 92:
        label = "excellent"
        cue = (
            "Strong, controlled rep: depth, alignment, torso position, tempo, "
            "and tracking all met target."
        )
    else:
        weakest_component = min(component_scores, key=component_scores.__getitem__)
        label = "good"
        cue = (
            f"Solid rep. Refine {weakest_component.replace('_', ' ')} "
            f"({component_scores[weakest_component]}/100) on the next one."
        )

    return FormAssessment(
        score=score,
        label=label,
        cue=cue,
        component_scores=component_scores,
    )


class SquatRepEngine:
    """Count high-confidence squat cycles and emit scored :class:`RepEvent`s.

    A valid cycle is ``standing -> descending -> bottom -> ascending ->
    standing``.  Frames below ``minimum_tracking_confidence`` cannot advance
    the phase, but are still recorded during an active rep so the completed
    event accurately communicates a weak camera observation.

    The engine has no global state, model dependency, or clock access: feeding
    the same frames always produces exactly the same events.
    """

    def __init__(self, thresholds: SquatThresholds | None = None) -> None:
        self.thresholds = thresholds or SquatThresholds()
        self.rep_count = 0
        self._last_timestamp_ms: int | None = None
        self._phase = SquatPhase.STANDING
        self._clear_active_rep()

    @property
    def phase(self) -> SquatPhase:
        """Current phase, useful for immediate UI guidance."""

        return self._phase

    @property
    def is_tracking_rep(self) -> bool:
        """Whether a descent has begun and has not yet been abandoned."""

        return self._phase is not SquatPhase.STANDING

    def reset(self) -> None:
        """Discard current state and restart the counter for a new set."""

        self.rep_count = 0
        self._last_timestamp_ms = None
        self._phase = SquatPhase.STANDING
        self._clear_active_rep()

    def update(self, frame: PoseFrame) -> RepEvent | None:
        """Consume one pose frame and return an event only on completed reps.

        A chronologically older frame is rejected rather than silently changing
        durations.  Equal timestamps are allowed (they simply contribute zero
        elapsed time), which is useful when a provider batches landmarks.
        """

        if self._last_timestamp_ms is not None and frame.timestamp_ms < self._last_timestamp_ms:
            raise ValueError("PoseFrame timestamps must be non-decreasing")
        self._last_timestamp_ms = frame.timestamp_ms

        if (
            self._rep_started_at_ms is not None
            and frame.timestamp_ms - self._rep_started_at_ms
            > self.thresholds.maximum_rep_duration_ms
        ):
            self._phase = SquatPhase.STANDING
            self._clear_active_rep()

        # An in-progress rep retains the lowest confidence and extremes from
        # every received frame, even one too uncertain to move the state.
        if self._phase is not SquatPhase.STANDING:
            self._record_frame(frame)

        if frame.confidence < self.thresholds.minimum_tracking_confidence:
            return None

        if self._phase is SquatPhase.STANDING:
            if frame.knee_angle <= self.thresholds.descent_knee_angle:
                self._start_descent(frame)
                # If a camera skipped the descent frame, acknowledge bottom but
                # leave duration validation to completion.
                if frame.knee_angle <= self.thresholds.bottom_knee_angle:
                    self._phase = SquatPhase.BOTTOM
                    self._bottom_reached_at_ms = frame.timestamp_ms
            return None

        if self._phase is SquatPhase.DESCENDING:
            if frame.knee_angle <= self.thresholds.bottom_knee_angle:
                self._phase = SquatPhase.BOTTOM
                self._bottom_reached_at_ms = frame.timestamp_ms
            elif frame.knee_angle >= self.thresholds.standing_knee_angle:
                # A partial squat returned to standing before reaching depth.
                self._phase = SquatPhase.STANDING
                self._clear_active_rep()
            return None

        if self._phase is SquatPhase.BOTTOM:
            if frame.knee_angle >= self.thresholds.ascent_knee_angle:
                self._phase = SquatPhase.ASCENDING
                self._ascent_started_at_ms = frame.timestamp_ms
                if frame.knee_angle >= self.thresholds.standing_knee_angle:
                    # Dropped camera frames can jump directly from bottom to
                    # standing.  Use bottom as the conservative ascent start.
                    self._ascent_started_at_ms = self._bottom_reached_at_ms
                    return self._complete_rep(frame.timestamp_ms)
            return None

        # ASCENDING
        if frame.knee_angle <= self.thresholds.bottom_knee_angle:
            # The lifter settled back into the bottom; wait for a new ascent.
            self._phase = SquatPhase.BOTTOM
            self._ascent_started_at_ms = None
            return None
        if frame.knee_angle >= self.thresholds.standing_knee_angle:
            return self._complete_rep(frame.timestamp_ms)
        return None

    def _clear_active_rep(self) -> None:
        self._rep_started_at_ms: int | None = None
        self._bottom_reached_at_ms: int | None = None
        self._ascent_started_at_ms: int | None = None
        self._minimum_knee_angle: float | None = None
        self._maximum_torso_lean = 0.0
        self._maximum_knee_valgus = 0.0
        self._minimum_confidence: float | None = None

    def _start_descent(self, frame: PoseFrame) -> None:
        self._clear_active_rep()
        self._phase = SquatPhase.DESCENDING
        self._rep_started_at_ms = frame.timestamp_ms
        self._record_frame(frame)

    def _record_frame(self, frame: PoseFrame) -> None:
        if self._minimum_knee_angle is None:
            self._minimum_knee_angle = frame.knee_angle
        else:
            self._minimum_knee_angle = min(self._minimum_knee_angle, frame.knee_angle)
        self._maximum_torso_lean = max(self._maximum_torso_lean, abs(frame.torso_lean))
        self._maximum_knee_valgus = max(self._maximum_knee_valgus, abs(frame.knee_valgus))
        if self._minimum_confidence is None:
            self._minimum_confidence = frame.confidence
        else:
            self._minimum_confidence = min(self._minimum_confidence, frame.confidence)

    def _complete_rep(self, completed_at_ms: int) -> RepEvent | None:
        if (
            self._rep_started_at_ms is None
            or self._bottom_reached_at_ms is None
            or self._ascent_started_at_ms is None
            or self._minimum_knee_angle is None
            or self._minimum_confidence is None
        ):
            # Defensive fallback: a future modification cannot manufacture an
            # event from a half-populated state.
            self._phase = SquatPhase.STANDING
            self._clear_active_rep()
            return None

        eccentric_duration_ms = self._bottom_reached_at_ms - self._rep_started_at_ms
        concentric_duration_ms = completed_at_ms - self._ascent_started_at_ms
        if (
            eccentric_duration_ms < self.thresholds.minimum_eccentric_duration_ms
            or concentric_duration_ms < self.thresholds.minimum_concentric_duration_ms
        ):
            self._phase = SquatPhase.STANDING
            self._clear_active_rep()
            return None

        features = RepFeatures(
            minimum_knee_angle=self._minimum_knee_angle,
            maximum_torso_lean=self._maximum_torso_lean,
            maximum_knee_valgus=self._maximum_knee_valgus,
            eccentric_duration_ms=eccentric_duration_ms,
            concentric_duration_ms=concentric_duration_ms,
            landmark_confidence=self._minimum_confidence,
        )
        assessment = score_rep(features)
        self.rep_count += 1
        event = RepEvent(
            rep_number=self.rep_count,
            completed_at_ms=completed_at_ms,
            features=features,
            assessment=assessment,
        )
        self._phase = SquatPhase.STANDING
        self._clear_active_rep()
        return event
