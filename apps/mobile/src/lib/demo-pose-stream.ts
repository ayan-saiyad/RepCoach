import type { PoseFrame } from "./rep-engine";

/**
 * A compact, deterministic fixture used by the app's no-camera demo mode.
 *
 * Each cluster is a complete squat. The first rep is clean, the second exposes
 * knee drift, and the third exposes torso lean. That lets a recruiter or
 * reviewer see both positive reinforcement and specific corrective feedback
 * without needing a real camera or a network connection.
 */

export const DEMO_REP_TARGET = 3;

type FrameShape = Omit<PoseFrame, "timestampMs"> & { offsetMs: number };

const cleanRep: readonly FrameShape[] = [
  { offsetMs: 0, kneeAngle: 174, torsoLean: 8, kneeValgus: 1, confidence: 0.98 },
  { offsetMs: 240, kneeAngle: 158, torsoLean: 10, kneeValgus: 2, confidence: 0.97 },
  { offsetMs: 510, kneeAngle: 145, torsoLean: 13, kneeValgus: 2, confidence: 0.96 },
  { offsetMs: 820, kneeAngle: 121, torsoLean: 16, kneeValgus: 3, confidence: 0.95 },
  { offsetMs: 1_180, kneeAngle: 98, torsoLean: 17, kneeValgus: 3, confidence: 0.94 },
  { offsetMs: 1_500, kneeAngle: 101, torsoLean: 15, kneeValgus: 2, confidence: 0.95 },
  { offsetMs: 1_780, kneeAngle: 128, torsoLean: 13, kneeValgus: 2, confidence: 0.96 },
  { offsetMs: 2_080, kneeAngle: 151, torsoLean: 10, kneeValgus: 1, confidence: 0.97 },
  { offsetMs: 2_410, kneeAngle: 170, torsoLean: 8, kneeValgus: 1, confidence: 0.98 },
];

const kneeTrackingRep: readonly FrameShape[] = [
  { offsetMs: 0, kneeAngle: 173, torsoLean: 10, kneeValgus: 2, confidence: 0.97 },
  { offsetMs: 240, kneeAngle: 157, torsoLean: 12, kneeValgus: 4, confidence: 0.96 },
  { offsetMs: 520, kneeAngle: 146, torsoLean: 15, kneeValgus: 7, confidence: 0.95 },
  { offsetMs: 860, kneeAngle: 122, torsoLean: 18, kneeValgus: 10, confidence: 0.94 },
  { offsetMs: 1_180, kneeAngle: 101, torsoLean: 20, kneeValgus: 11, confidence: 0.93 },
  { offsetMs: 1_510, kneeAngle: 104, torsoLean: 19, kneeValgus: 10, confidence: 0.94 },
  { offsetMs: 1_800, kneeAngle: 129, torsoLean: 16, kneeValgus: 8, confidence: 0.95 },
  { offsetMs: 2_120, kneeAngle: 152, torsoLean: 12, kneeValgus: 5, confidence: 0.96 },
  { offsetMs: 2_450, kneeAngle: 170, torsoLean: 10, kneeValgus: 2, confidence: 0.97 },
];

const torsoPositionRep: readonly FrameShape[] = [
  { offsetMs: 0, kneeAngle: 175, torsoLean: 12, kneeValgus: 2, confidence: 0.98 },
  { offsetMs: 250, kneeAngle: 159, torsoLean: 18, kneeValgus: 3, confidence: 0.97 },
  { offsetMs: 530, kneeAngle: 145, torsoLean: 28, kneeValgus: 4, confidence: 0.96 },
  { offsetMs: 860, kneeAngle: 122, torsoLean: 37, kneeValgus: 5, confidence: 0.95 },
  { offsetMs: 1_190, kneeAngle: 99, torsoLean: 40, kneeValgus: 6, confidence: 0.94 },
  { offsetMs: 1_520, kneeAngle: 104, torsoLean: 38, kneeValgus: 5, confidence: 0.95 },
  { offsetMs: 1_810, kneeAngle: 130, torsoLean: 31, kneeValgus: 4, confidence: 0.96 },
  { offsetMs: 2_120, kneeAngle: 151, torsoLean: 20, kneeValgus: 3, confidence: 0.97 },
  { offsetMs: 2_460, kneeAngle: 170, torsoLean: 12, kneeValgus: 2, confidence: 0.98 },
];

function placeRep(startMs: number, frames: readonly FrameShape[]): PoseFrame[] {
  return frames.map(({ offsetMs, ...frame }) => ({ ...frame, timestampMs: startMs + offsetMs }));
}

export function createDemoSquatReplay(): readonly PoseFrame[] {
  return [
    ...placeRep(0, cleanRep),
    ...placeRep(3_300, kneeTrackingRep),
    ...placeRep(6_650, torsoPositionRep),
  ];
}

/** Scales real movement timestamps into an engaging, short product demo. */
export function replayDelayMs(previous: PoseFrame | undefined, next: PoseFrame): number {
  if (!previous) return 120;
  return Math.max(90, Math.round((next.timestampMs - previous.timestampMs) / 2.7));
}
