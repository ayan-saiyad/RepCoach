"""Focused contract tests for the deterministic squat domain layer."""

from __future__ import annotations

import unittest

from app.domain import PoseFrame, RepFeatures, SquatPhase, SquatRepEngine, score_rep


def frame(
    timestamp_ms: int,
    knee_angle: float,
    *,
    torso_lean: float = 15.0,
    knee_valgus: float = 3.0,
    confidence: float = 0.95,
) -> PoseFrame:
    return PoseFrame(
        timestamp_ms=timestamp_ms,
        knee_angle=knee_angle,
        torso_lean=torso_lean,
        knee_valgus=knee_valgus,
        confidence=confidence,
    )


class SquatRepEngineTests(unittest.TestCase):
    def test_full_squat_emits_one_scored_event_with_auditable_features(self) -> None:
        engine = SquatRepEngine()
        frames = [
            frame(0, 172),
            frame(250, 146, torso_lean=18),
            frame(800, 96, torso_lean=22, knee_valgus=4),
            frame(1_200, 130, torso_lean=19),
            frame(1_800, 169, torso_lean=16),
        ]

        events = [event for pose_frame in frames if (event := engine.update(pose_frame))]

        self.assertEqual(len(events), 1)
        event = events[0]
        self.assertEqual(event.rep_number, 1)
        self.assertEqual(event.rep_index, 1)
        self.assertEqual(event.completed_at_ms, 1_800)
        self.assertEqual(event.features.minimum_knee_angle, 96)
        self.assertEqual(event.features.maximum_torso_lean, 22)
        self.assertEqual(event.features.maximum_knee_valgus, 4)
        self.assertEqual(event.features.eccentric_duration_ms, 550)
        self.assertEqual(event.features.concentric_duration_ms, 600)
        self.assertEqual(event.features.landmark_confidence, 0.95)
        self.assertIn(event.assessment.label, {"excellent", "good"})
        self.assertEqual(engine.phase, SquatPhase.STANDING)
        self.assertEqual(engine.rep_count, 1)

    def test_hysteresis_prevents_a_second_event_from_standing_noise(self) -> None:
        engine = SquatRepEngine()
        sequence = [
            frame(0, 171),
            frame(250, 148),
            frame(700, 94),
            frame(1_000, 128),
            frame(1_450, 168),
            frame(1_600, 163),
            frame(1_750, 166),
            frame(1_900, 160),
        ]

        events = [event for pose_frame in sequence if (event := engine.update(pose_frame))]

        self.assertEqual([event.rep_number for event in events], [1])
        self.assertEqual(engine.rep_count, 1)

    def test_partial_squat_never_reaching_bottom_does_not_count(self) -> None:
        engine = SquatRepEngine()
        sequence = [
            frame(0, 171),
            frame(300, 145),
            frame(700, 116),
            frame(1_100, 145),
            frame(1_400, 169),
        ]

        events = [event for pose_frame in sequence if (event := engine.update(pose_frame))]

        self.assertEqual(events, [])
        self.assertEqual(engine.rep_count, 0)
        self.assertEqual(engine.phase, SquatPhase.STANDING)

    def test_low_confidence_frame_does_not_advance_phase_but_is_preserved(self) -> None:
        engine = SquatRepEngine()
        sequence = [
            frame(0, 171),
            frame(250, 147),
            frame(700, 96),
            # This could have looked like ascent but is too uncertain to move
            # bottom -> ascending.  Its confidence still belongs in the event.
            frame(950, 130, confidence=0.35),
            frame(1_100, 130),
            frame(1_650, 168),
        ]

        events = [event for pose_frame in sequence if (event := engine.update(pose_frame))]

        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].features.landmark_confidence, 0.35)
        self.assertEqual(events[0].assessment.label, "low_confidence")

    def test_out_of_order_timestamps_are_rejected(self) -> None:
        engine = SquatRepEngine()
        engine.update(frame(100, 171))

        with self.assertRaisesRegex(ValueError, "non-decreasing"):
            engine.update(frame(99, 145))

    def test_fast_cycle_is_not_counted(self) -> None:
        engine = SquatRepEngine()
        sequence = [
            frame(0, 171),
            frame(20, 145),
            frame(100, 95),
            frame(150, 130),
            frame(250, 169),
        ]

        events = [event for pose_frame in sequence if (event := engine.update(pose_frame))]

        self.assertEqual(events, [])
        self.assertEqual(engine.rep_count, 0)


class FormScoringTests(unittest.TestCase):
    def test_good_features_are_scored_as_excellent_and_explainable(self) -> None:
        assessment = score_rep(
            RepFeatures(
                minimum_knee_angle=92,
                maximum_torso_lean=17,
                maximum_knee_valgus=3,
                eccentric_duration_ms=900,
                concentric_duration_ms=750,
                landmark_confidence=0.96,
            )
        )

        self.assertGreaterEqual(assessment.score, 92)
        self.assertEqual(assessment.label, "excellent")
        self.assertEqual(
            set(assessment.component_scores),
            {"depth", "knee_tracking", "torso_position", "tempo", "landmark_confidence"},
        )
        self.assertIn("depth", assessment.cue)

    def test_knee_tracking_violation_has_priority_and_measured_cue(self) -> None:
        assessment = score_rep(
            RepFeatures(
                minimum_knee_angle=95,
                maximum_torso_lean=18,
                maximum_knee_valgus=14,
                eccentric_duration_ms=800,
                concentric_duration_ms=800,
                landmark_confidence=0.96,
            )
        )

        self.assertEqual(assessment.label, "knee_valgus")
        self.assertIn("14.0°", assessment.cue)
        self.assertLess(assessment.component_scores["knee_tracking"], 50)

    def test_shallow_depth_and_low_confidence_are_distinguished(self) -> None:
        shallow = score_rep(
            RepFeatures(
                minimum_knee_angle=130,
                maximum_torso_lean=18,
                maximum_knee_valgus=3,
                eccentric_duration_ms=800,
                concentric_duration_ms=800,
                landmark_confidence=0.96,
            )
        )
        uncertain = score_rep(
            RepFeatures(
                minimum_knee_angle=95,
                maximum_torso_lean=18,
                maximum_knee_valgus=3,
                eccentric_duration_ms=800,
                concentric_duration_ms=800,
                landmark_confidence=0.42,
            )
        )

        self.assertEqual(shallow.label, "shallow_depth")
        self.assertIn("130.0°", shallow.cue)
        self.assertEqual(uncertain.label, "low_confidence")
        self.assertIn("42%", uncertain.cue)


if __name__ == "__main__":
    unittest.main()
