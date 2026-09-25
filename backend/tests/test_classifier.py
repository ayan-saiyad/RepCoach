"""Classifier contracts that work with the lightweight no-torch development install."""

from app.domain import RepFeatures
from worker.classifier import PyTorchFormClassifier, normalize_features


def test_feature_normalization_has_a_stable_training_order() -> None:
    features = RepFeatures(
        minimum_knee_angle=90,
        maximum_torso_lean=18,
        maximum_knee_valgus=3,
        eccentric_duration_ms=900,
        concentric_duration_ms=700,
        landmark_confidence=0.95,
    )

    assert normalize_features(features) == [0.5, 0.2, 0.05, 0.18, 0.14, 0.95]


def test_classifier_has_an_explainable_fallback_without_an_artifact() -> None:
    prediction = PyTorchFormClassifier().predict(
        RepFeatures(
            minimum_knee_angle=130,
            maximum_torso_lean=18,
            maximum_knee_valgus=3,
            eccentric_duration_ms=800,
            concentric_duration_ms=800,
            landmark_confidence=0.96,
        )
    )

    assert prediction.source == "rule-engine"
    assert prediction.model_version == "rules-v1"
    assert prediction.assessment.label == "shallow_depth"
    assert prediction.confidence is None
