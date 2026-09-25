"""Model-backed form scoring with a deterministic, auditable fallback.

The worker never makes a workout unusable just because a model artifact or GPU
is unavailable. The small rule engine remains the stable baseline; a trained
PyTorch network can refine labels when a versioned checkpoint is configured.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.domain import FormAssessment, RepFeatures, score_rep

logger = logging.getLogger(__name__)

try:  # Torch is intentionally an optional extra for local API development.
    import torch
    from torch import Tensor, nn

    TORCH_AVAILABLE = True
except ImportError:  # pragma: no cover - exercised by the default lightweight install.
    torch = None  # type: ignore[assignment]
    Tensor = Any  # type: ignore[misc,assignment]
    nn = None  # type: ignore[assignment]
    TORCH_AVAILABLE = False


MODEL_LABELS = (
    "good",
    "shallow_depth",
    "knee_valgus",
    "excessive_torso_lean",
    "rushed_rep",
)


if TORCH_AVAILABLE:

    class FormQualityNet(nn.Module):  # type: ignore[misc]
        """Compact MLP for normalized, pose-derived rep features."""

        def __init__(self, input_features: int = 6, class_count: int = len(MODEL_LABELS)) -> None:
            super().__init__()
            self.layers = nn.Sequential(
                nn.Linear(input_features, 32),
                nn.ReLU(),
                nn.Dropout(0.10),
                nn.Linear(32, 16),
                nn.ReLU(),
                nn.Linear(16, class_count),
            )

        def forward(self, features: Tensor) -> Tensor:
            return self.layers(features)

else:
    FormQualityNet = None  # type: ignore[assignment,misc]


@dataclass(frozen=True, slots=True)
class ClassifierPrediction:
    """Server-side assessment plus traceability for a model decision."""

    assessment: FormAssessment
    source: str
    model_version: str
    confidence: float | None


def normalize_features(features: RepFeatures) -> list[float]:
    """Normalize raw metrics in exactly the same order used during training."""

    return [
        min(max(features.minimum_knee_angle / 180.0, 0.0), 1.0),
        min(max(features.maximum_torso_lean / 90.0, 0.0), 1.0),
        min(max(features.maximum_knee_valgus / 60.0, 0.0), 1.0),
        min(max(features.eccentric_duration_ms / 5_000.0, 0.0), 1.0),
        min(max(features.concentric_duration_ms / 5_000.0, 0.0), 1.0),
        features.landmark_confidence,
    ]


def _model_cue(label: str, baseline: FormAssessment) -> str:
    cues = {
        "good": "Strong rep. Keep the same controlled depth and alignment.",
        "shallow_depth": "Sit a little lower while keeping your chest tall.",
        "knee_valgus": "Press your knees gently out so they track over your toes.",
        "excessive_torso_lean": "Brace your trunk and keep your chest a little taller.",
        "rushed_rep": "Slow the lowering and ascent so each phase stays controlled.",
    }
    return cues.get(label, baseline.cue)


class PyTorchFormClassifier:
    """Load a versioned checkpoint when available, otherwise use deterministic scoring."""

    def __init__(self, model_path: str | None = None) -> None:
        self._model: Any = None
        self._labels = MODEL_LABELS
        self._version = "rules-v1"
        if model_path:
            self._load(Path(model_path))

    @property
    def is_model_loaded(self) -> bool:
        return self._model is not None

    def _load(self, path: Path) -> None:
        if not TORCH_AVAILABLE:
            logger.warning("PyTorch is unavailable; using deterministic form scorer")
            return
        if not path.is_file():
            logger.warning("form model artifact not found at %s; using deterministic scorer", path)
            return
        try:
            checkpoint = torch.load(path, map_location="cpu", weights_only=True)
            labels = tuple(checkpoint.get("labels", MODEL_LABELS))
            model = FormQualityNet(class_count=len(labels))
            model.load_state_dict(checkpoint["model_state_dict"])
            model.eval()
            self._model = model
            self._labels = labels
            self._version = str(checkpoint.get("version", path.stem))
            logger.info("loaded form classifier version=%s labels=%s", self._version, labels)
        except (KeyError, RuntimeError, OSError, ValueError) as error:
            logger.exception("could not load form classifier %s: %s", path, error)

    def predict(self, features: RepFeatures) -> ClassifierPrediction:
        baseline = score_rep(features)
        if self._model is None or not TORCH_AVAILABLE:
            return ClassifierPrediction(
                assessment=baseline,
                source="rule-engine",
                model_version=self._version,
                confidence=None,
            )

        with torch.no_grad():
            batch = torch.tensor([normalize_features(features)], dtype=torch.float32)
            probabilities = torch.softmax(self._model(batch), dim=1)[0]
            confidence, index = torch.max(probabilities, dim=0)
        label = self._labels[int(index.item())]
        # Preserve the transparent score components even when classification is learned.
        assessment = FormAssessment(
            score=baseline.score,
            label=label,
            cue=_model_cue(label, baseline),
            component_scores=baseline.component_scores,
        )
        return ClassifierPrediction(
            assessment=assessment,
            source="pytorch",
            model_version=self._version,
            confidence=round(float(confidence.item()), 4),
        )
