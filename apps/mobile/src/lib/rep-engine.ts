/**
 * A deterministic, device-side squat engine.
 *
 * The API accepts the feature packet this engine produces, but counting and
 * immediate feedback intentionally live on device. A slow network connection
 * should never make a lifter wait to learn whether a rep counted.
 */

export type SquatPhase = "standing" | "descending" | "bottom" | "ascending";

export type FormLabel =
  | "low_confidence"
  | "knee_valgus"
  | "excessive_torso_lean"
  | "shallow_depth"
  | "rushed_eccentric"
  | "rushed_concentric"
  | "slow_tempo"
  | "excellent"
  | "good";

export interface PoseFrame {
  /** Monotonic device timestamp, expressed in milliseconds. */
  timestampMs: number;
  /** Hip-knee-ankle angle. Standing is near 180°, depth reduces it. */
  kneeAngle: number;
  /** Absolute/signed torso deviation from neutral, in degrees. */
  torsoLean: number;
  /** Absolute/signed inward knee drift, in degrees. */
  kneeValgus: number;
  /** Lowest landmark quality used to make this observation, 0 through 1. */
  confidence: number;
}

export interface SquatRepFeatures {
  minimumKneeAngle: number;
  maximumTorsoLean: number;
  maximumKneeValgus: number;
  eccentricDurationMs: number;
  concentricDurationMs: number;
  landmarkConfidence: number;
}

export interface FormAssessment {
  score: number;
  label: FormLabel;
  cue: string;
  componentScores: Readonly<Record<string, number>>;
}

export interface RepEvent {
  repNumber: number;
  completedAtMs: number;
  features: SquatRepFeatures;
  assessment: FormAssessment;
}

export interface SquatThresholds {
  descentKneeAngle: number;
  bottomKneeAngle: number;
  ascentKneeAngle: number;
  standingKneeAngle: number;
  minimumTrackingConfidence: number;
  minimumEccentricDurationMs: number;
  minimumConcentricDurationMs: number;
  maximumRepDurationMs: number;
}

export const DEFAULT_SQUAT_THRESHOLDS: Readonly<SquatThresholds> = {
  descentKneeAngle: 150,
  bottomKneeAngle: 105,
  ascentKneeAngle: 125,
  standingKneeAngle: 165,
  minimumTrackingConfidence: 0.45,
  minimumEccentricDurationMs: 200,
  minimumConcentricDurationMs: 200,
  maximumRepDurationMs: 10_000,
};

const phaseCues: Record<SquatPhase, string> = {
  standing: "Stand tall. Find your balance, then begin when ready.",
  descending: "Lower with control. Keep your knees tracking over your toes.",
  bottom: "Great depth. Brace your core and drive through mid-foot.",
  ascending: "Stay tall as you stand. Finish with a smooth lockout.",
};

function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value);
}

function clampScore(value: number): number {
  // Python's backend uses `int(round(value))`, whose exact .5 ties round to
  // even. Match that behavior so a client-side instant score does not drift by
  // one point when the API persists the same feature packet.
  const lower = Math.floor(value);
  const fraction = value - lower;
  const rounded = Math.abs(fraction - 0.5) < Number.EPSILON ? (lower % 2 === 0 ? lower : lower + 1) : Math.round(value);
  return Math.max(0, Math.min(100, rounded));
}

function depthScore(minimumKneeAngle: number): number {
  if (minimumKneeAngle <= 100) return 100;
  if (minimumKneeAngle <= 120) return clampScore(100 - (minimumKneeAngle - 100) * 3);
  return clampScore(40 - (minimumKneeAngle - 120) * 1.5);
}

function kneeTrackingScore(maximumKneeValgus: number): number {
  if (maximumKneeValgus <= 4) return 100;
  if (maximumKneeValgus <= 8) return clampScore(100 - (maximumKneeValgus - 4) * 8);
  return clampScore(68 - (maximumKneeValgus - 8) * 7);
}

function torsoPositionScore(maximumTorsoLean: number): number {
  if (maximumTorsoLean <= 20) return 100;
  if (maximumTorsoLean <= 35) return clampScore(100 - (maximumTorsoLean - 20) * 3);
  return clampScore(55 - (maximumTorsoLean - 35) * 2);
}

function phaseTempoScore(durationMs: number): number {
  if (durationMs < 350) return clampScore((35 * durationMs) / 350);
  if (durationMs < 600) return clampScore(35 + ((durationMs - 350) * 65) / 250);
  if (durationMs <= 2_500) return 100;
  if (durationMs <= 4_000) return clampScore(100 - ((durationMs - 2_500) * 20) / 1_500);
  return clampScore(80 - ((durationMs - 4_000) * 30) / 2_000);
}

function confidenceScore(landmarkConfidence: number): number {
  if (landmarkConfidence >= 0.9) return 100;
  if (landmarkConfidence >= 0.75) {
    return clampScore(80 + ((landmarkConfidence - 0.75) * 20) / 0.15);
  }
  if (landmarkConfidence >= 0.5) {
    return clampScore(40 + ((landmarkConfidence - 0.5) * 40) / 0.25);
  }
  return clampScore(landmarkConfidence * 80);
}

/** Mirrors the explainable scoring rules in `backend/app/domain/rep_engine.py`. */
export function scoreSquatRep(features: SquatRepFeatures): FormAssessment {
  const depth = depthScore(features.minimumKneeAngle);
  const kneeTracking = kneeTrackingScore(Math.abs(features.maximumKneeValgus));
  const torsoPosition = torsoPositionScore(Math.abs(features.maximumTorsoLean));
  const tempo = clampScore(
    (phaseTempoScore(features.eccentricDurationMs) + phaseTempoScore(features.concentricDurationMs)) /
      2,
  );
  const confidence = confidenceScore(features.landmarkConfidence);
  const componentScores = {
    depth,
    knee_tracking: kneeTracking,
    torso_position: torsoPosition,
    tempo,
    landmark_confidence: confidence,
  };
  const score = clampScore(
    depth * 0.35 + kneeTracking * 0.25 + torsoPosition * 0.2 + tempo * 0.1 + confidence * 0.1,
  );

  if (features.landmarkConfidence < 0.55) {
    return {
      score,
      label: "low_confidence",
      cue: `Improve camera framing before the next rep; landmark confidence was ${Math.round(
        features.landmarkConfidence * 100,
      )}% (target at least 70%).`,
      componentScores,
    };
  }
  if (Math.abs(features.maximumKneeValgus) > 8) {
    return {
      score,
      label: "knee_valgus",
      cue: `Keep your knees tracking over your toes; inward drift peaked at ${Math.abs(
        features.maximumKneeValgus,
      ).toFixed(1)}° (target 8° or less).`,
      componentScores,
    };
  }
  if (Math.abs(features.maximumTorsoLean) > 35) {
    return {
      score,
      label: "excessive_torso_lean",
      cue: `Keep your chest tall through the rep; torso lean peaked at ${Math.abs(
        features.maximumTorsoLean,
      ).toFixed(1)}° (target 35° or less).`,
      componentScores,
    };
  }
  if (features.minimumKneeAngle > 120) {
    return {
      score,
      label: "shallow_depth",
      cue: `Squat deeper; minimum knee angle was ${features.minimumKneeAngle.toFixed(
        1,
      )}° (target 105° or less).`,
      componentScores,
    };
  }
  if (features.eccentricDurationMs < 500) {
    return {
      score,
      label: "rushed_eccentric",
      cue: `Control the lowering phase; eccentric time was ${features.eccentricDurationMs} ms (target at least 500 ms).`,
      componentScores,
    };
  }
  if (features.concentricDurationMs < 500) {
    return {
      score,
      label: "rushed_concentric",
      cue: `Control the ascent; concentric time was ${features.concentricDurationMs} ms (target at least 500 ms).`,
      componentScores,
    };
  }
  if (features.eccentricDurationMs > 4_000 || features.concentricDurationMs > 4_000) {
    return {
      score,
      label: "slow_tempo",
      cue: "Keep a steady tempo; aim for each phase to finish within about 4 seconds.",
      componentScores,
    };
  }
  if (score >= 92) {
    return {
      score,
      label: "excellent",
      cue: "Strong, controlled rep: depth, alignment, torso position, tempo, and tracking all met target.",
      componentScores,
    };
  }

  const weakestComponent = Object.entries(componentScores).reduce((weakest, current) =>
    current[1] < weakest[1] ? current : weakest,
  );
  return {
    score,
    label: "good",
    cue: `Solid rep. Refine ${weakestComponent[0].replace("_", " ")} (${weakestComponent[1]}/100) on the next one.`,
    componentScores,
  };
}

/** Turns a normalized frame stream into auditable, completed rep events. */
export class SquatRepEngine {
  public repCount = 0;
  public phase: SquatPhase = "standing";

  private lastTimestampMs: number | null = null;
  private repStartedAtMs: number | null = null;
  private bottomReachedAtMs: number | null = null;
  private ascentStartedAtMs: number | null = null;
  private minimumKneeAngle: number | null = null;
  private maximumTorsoLean = 0;
  private maximumKneeValgus = 0;
  private minimumConfidence: number | null = null;

  public constructor(public readonly thresholds: SquatThresholds = DEFAULT_SQUAT_THRESHOLDS) {
    this.validateThresholds(thresholds);
  }

  public get isTrackingRep(): boolean {
    return this.phase !== "standing";
  }

  public reset(): void {
    this.repCount = 0;
    this.phase = "standing";
    this.lastTimestampMs = null;
    this.clearActiveRep();
  }

  public update(frame: PoseFrame): RepEvent | null {
    this.validateFrame(frame);
    if (this.lastTimestampMs !== null && frame.timestampMs < this.lastTimestampMs) {
      throw new Error("Pose frames must be chronologically ordered.");
    }
    this.lastTimestampMs = frame.timestampMs;

    if (
      this.repStartedAtMs !== null &&
      frame.timestampMs - this.repStartedAtMs > this.thresholds.maximumRepDurationMs
    ) {
      this.phase = "standing";
      this.clearActiveRep();
    }

    if (this.phase !== "standing") this.recordFrame(frame);
    if (frame.confidence < this.thresholds.minimumTrackingConfidence) return null;

    if (this.phase === "standing") {
      if (frame.kneeAngle <= this.thresholds.descentKneeAngle) {
        this.startDescent(frame);
        if (frame.kneeAngle <= this.thresholds.bottomKneeAngle) {
          this.phase = "bottom";
          this.bottomReachedAtMs = frame.timestampMs;
        }
      }
      return null;
    }

    if (this.phase === "descending") {
      if (frame.kneeAngle <= this.thresholds.bottomKneeAngle) {
        this.phase = "bottom";
        this.bottomReachedAtMs = frame.timestampMs;
      } else if (frame.kneeAngle >= this.thresholds.standingKneeAngle) {
        this.phase = "standing";
        this.clearActiveRep();
      }
      return null;
    }

    if (this.phase === "bottom") {
      if (frame.kneeAngle >= this.thresholds.ascentKneeAngle) {
        this.phase = "ascending";
        this.ascentStartedAtMs = frame.timestampMs;
        if (frame.kneeAngle >= this.thresholds.standingKneeAngle) {
          this.ascentStartedAtMs = this.bottomReachedAtMs;
          return this.completeRep(frame.timestampMs);
        }
      }
      return null;
    }

    if (frame.kneeAngle <= this.thresholds.bottomKneeAngle) {
      this.phase = "bottom";
      this.ascentStartedAtMs = null;
      return null;
    }
    if (frame.kneeAngle >= this.thresholds.standingKneeAngle) return this.completeRep(frame.timestampMs);
    return null;
  }

  private completeRep(completedAtMs: number): RepEvent | null {
    if (
      this.repStartedAtMs === null ||
      this.bottomReachedAtMs === null ||
      this.ascentStartedAtMs === null ||
      this.minimumKneeAngle === null ||
      this.minimumConfidence === null
    ) {
      this.phase = "standing";
      this.clearActiveRep();
      return null;
    }

    const eccentricDurationMs = this.bottomReachedAtMs - this.repStartedAtMs;
    const concentricDurationMs = completedAtMs - this.ascentStartedAtMs;
    if (
      eccentricDurationMs < this.thresholds.minimumEccentricDurationMs ||
      concentricDurationMs < this.thresholds.minimumConcentricDurationMs
    ) {
      this.phase = "standing";
      this.clearActiveRep();
      return null;
    }

    const features: SquatRepFeatures = {
      minimumKneeAngle: this.minimumKneeAngle,
      maximumTorsoLean: this.maximumTorsoLean,
      maximumKneeValgus: this.maximumKneeValgus,
      eccentricDurationMs,
      concentricDurationMs,
      landmarkConfidence: this.minimumConfidence,
    };
    this.repCount += 1;
    const event: RepEvent = {
      repNumber: this.repCount,
      completedAtMs,
      features,
      assessment: scoreSquatRep(features),
    };
    this.phase = "standing";
    this.clearActiveRep();
    return event;
  }

  private startDescent(frame: PoseFrame): void {
    this.clearActiveRep();
    this.phase = "descending";
    this.repStartedAtMs = frame.timestampMs;
    this.recordFrame(frame);
  }

  private recordFrame(frame: PoseFrame): void {
    this.minimumKneeAngle =
      this.minimumKneeAngle === null ? frame.kneeAngle : Math.min(this.minimumKneeAngle, frame.kneeAngle);
    this.maximumTorsoLean = Math.max(this.maximumTorsoLean, Math.abs(frame.torsoLean));
    this.maximumKneeValgus = Math.max(this.maximumKneeValgus, Math.abs(frame.kneeValgus));
    this.minimumConfidence =
      this.minimumConfidence === null ? frame.confidence : Math.min(this.minimumConfidence, frame.confidence);
  }

  private clearActiveRep(): void {
    this.repStartedAtMs = null;
    this.bottomReachedAtMs = null;
    this.ascentStartedAtMs = null;
    this.minimumKneeAngle = null;
    this.maximumTorsoLean = 0;
    this.maximumKneeValgus = 0;
    this.minimumConfidence = null;
  }

  private validateFrame(frame: PoseFrame): void {
    const values = [frame.timestampMs, frame.kneeAngle, frame.torsoLean, frame.kneeValgus, frame.confidence];
    if (!values.every(isFiniteNumber)) throw new Error("Pose frames must contain finite numeric values.");
    if (frame.timestampMs < 0) throw new Error("Pose frame timestamps must be non-negative.");
    if (frame.kneeAngle < 0) throw new Error("Knee angle must be non-negative.");
    if (frame.confidence < 0 || frame.confidence > 1) {
      throw new Error("Pose confidence must be between zero and one.");
    }
  }

  private validateThresholds(thresholds: SquatThresholds): void {
    if (
      !(
        thresholds.bottomKneeAngle < thresholds.ascentKneeAngle &&
        thresholds.ascentKneeAngle < thresholds.descentKneeAngle &&
        thresholds.descentKneeAngle < thresholds.standingKneeAngle
      )
    ) {
      throw new Error("Squat knee-angle thresholds must be strictly ordered.");
    }
  }
}

export function cueForPhase(phase: SquatPhase): string {
  return phaseCues[phase];
}
