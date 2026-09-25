"""Train a small PyTorch form-classification baseline from synthetic fixtures.

This script demonstrates the full artifact contract used by the worker without
claiming a synthetic set is production training data. Replace the generator
with consented, labeled landmark sequences before deploying a model.
"""

from __future__ import annotations

import argparse
import random
from pathlib import Path

from app.domain import RepFeatures
from worker.classifier import MODEL_LABELS, FormQualityNet, normalize_features


def make_example(label: str, rng: random.Random) -> RepFeatures:
    """Generate a separated prototype sample for pipeline and model tests."""

    if label == "good":
        values = (rng.uniform(85, 102), rng.uniform(8, 22), rng.uniform(1, 6), 800, 800)
    elif label == "shallow_depth":
        values = (rng.uniform(123, 145), rng.uniform(10, 25), rng.uniform(1, 7), 800, 800)
    elif label == "knee_valgus":
        values = (rng.uniform(86, 103), rng.uniform(10, 25), rng.uniform(10, 22), 800, 800)
    elif label == "excessive_torso_lean":
        values = (rng.uniform(86, 103), rng.uniform(38, 60), rng.uniform(1, 7), 800, 800)
    else:  # rushed_rep
        values = (rng.uniform(86, 103), rng.uniform(10, 25), rng.uniform(1, 7), 250, 300)
    return RepFeatures(
        minimum_knee_angle=values[0],
        maximum_torso_lean=values[1],
        maximum_knee_valgus=values[2],
        eccentric_duration_ms=values[3] + rng.randint(-80, 80),
        concentric_duration_ms=values[4] + rng.randint(-80, 80),
        landmark_confidence=rng.uniform(0.82, 0.99),
    )


def train(output: Path, examples_per_label: int, epochs: int, seed: int) -> None:
    try:
        import torch
        from torch import nn
    except ImportError as error:  # pragma: no cover - requires optional ML install.
        raise SystemExit("Install the ml extra first: pip install -e '.[ml]'") from error
    if FormQualityNet is None:
        raise SystemExit("PyTorch model class is unavailable")

    rng = random.Random(seed)
    samples = [
        (normalize_features(make_example(label, rng)), index)
        for index, label in enumerate(MODEL_LABELS)
        for _ in range(examples_per_label)
    ]
    rng.shuffle(samples)
    features = torch.tensor([sample[0] for sample in samples], dtype=torch.float32)
    labels = torch.tensor([sample[1] for sample in samples], dtype=torch.long)

    torch.manual_seed(seed)
    model = FormQualityNet()
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.003, weight_decay=0.0001)
    loss_function = nn.CrossEntropyLoss()
    model.train()
    for _ in range(epochs):
        optimizer.zero_grad()
        loss = loss_function(model(features), labels)
        loss.backward()
        optimizer.step()

    output.parent.mkdir(parents=True, exist_ok=True)
    torch.save(
        {
            "version": "synthetic-baseline-v1",
            "labels": list(MODEL_LABELS),
            "feature_order": [
                "minimum_knee_angle",
                "maximum_torso_lean",
                "maximum_knee_valgus",
                "eccentric_duration_ms",
                "concentric_duration_ms",
                "landmark_confidence",
            ],
            "model_state_dict": model.eval().state_dict(),
        },
        output,
    )
    print(f"Saved model artifact to {output}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("artifacts/form-quality-v1.pt"))
    parser.add_argument("--examples-per-label", type=int, default=160)
    parser.add_argument("--epochs", type=int, default=180)
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args()
    train(args.output, args.examples_per_label, args.epochs, args.seed)


if __name__ == "__main__":
    main()
