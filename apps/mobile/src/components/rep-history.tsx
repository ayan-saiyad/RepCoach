import { StyleSheet, Text, View } from "react-native";

import type { LocalRep } from "../types";
import { colors, radii, scoreColor, spacing } from "../theme";

interface RepHistoryProps {
  reps: readonly LocalRep[];
}

const uploadCopy = {
  pending: "Queued",
  uploading: "Syncing",
  synced: "Saved",
  retrying: "Retrying",
  offline: "On device",
} as const;

function prettyLabel(label: string): string {
  return label.replace(/_/g, " ");
}

export function RepHistory({ reps }: RepHistoryProps) {
  if (reps.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyEyebrow}>YOUR REP LOG</Text>
        <Text style={styles.emptyTitle}>Your form story starts here.</Text>
        <Text style={styles.emptyCopy}>Run the guided replay to see each locally scored rep and its API sync state.</Text>
      </View>
    );
  }

  return (
    <View style={styles.list}>
      {reps.map((rep) => {
        const score = rep.serverScore ?? rep.event.assessment.score;
        const color = scoreColor(score);
        return (
          <View key={rep.idempotencyKey} style={styles.row}>
            <View style={[styles.scoreBadge, { borderColor: color }]}>
              <Text style={[styles.scoreText, { color }]}>{Math.round(score)}</Text>
            </View>
            <View style={styles.copy}>
              <View style={styles.rowTop}>
                <Text style={styles.repTitle}>REP {String(rep.event.repNumber).padStart(2, "0")}</Text>
                <Text style={styles.upload}>{uploadCopy[rep.uploadState]}</Text>
              </View>
              <Text style={styles.label}>{prettyLabel(rep.event.assessment.label)}</Text>
              <Text numberOfLines={2} style={styles.cue}>
                {rep.serverFeedback ?? rep.event.assessment.cue}
              </Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  empty: {
    backgroundColor: colors.surface,
    borderColor: colors.borderSubtle,
    borderRadius: radii.lg,
    borderStyle: "dashed",
    borderWidth: 1,
    padding: spacing.lg,
  },
  emptyEyebrow: { color: colors.limeDeep, fontSize: 10, fontWeight: "900", letterSpacing: 1.3 },
  emptyTitle: { color: colors.text, fontSize: 18, fontWeight: "800", marginTop: spacing.xs },
  emptyCopy: { color: colors.textMuted, fontSize: 13, lineHeight: 19, marginTop: spacing.xs },
  list: { gap: spacing.sm },
  row: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.borderSubtle,
    borderRadius: radii.md,
    borderWidth: 1,
    flexDirection: "row",
    padding: spacing.sm,
  },
  scoreBadge: {
    alignItems: "center",
    backgroundColor: colors.canvasElevated,
    borderRadius: 24,
    borderWidth: 1.5,
    height: 48,
    justifyContent: "center",
    marginRight: spacing.sm,
    width: 48,
  },
  scoreText: { fontSize: 17, fontVariant: ["tabular-nums"], fontWeight: "900" },
  copy: { flex: 1, minWidth: 0 },
  rowTop: { alignItems: "center", flexDirection: "row", justifyContent: "space-between" },
  repTitle: { color: colors.text, fontSize: 12, fontWeight: "900", letterSpacing: 0.8 },
  upload: { color: colors.textFaint, fontSize: 10, fontWeight: "700" },
  label: { color: colors.mint, fontSize: 11, fontWeight: "800", marginTop: 2, textTransform: "uppercase" },
  cue: { color: colors.textMuted, fontSize: 12, lineHeight: 17, marginTop: 3 },
});
