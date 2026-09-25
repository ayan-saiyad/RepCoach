import { StyleSheet, Text, View } from "react-native";

import type { PoseFrame, SquatPhase } from "../lib/rep-engine";
import { colors, confidenceColor, radii, spacing } from "../theme";

interface Point {
  x: number;
  y: number;
}

interface PoseStageProps {
  frame: PoseFrame;
  phase: SquatPhase;
  isPlaying: boolean;
}

const phaseLabel: Record<SquatPhase, string> = {
  standing: "READY",
  descending: "LOWERING",
  bottom: "DEPTH",
  ascending: "DRIVING UP",
};

function clamp(value: number, lower: number, upper: number): number {
  return Math.max(lower, Math.min(upper, value));
}

function poseFromFrame(frame: PoseFrame): Record<string, Point> {
  const depth = clamp((172 - frame.kneeAngle) / 78, 0, 1);
  const lean = clamp(frame.torsoLean / 55, 0, 1);
  const hipCenter: Point = { x: 50, y: 45 + depth * 13 };
  const shoulderCenter: Point = { x: 50 - lean * 13, y: 20 + depth * 12 };
  const kneeY = 68 + depth * 3;
  const inwardDrift = clamp(frame.kneeValgus / 16, 0, 1) * 6;

  return {
    leftShoulder: { x: shoulderCenter.x - 10, y: shoulderCenter.y },
    rightShoulder: { x: shoulderCenter.x + 10, y: shoulderCenter.y },
    leftHip: { x: hipCenter.x - 8, y: hipCenter.y },
    rightHip: { x: hipCenter.x + 8, y: hipCenter.y },
    leftKnee: { x: 36 + inwardDrift, y: kneeY },
    rightKnee: { x: 64 - inwardDrift, y: kneeY },
    leftAnkle: { x: 31, y: 91 },
    rightAnkle: { x: 69, y: 91 },
  };
}

function Limb({ from, to, color, thickness = 4 }: { from: Point; to: Point; color: string; thickness?: number }) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.sqrt(dx * dx + dy * dy);
  const rotation = (Math.atan2(dy, dx) * 180) / Math.PI;

  return (
    <View
      style={[
        styles.limb,
        {
          backgroundColor: color,
          height: thickness,
          left: `${(from.x + to.x) / 2 - length / 2}%`,
          top: `${(from.y + to.y) / 2}%`,
          width: `${length}%`,
          transform: [{ translateY: -thickness / 2 }, { rotate: `${rotation}deg` }],
        },
      ]}
    />
  );
}

function Joint({ point, emphasized = false }: { point: Point; emphasized?: boolean }) {
  return (
    <View
      style={[
        styles.joint,
        emphasized && styles.jointEmphasized,
        { left: `${point.x}%`, top: `${point.y}%` },
      ]}
    />
  );
}

export function PoseStage({ frame, phase, isPlaying }: PoseStageProps) {
  const pose = poseFromFrame(frame);
  const confidence = Math.round(frame.confidence * 100);
  const skeletonColor = isPlaying ? colors.lime : colors.mint;

  return (
    <View style={styles.shell}>
      <View style={styles.header}>
        <View style={styles.modeRow}>
          <View style={[styles.statusDot, { backgroundColor: isPlaying ? colors.lime : colors.textFaint }]} />
          <Text style={styles.modeText}>{isPlaying ? "LIVE REPLAY" : "POSE READY"}</Text>
        </View>
        <View style={styles.phaseChip}>
          <Text style={styles.phaseText}>{phaseLabel[phase]}</Text>
        </View>
      </View>

      <View style={styles.viewport}>
        <View style={[styles.gridLine, styles.gridVerticalOne]} />
        <View style={[styles.gridLine, styles.gridVerticalTwo]} />
        <View style={[styles.gridLine, styles.gridHorizontalOne]} />
        <View style={[styles.gridLine, styles.gridHorizontalTwo]} />
        <View style={styles.baseline} />
        <View style={styles.centerHalo} />

        <Limb from={pose.leftShoulder} to={pose.rightShoulder} color={skeletonColor} thickness={3} />
        <Limb from={pose.leftShoulder} to={pose.leftHip} color={skeletonColor} />
        <Limb from={pose.rightShoulder} to={pose.rightHip} color={skeletonColor} />
        <Limb from={pose.leftHip} to={pose.rightHip} color={skeletonColor} thickness={3} />
        <Limb from={pose.leftHip} to={pose.leftKnee} color={skeletonColor} />
        <Limb from={pose.leftKnee} to={pose.leftAnkle} color={skeletonColor} />
        <Limb from={pose.rightHip} to={pose.rightKnee} color={skeletonColor} />
        <Limb from={pose.rightKnee} to={pose.rightAnkle} color={skeletonColor} />

        {Object.entries(pose).map(([name, point]) => (
          <Joint key={name} point={point} emphasized={name.includes("Knee") || name.includes("Hip")} />
        ))}
        <View
          style={[
            styles.head,
            {
              left: `${(pose.leftShoulder.x + pose.rightShoulder.x) / 2}%`,
              top: `${pose.leftShoulder.y - 10}%`,
            },
          ]}
        />
      </View>

      <View style={styles.metrics}>
        <View style={styles.metric}>
          <Text style={styles.metricLabel}>KNEE ANGLE</Text>
          <Text style={styles.metricValue}>{Math.round(frame.kneeAngle)}°</Text>
        </View>
        <View style={styles.metricDivider} />
        <View style={styles.metric}>
          <Text style={styles.metricLabel}>TRACKING</Text>
          <Text style={styles.metricValue}>{frame.kneeValgus.toFixed(1)}°</Text>
        </View>
        <View style={styles.metricDivider} />
        <View style={styles.metric}>
          <Text style={styles.metricLabel}>CONFIDENCE</Text>
          <Text style={[styles.metricValue, { color: confidenceColor(frame.confidence) }]}>{confidence}%</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  shell: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radii.lg,
    borderWidth: 1,
    overflow: "hidden",
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
  },
  modeRow: { alignItems: "center", flexDirection: "row" },
  statusDot: { borderRadius: 4, height: 7, marginRight: 7, width: 7 },
  modeText: { color: colors.textMuted, fontSize: 10, fontWeight: "800", letterSpacing: 1.2 },
  phaseChip: {
    backgroundColor: colors.surfaceMuted,
    borderRadius: radii.pill,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  phaseText: { color: colors.lime, fontSize: 10, fontWeight: "900", letterSpacing: 0.8 },
  viewport: { height: 245, marginHorizontal: spacing.sm, marginTop: spacing.sm, overflow: "hidden" },
  gridLine: { backgroundColor: colors.borderSubtle, opacity: 0.8, position: "absolute" },
  gridVerticalOne: { bottom: 0, left: "25%", top: 0, width: 1 },
  gridVerticalTwo: { bottom: 0, right: "25%", top: 0, width: 1 },
  gridHorizontalOne: { height: 1, left: 0, right: 0, top: "33%" },
  gridHorizontalTwo: { height: 1, left: 0, right: 0, top: "66%" },
  baseline: { backgroundColor: colors.border, bottom: "8%", height: 2, left: "8%", position: "absolute", right: "8%" },
  centerHalo: {
    backgroundColor: colors.lime,
    borderRadius: 90,
    height: 180,
    left: "22%",
    opacity: 0.06,
    position: "absolute",
    top: "18%",
    width: 180,
  },
  limb: { borderRadius: 99, position: "absolute" },
  joint: {
    backgroundColor: colors.canvas,
    borderColor: colors.mint,
    borderRadius: 6,
    borderWidth: 2,
    height: 12,
    marginLeft: -6,
    marginTop: -6,
    position: "absolute",
    width: 12,
  },
  jointEmphasized: { backgroundColor: colors.lime, borderColor: colors.lime },
  head: {
    backgroundColor: colors.lime,
    borderColor: colors.canvas,
    borderRadius: 14,
    borderWidth: 3,
    height: 28,
    marginLeft: -14,
    marginTop: -14,
    position: "absolute",
    width: 28,
  },
  metrics: {
    alignItems: "center",
    backgroundColor: colors.canvasElevated,
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
  },
  metric: { alignItems: "center", flex: 1 },
  metricLabel: { color: colors.textFaint, fontSize: 9, fontWeight: "800", letterSpacing: 0.8 },
  metricValue: { color: colors.text, fontSize: 16, fontVariant: ["tabular-nums"], fontWeight: "800", marginTop: 3 },
  metricDivider: { backgroundColor: colors.borderSubtle, height: 28, width: 1 },
});
