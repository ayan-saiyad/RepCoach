import type { PoseFrame } from "../lib/rep-engine";

/** A normalized landmark emitted by MediaPipe's pose landmarker. */
export interface PoseLandmark {
  x: number;
  y: number;
  z?: number;
  visibility?: number;
  presence?: number;
}

/** The small landmark subset needed to estimate a bodyweight squat. */
export interface SquatLandmarks {
  leftShoulder: PoseLandmark;
  rightShoulder: PoseLandmark;
  leftHip: PoseLandmark;
  rightHip: PoseLandmark;
  leftKnee: PoseLandmark;
  rightKnee: PoseLandmark;
  leftAnkle: PoseLandmark;
  rightAnkle: PoseLandmark;
}

export interface NativePoseObservation {
  timestampMs: number;
  landmarks: SquatLandmarks;
}

export interface PoseProviderAvailability {
  available: boolean;
  reason?: string;
}

export interface PoseProvider {
  readonly kind: "mediapipe-native" | "demo";
  getAvailability(): Promise<PoseProviderAvailability>;
  start(onFrame: (frame: PoseFrame) => void): Promise<void>;
  stop(): Promise<void>;
}

/**
 * The native shell should implement this bridge using its Camera frame
 * processor and MediaPipe Tasks runtime. It emits numeric landmarks only—the
 * app never needs to persist or transmit raw video to count a rep.
 */
export interface NativeMediaPipeBridge {
  getAvailability(): Promise<PoseProviderAvailability>;
  start(onObservation: (observation: NativePoseObservation) => void): Promise<void>;
  stop(): Promise<void>;
}

const degrees = (radians: number): number => (radians * 180) / Math.PI;

function distance(a: PoseLandmark, b: PoseLandmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function angleAt(vertex: PoseLandmark, first: PoseLandmark, second: PoseLandmark): number {
  const firstX = first.x - vertex.x;
  const firstY = first.y - vertex.y;
  const secondX = second.x - vertex.x;
  const secondY = second.y - vertex.y;
  const magnitude = Math.hypot(firstX, firstY) * Math.hypot(secondX, secondY);
  if (magnitude === 0) return 180;
  const cosine = Math.max(-1, Math.min(1, (firstX * secondX + firstY * secondY) / magnitude));
  return degrees(Math.acos(cosine));
}

function torsoLean(shoulder: PoseLandmark, hip: PoseLandmark): number {
  const dx = shoulder.x - hip.x;
  const dy = shoulder.y - hip.y;
  // A vector pointing straight up has no lean. `abs(dy)` keeps it stable for
  // both inverted image coordinates and front-camera mirroring.
  return degrees(Math.atan2(Math.abs(dx), Math.abs(dy)));
}

function inwardKneeAngle(
  hip: PoseLandmark,
  knee: PoseLandmark,
  ankle: PoseLandmark,
  bodyCenterX: number,
): number {
  const verticalSpan = ankle.y - hip.y;
  if (Math.abs(verticalSpan) < 0.0001) return 0;
  const progress = (knee.y - hip.y) / verticalSpan;
  const expectedKneeX = hip.x + (ankle.x - hip.x) * progress;
  const sideTowardCenter = Math.sign(bodyCenterX - hip.x);
  if (sideTowardCenter === 0) return 0;
  const inwardOffset = (knee.x - expectedKneeX) * sideTowardCenter;
  if (inwardOffset <= 0) return 0;
  return degrees(Math.atan2(inwardOffset, Math.abs(verticalSpan)));
}

function landmarkConfidence(landmarks: SquatLandmarks): number {
  return Math.min(
    ...Object.values(landmarks).map((landmark) => landmark.visibility ?? landmark.presence ?? 1),
  );
}

/**
 * Derives the compact, privacy-preserving features that the rep engine needs
 * from a MediaPipe observation. Calibrate these values per exercise/camera
 * position before treating them as a production-grade form model.
 */
export function poseFrameFromMediaPipe(observation: NativePoseObservation): PoseFrame | null {
  const { landmarks } = observation;
  const allLandmarks = Object.values(landmarks);
  if (!Number.isFinite(observation.timestampMs) || !allLandmarks.every(isFiniteLandmark)) return null;

  const kneeAngle =
    (angleAt(landmarks.leftKnee, landmarks.leftHip, landmarks.leftAnkle) +
      angleAt(landmarks.rightKnee, landmarks.rightHip, landmarks.rightAnkle)) /
    2;
  const torsoLeanDegrees =
    (torsoLean(landmarks.leftShoulder, landmarks.leftHip) +
      torsoLean(landmarks.rightShoulder, landmarks.rightHip)) /
    2;
  const bodyCenterX = (landmarks.leftHip.x + landmarks.rightHip.x) / 2;
  const kneeValgus =
    (inwardKneeAngle(landmarks.leftHip, landmarks.leftKnee, landmarks.leftAnkle, bodyCenterX) +
      inwardKneeAngle(landmarks.rightHip, landmarks.rightKnee, landmarks.rightAnkle, bodyCenterX)) /
    2;

  return {
    timestampMs: Math.round(observation.timestampMs),
    kneeAngle,
    torsoLean: torsoLeanDegrees,
    kneeValgus,
    confidence: Math.max(0, Math.min(1, landmarkConfidence(landmarks))),
  };
}

function isFiniteLandmark(landmark: PoseLandmark): boolean {
  return (
    Number.isFinite(landmark.x) &&
    Number.isFinite(landmark.y) &&
    (landmark.z === undefined || Number.isFinite(landmark.z)) &&
    (landmark.visibility === undefined || Number.isFinite(landmark.visibility)) &&
    (landmark.presence === undefined || Number.isFinite(landmark.presence))
  );
}

/**
 * A thin adapter ready for a development client containing the native camera
 * module. The Expo Go bundle deliberately uses the demo source instead of
 * claiming that MediaPipe is available when no native frame processor exists.
 */
export class NativeMediaPipePoseProvider implements PoseProvider {
  public readonly kind = "mediapipe-native" as const;

  public constructor(private readonly bridge: NativeMediaPipeBridge) {}

  public getAvailability(): Promise<PoseProviderAvailability> {
    return this.bridge.getAvailability();
  }

  public async start(onFrame: (frame: PoseFrame) => void): Promise<void> {
    const availability = await this.bridge.getAvailability();
    if (!availability.available) {
      throw new Error(availability.reason ?? "The native MediaPipe camera adapter is unavailable.");
    }
    await this.bridge.start((observation) => {
      const frame = poseFrameFromMediaPipe(observation);
      if (frame) onFrame(frame);
    });
  }

  public stop(): Promise<void> {
    return this.bridge.stop();
  }
}

/** The intentional Expo Go fallback; it makes the demo useful without faking camera support. */
export const demoAvailability: PoseProviderAvailability = {
  available: true,
  reason: "Deterministic replay mode is active. Install the native MediaPipe adapter for live camera analysis.",
};
