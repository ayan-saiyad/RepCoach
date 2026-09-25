import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { PoseStage } from "./src/components/pose-stage";
import { RepHistory } from "./src/components/rep-history";
import {
  apiBaseUrl,
  apiConfigurationError,
  ApiError,
  isLoopbackApiUrl,
  makePendingRepUpload,
  RepCoachApiClient,
} from "./src/lib/api";
import { createDemoSquatReplay, DEMO_REP_TARGET, replayDelayMs } from "./src/lib/demo-pose-stream";
import {
  readPendingRepUploads,
  removePendingRepUpload,
  savePendingRepUpload,
} from "./src/lib/pending-upload-store";
import { cueForPhase, type PoseFrame, type RepEvent, SquatRepEngine, type SquatPhase } from "./src/lib/rep-engine";
import { demoAvailability } from "./src/pose/mediapipe-native";
import { colors, radii, scoreColor, spacing } from "./src/theme";
import type { LocalRep, SyncState, UploadState } from "./src/types";

const DEMO_USER = {
  id: "demo-athlete",
  name: "Demo Athlete",
} as const;

const initialReplay = createDemoSquatReplay();

type PendingRepUpload = {
  event: RepEvent;
  idempotencyKey: string;
  createdAt: string;
};

function syncPresentation(state: SyncState): { label: string; color: string } {
  switch (state) {
    case "connecting":
      return { label: "CONNECTING", color: colors.orange };
    case "synced":
      return { label: "API CONNECTED", color: colors.mint };
    case "offline":
      return { label: "DEVICE ONLY", color: colors.orange };
    case "finishing":
      return { label: "SAVING SET", color: colors.lime };
    case "finished":
      return { label: "SET SAVED", color: colors.lime };
    default:
      return { label: "REPLAY MODE", color: colors.textMuted };
  }
}

function averageScore(reps: readonly LocalRep[]): number | null {
  if (reps.length === 0) return null;
  return Math.round(
    reps.reduce((total, rep) => total + (rep.serverScore ?? rep.event.assessment.score), 0) / reps.length,
  );
}

function defaultConnectionNote(): string {
  const configurationError = apiConfigurationError();
  if (configurationError) {
    return `${configurationError} This build runs a deterministic three-rep replay, not live camera capture.`;
  }
  if (isLoopbackApiUrl()) {
    return "Replay works without cloud sync. For a physical phone, set EXPO_PUBLIC_API_BASE_URL to your computer's LAN address during development or to HTTPS for a release build.";
  }
  return "Replay-derived rep features will sync to the coaching API when it is available.";
}

export default function App() {
  const api = useMemo(() => new RepCoachApiClient(), []);
  const engineRef = useRef(new SquatRepEngine());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runIdRef = useRef(0);
  const sessionIdRef = useRef<string | null>(null);
  const sessionStartingRef = useRef(false);
  const syncPromiseRef = useRef<Promise<boolean> | null>(null);
  const recoveredSyncPromiseRef = useRef<Promise<boolean> | null>(null);
  const pendingUploadsRef = useRef<PendingRepUpload[]>([]);

  const [frame, setFrame] = useState<PoseFrame>(initialReplay[0]);
  const [phase, setPhase] = useState<SquatPhase>("standing");
  const [reps, setReps] = useState<LocalRep[]>([]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [replayComplete, setReplayComplete] = useState(false);
  const [syncState, setSyncState] = useState<SyncState>("idle");
  const [connectionNote, setConnectionNote] = useState(defaultConnectionNote);
  const [coachingNote, setCoachingNote] = useState<string | null>(null);

  const updateUpload = useCallback(
    (idempotencyKey: string, uploadState: UploadState, server?: { score: number; feedback: string }) => {
      setReps((current) =>
        current.map((rep) =>
          rep.idempotencyKey === idempotencyKey
            ? {
                ...rep,
                uploadState,
                ...(server ? { serverScore: server.score, serverFeedback: server.feedback } : {}),
              }
            : rep,
        ),
      );
    },
    [],
  );

  const markAllUploads = useCallback((uploadState: UploadState) => {
    setReps((current) => current.map((rep) => ({ ...rep, uploadState })));
  }, []);

  const persistInMemoryUploads = useCallback(async (sessionId: string): Promise<void> => {
    for (const upload of pendingUploadsRef.current) {
      await savePendingRepUpload({ sessionId, ...upload });
    }
  }, []);

  /**
   * Retries uploads that survived a process restart. This is deliberately
   * separate from the current set so an older offline session cannot block
   * the user from continuing a new replay.
   */
  const flushRecoveredUploads = useCallback((): Promise<boolean> => {
    if (recoveredSyncPromiseRef.current) return recoveredSyncPromiseRef.current;

    const work = (async (): Promise<boolean> => {
      let uploads;
      try {
        uploads = await readPendingRepUploads();
      } catch {
        return false;
      }
      if (uploads.length === 0) return true;

      for (const upload of uploads) {
        try {
          await api.recordRep(upload.sessionId, upload.event, upload.idempotencyKey);
          await removePendingRepUpload(upload.idempotencyKey);
        } catch (error) {
          setSyncState("offline");
          setConnectionNote(
            error instanceof ApiError
              ? `${error.message} ${uploads.length} saved rep${uploads.length === 1 ? " is" : "s are"} waiting to retry on this device.`
              : `${uploads.length} saved rep${uploads.length === 1 ? " is" : "s are"} waiting to retry on this device.`,
          );
          return false;
        }
      }

      setConnectionNote("Previously saved replay reps synced successfully.");
      return true;
    })();
    recoveredSyncPromiseRef.current = work;
    void work
      .finally(() => {
        if (recoveredSyncPromiseRef.current === work) recoveredSyncPromiseRef.current = null;
      })
      .catch(() => undefined);
    return work;
  }, [api]);

  const flushPendingUploads = useCallback((): Promise<boolean> => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return Promise.resolve(false);
    if (syncPromiseRef.current) return syncPromiseRef.current;

    const runId = runIdRef.current;
    const work = (async (): Promise<boolean> => {
      while (pendingUploadsRef.current.length > 0 && runId === runIdRef.current) {
        const next = pendingUploadsRef.current[0];
        updateUpload(next.idempotencyKey, "uploading");
        try {
          // Write first: a terminated app can replay safely with the same key.
          await savePendingRepUpload({ sessionId, ...next });
          const saved = await api.recordRep(sessionId, next.event, next.idempotencyKey);
          if (runId !== runIdRef.current) return false;
          await removePendingRepUpload(next.idempotencyKey);
          pendingUploadsRef.current.shift();
          updateUpload(next.idempotencyKey, "synced", {
            score: saved.rep.preliminary_score,
            feedback: saved.rep.feedback,
          });
        } catch (error) {
          if (runId === runIdRef.current) {
            updateUpload(next.idempotencyKey, "offline");
            setSyncState("offline");
            setConnectionNote(
              error instanceof ApiError
                ? `${error.message} Your completed replay rep is saved on this device and will retry later.`
                : "Rep sync paused. Your completed replay rep is saved on this device and will retry later.",
            );
          }
          return false;
        }
      }
      if (runId === runIdRef.current) setSyncState("synced");
      return pendingUploadsRef.current.length === 0;
    })();
    syncPromiseRef.current = work;
    void work
      .finally(() => {
        if (syncPromiseRef.current === work) syncPromiseRef.current = null;
      })
      .catch(() => undefined);
    return work;
  }, [api, updateUpload]);

  const establishSession = useCallback(async (): Promise<boolean> => {
    if (sessionIdRef.current) return true;
    if (sessionStartingRef.current) return false;

    const runId = runIdRef.current;
    sessionStartingRef.current = true;
    setSyncState("connecting");
    try {
      const session = await api.createSession({
        user_id: DEMO_USER.id,
        display_name: DEMO_USER.name,
        exercise_slug: "bodyweight-squat",
        target_reps: DEMO_REP_TARGET,
        source: "expo-mobile",
      });
      if (runId !== runIdRef.current) return false;
      sessionIdRef.current = session.id;
      await persistInMemoryUploads(session.id);
      setSyncState("synced");
      setConnectionNote("Connected to the workout API. Replay-derived features, not raw video, are being saved.");
      void flushPendingUploads();
      return true;
    } catch (error) {
      if (runId !== runIdRef.current) return false;
      setSyncState("offline");
      markAllUploads("offline");
      setConnectionNote(
        error instanceof ApiError
          ? `${error.message} Replay feedback remains available while this screen stays open.`
          : "The coaching API is unavailable. Replay feedback remains available while this screen stays open.",
      );
      return false;
    } finally {
      if (runId === runIdRef.current) sessionStartingRef.current = false;
    }
  }, [api, flushPendingUploads, markAllUploads, persistInMemoryUploads]);

  const enqueueRep = useCallback(
    (event: RepEvent) => {
      const pending = makePendingRepUpload(event);
      const upload: PendingRepUpload = { ...pending, createdAt: new Date().toISOString() };
      pendingUploadsRef.current.push(upload);
      setReps((current) => [
        ...current,
        {
          event,
          idempotencyKey: upload.idempotencyKey,
          uploadState: sessionIdRef.current || sessionStartingRef.current ? "pending" : "offline",
        },
      ]);
      const sessionId = sessionIdRef.current;
      if (sessionId) {
        void savePendingRepUpload({ sessionId, ...upload })
          .then(() => flushPendingUploads())
          .catch(() => {
            updateUpload(upload.idempotencyKey, "offline");
            setSyncState("offline");
            setConnectionNote("This replay rep could not be stored safely on this device. Keep the app open and try syncing again.");
          });
      }
    },
    [flushPendingUploads, updateUpload],
  );

  const playFrame = useCallback(
    (index: number, runId: number) => {
      if (runId !== runIdRef.current) return;
      const replay = initialReplay;
      const nextFrame = replay[index];
      if (!nextFrame) return;

      setFrame(nextFrame);
      const rep = engineRef.current.update(nextFrame);
      setPhase(engineRef.current.phase);
      if (rep) enqueueRep(rep);

      const followingFrame = replay[index + 1];
      if (followingFrame) {
        timerRef.current = setTimeout(
          () => playFrame(index + 1, runId),
          replayDelayMs(nextFrame, followingFrame),
        );
        return;
      }

      timerRef.current = null;
      setIsPlaying(false);
      setReplayComplete(true);
      setPhase("standing");
    },
    [enqueueRep],
  );

  const startReplay = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);

    runIdRef.current += 1;
    const runId = runIdRef.current;
    engineRef.current.reset();
    sessionIdRef.current = null;
    sessionStartingRef.current = false;
    syncPromiseRef.current = null;
    pendingUploadsRef.current = [];

    setFrame(initialReplay[0]);
    setPhase("standing");
    setReps([]);
    setReplayComplete(false);
    setCoachingNote(null);
    setConnectionNote(defaultConnectionNote());
    setSyncState("connecting");
    setIsPlaying(true);

    void flushRecoveredUploads();
    void establishSession();
    playFrame(0, runId);
  }, [establishSession, flushRecoveredUploads, playFrame]);

  const finishSession = useCallback(async () => {
    if (isPlaying || syncState === "finishing" || syncState === "finished") return;

    const connected = await establishSession();
    if (!connected || !sessionIdRef.current) {
      setConnectionNote("This replay has not opened a cloud session yet. Reconnect, keep the app open, then tap Finish & save again.");
      return;
    }

    const uploaded = await flushPendingUploads();
    if (!uploaded) {
      setConnectionNote("Rep sync must finish before the server can close this set. Tap Finish & save after reconnecting.");
      return;
    }

    const runId = runIdRef.current;
    setSyncState("finishing");
    try {
      const completed = await api.completeSession(sessionIdRef.current);
      if (runId !== runIdRef.current) return;
      setSyncState("finished");
      setCoachingNote(completed.coaching_note);
      setConnectionNote("Your session is complete and ready for the RepCoach progress dashboard.");
    } catch (error) {
      if (runId !== runIdRef.current) return;
      setSyncState("offline");
      setConnectionNote(
        error instanceof ApiError
          ? `${error.message} The replay reps were already acknowledged by the API; try finishing again once it is back.`
          : "Could not close this session yet. The replay reps were already acknowledged by the API; try again after reconnecting.",
      );
    }
  }, [api, establishSession, flushPendingUploads, isPlaying, syncState]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  useEffect(() => {
    void flushRecoveredUploads();
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") void flushRecoveredUploads();
    });
    return () => subscription.remove();
  }, [flushRecoveredUploads]);

  const latestRep = reps[reps.length - 1];
  const latestScore = latestRep ? latestRep.serverScore ?? latestRep.event.assessment.score : null;
  const liveCue = isPlaying ? cueForPhase(phase) : latestRep?.serverFeedback ?? latestRep?.event.assessment.cue;
  const score = averageScore(reps);
  const progress = Math.min(reps.length / DEMO_REP_TARGET, 1);
  const sync = syncPresentation(syncState);
  const primaryLabel = isPlaying
    ? "COACHING IN PROGRESS"
    : replayComplete && syncState !== "finished"
      ? "FINISH & SAVE SET"
      : "RUN 3-REP REPLAY";
  const primaryAction = replayComplete && syncState !== "finished" ? finishSession : startReplay;
  const primaryDisabled = isPlaying || syncState === "finishing";

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" />
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        style={styles.scrollView}
      >
        <View style={styles.header}>
          <View>
            <Text style={styles.brand}>REP/COACH</Text>
            <Text style={styles.subBrand}>MOVEMENT QUALITY SYSTEM</Text>
          </View>
          <View style={[styles.syncPill, { borderColor: sync.color }]}>
            <View style={[styles.syncDot, { backgroundColor: sync.color }]} />
            <Text style={[styles.syncLabel, { color: sync.color }]}>{sync.label}</Text>
          </View>
        </View>

        <View style={styles.hero}>
          <View style={styles.heroCopy}>
            <Text style={styles.eyebrow}>GUIDED MOVEMENT</Text>
            <Text style={styles.exercise}>Bodyweight{`\n`}Squat</Text>
            <Text style={styles.heroDescription}>A deterministic pose replay with local scoring, instant cues, and an auditable workout record.</Text>
          </View>
          <View style={styles.scoreOrbWrap}>
            <View style={[styles.scoreOrb, latestScore !== null && { borderColor: scoreColor(latestScore) }]}>
              <Text style={styles.scoreOrbValue}>{latestScore ?? "—"}</Text>
              <Text style={styles.scoreOrbLabel}>{latestScore === null ? "FORM SCORE" : "LAST REP"}</Text>
            </View>
          </View>
        </View>

        <View style={styles.progressCard}>
          <View style={styles.progressTopline}>
            <Text style={styles.progressLabel}>SET PROGRESS</Text>
            <Text style={styles.progressCount}>
              {String(reps.length).padStart(2, "0")} <Text style={styles.progressTarget}>/ {String(DEMO_REP_TARGET).padStart(2, "0")}</Text>
            </Text>
          </View>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
          </View>
          <View style={styles.progressFooter}>
            <Text style={styles.progressHint}>{isPlaying ? "Scoring deterministic replay frames" : "Each replayed rep is scored on-device first"}</Text>
            <Text style={styles.average}>AVG {score ?? "—"}</Text>
          </View>
        </View>

        <PoseStage frame={frame} isPlaying={isPlaying} phase={phase} />

        <View style={styles.coachCard}>
          <View style={styles.coachHeader}>
            <View style={styles.coachMarker}>
              <Text style={styles.coachMarkerText}>AI</Text>
            </View>
            <View style={styles.coachHeaderCopy}>
              <Text style={styles.coachEyebrow}>{latestRep ? "REP-SPECIFIC COACHING" : "STARTING POSITION"}</Text>
              <Text style={styles.coachTitle}>{isPlaying ? phase.toUpperCase() : latestRep ? "Movement cue" : "Ready when you are"}</Text>
            </View>
          </View>
          <Text style={styles.coachCue}>{liveCue ?? "This demo replays three scored squat reps. Live camera analysis requires the native MediaPipe adapter."}</Text>
          <View style={styles.coachDivider} />
          <Text style={styles.coachSafety}>Coaching feedback only—not medical or injury-risk advice. Stop if you feel pain.</Text>
        </View>

        {coachingNote ? (
          <View style={styles.completeCard}>
            <Text style={styles.completeEyebrow}>SESSION COMPLETE</Text>
            <Text style={styles.completeNote}>{coachingNote}</Text>
          </View>
        ) : null}

        <View style={styles.actionBlock}>
          <Pressable
            accessibilityLabel={primaryLabel}
            accessibilityRole="button"
            disabled={primaryDisabled}
            onPress={primaryAction}
            style={({ pressed }) => [
              styles.primaryButton,
              primaryDisabled && styles.primaryButtonDisabled,
              pressed && !primaryDisabled && styles.primaryButtonPressed,
            ]}
          >
            <Text style={styles.primaryButtonText}>{primaryLabel}</Text>
            <Text style={styles.primaryButtonArrow}>→</Text>
          </Pressable>
          {replayComplete && syncState === "finished" ? (
            <Pressable accessibilityRole="button" onPress={startReplay} style={({ pressed }) => [styles.secondaryButton, pressed && styles.secondaryButtonPressed]}>
              <Text style={styles.secondaryButtonText}>RUN AGAIN</Text>
            </Pressable>
          ) : null}
          <Text style={styles.connectionNote}>{connectionNote}</Text>
        </View>

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>REP LOG</Text>
          <Text style={styles.sectionMeta}>{reps.length === 0 ? "AWAITING MOTION" : `${reps.length} LOCALLY VERIFIED`}</Text>
        </View>
        <RepHistory reps={reps} />

        <View style={styles.integrationCard}>
          <View style={styles.integrationIcon}>
            <Text style={styles.integrationIconText}>⌁</Text>
          </View>
          <View style={styles.integrationCopy}>
            <Text style={styles.integrationEyebrow}>DEMO MODE</Text>
            <Text style={styles.integrationTitle}>Replay-first, MediaPipe-ready.</Text>
            <Text style={styles.integrationBody}>{demoAvailability.reason}</Text>
          </View>
        </View>

        <View style={styles.footer}>
          <Text style={styles.footerText}>API: {apiBaseUrl || "NOT CONFIGURED"}</Text>
          <Text style={styles.footerText}>REPLAY FEATURES • NO RAW VIDEO</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { backgroundColor: colors.canvas, flex: 1 },
  scrollView: { backgroundColor: colors.canvas },
  scrollContent: { paddingBottom: 42, paddingHorizontal: spacing.md },
  header: { alignItems: "center", flexDirection: "row", justifyContent: "space-between", paddingBottom: spacing.xl, paddingTop: spacing.md },
  brand: { color: colors.text, fontSize: 17, fontWeight: "900", letterSpacing: 1.6 },
  subBrand: { color: colors.textFaint, fontSize: 9, fontWeight: "800", letterSpacing: 1.15, marginTop: 2 },
  syncPill: { alignItems: "center", borderRadius: radii.pill, borderWidth: 1, flexDirection: "row", paddingHorizontal: 9, paddingVertical: 6 },
  syncDot: { borderRadius: 3.5, height: 7, marginRight: 6, width: 7 },
  syncLabel: { fontSize: 9, fontWeight: "900", letterSpacing: 0.7 },
  hero: { flexDirection: "row", marginBottom: spacing.lg },
  heroCopy: { flex: 1, paddingRight: spacing.sm },
  eyebrow: { color: colors.limeDeep, fontSize: 10, fontWeight: "900", letterSpacing: 1.4 },
  exercise: { color: colors.text, fontSize: 35, fontWeight: "900", letterSpacing: -1.1, lineHeight: 37, marginTop: 7 },
  heroDescription: { color: colors.textMuted, fontSize: 13, lineHeight: 19, marginTop: 11, maxWidth: 225 },
  scoreOrbWrap: { alignItems: "center", justifyContent: "flex-end", paddingBottom: 5 },
  scoreOrb: { alignItems: "center", backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 50, borderWidth: 5, height: 92, justifyContent: "center", width: 92 },
  scoreOrbValue: { color: colors.text, fontSize: 28, fontVariant: ["tabular-nums"], fontWeight: "900", lineHeight: 31 },
  scoreOrbLabel: { color: colors.textFaint, fontSize: 8, fontWeight: "900", letterSpacing: 0.65, marginTop: 1 },
  progressCard: { backgroundColor: colors.canvasElevated, borderColor: colors.borderSubtle, borderRadius: radii.md, borderWidth: 1, marginBottom: spacing.md, padding: spacing.md },
  progressTopline: { alignItems: "center", flexDirection: "row", justifyContent: "space-between" },
  progressLabel: { color: colors.textMuted, fontSize: 10, fontWeight: "900", letterSpacing: 1.1 },
  progressCount: { color: colors.text, fontSize: 18, fontVariant: ["tabular-nums"], fontWeight: "900" },
  progressTarget: { color: colors.textFaint, fontSize: 13 },
  progressTrack: { backgroundColor: colors.surfaceMuted, borderRadius: radii.pill, height: 7, marginTop: 10, overflow: "hidden" },
  progressFill: { backgroundColor: colors.lime, borderRadius: radii.pill, height: "100%" },
  progressFooter: { alignItems: "center", flexDirection: "row", justifyContent: "space-between", marginTop: 9 },
  progressHint: { color: colors.textFaint, fontSize: 11 },
  average: { color: colors.mint, fontSize: 11, fontVariant: ["tabular-nums"], fontWeight: "900", letterSpacing: 0.7 },
  coachCard: { backgroundColor: colors.surfaceRaised, borderColor: colors.border, borderRadius: radii.lg, borderWidth: 1, marginTop: spacing.md, padding: spacing.md },
  coachHeader: { alignItems: "center", flexDirection: "row" },
  coachMarker: { alignItems: "center", backgroundColor: colors.lime, borderRadius: 16, height: 32, justifyContent: "center", marginRight: 10, width: 32 },
  coachMarkerText: { color: colors.black, fontSize: 10, fontWeight: "900" },
  coachHeaderCopy: { flex: 1 },
  coachEyebrow: { color: colors.limeDeep, fontSize: 9, fontWeight: "900", letterSpacing: 1.1 },
  coachTitle: { color: colors.text, fontSize: 15, fontWeight: "800", marginTop: 1 },
  coachCue: { color: colors.text, fontSize: 15, fontWeight: "600", lineHeight: 22, marginTop: spacing.md },
  coachDivider: { backgroundColor: colors.border, height: 1, marginVertical: spacing.sm },
  coachSafety: { color: colors.textFaint, fontSize: 10, lineHeight: 15 },
  completeCard: { backgroundColor: "#21361A", borderColor: colors.limeDeep, borderRadius: radii.md, borderWidth: 1, marginTop: spacing.md, padding: spacing.md },
  completeEyebrow: { color: colors.lime, fontSize: 10, fontWeight: "900", letterSpacing: 1.3 },
  completeNote: { color: colors.text, fontSize: 14, fontWeight: "700", lineHeight: 20, marginTop: 6 },
  actionBlock: { alignItems: "center", marginTop: spacing.lg },
  primaryButton: { alignItems: "center", backgroundColor: colors.lime, borderRadius: radii.md, flexDirection: "row", justifyContent: "center", minHeight: 56, paddingHorizontal: spacing.lg, width: "100%" },
  primaryButtonDisabled: { backgroundColor: colors.surfaceMuted },
  primaryButtonPressed: { opacity: 0.82, transform: [{ scale: 0.99 }] },
  primaryButtonText: { color: colors.black, fontSize: 13, fontWeight: "900", letterSpacing: 1.05 },
  primaryButtonArrow: { color: colors.black, fontSize: 22, fontWeight: "800", marginLeft: 10, marginTop: -2 },
  secondaryButton: { alignItems: "center", borderColor: colors.border, borderRadius: radii.md, borderWidth: 1, justifyContent: "center", marginTop: spacing.sm, minHeight: 48, width: "100%" },
  secondaryButtonPressed: { backgroundColor: colors.surface },
  secondaryButtonText: { color: colors.text, fontSize: 12, fontWeight: "900", letterSpacing: 1 },
  connectionNote: { color: colors.textFaint, fontSize: 11, lineHeight: 16, marginTop: spacing.sm, textAlign: "center" },
  sectionHeader: { alignItems: "center", flexDirection: "row", justifyContent: "space-between", marginBottom: spacing.sm, marginTop: spacing.xl },
  sectionTitle: { color: colors.text, fontSize: 14, fontWeight: "900", letterSpacing: 0.8 },
  sectionMeta: { color: colors.textFaint, fontSize: 9, fontWeight: "900", letterSpacing: 0.9 },
  integrationCard: { alignItems: "flex-start", backgroundColor: colors.canvasElevated, borderColor: colors.borderSubtle, borderRadius: radii.md, borderWidth: 1, flexDirection: "row", marginTop: spacing.lg, padding: spacing.md },
  integrationIcon: { alignItems: "center", backgroundColor: colors.surfaceMuted, borderRadius: 16, height: 32, justifyContent: "center", marginRight: spacing.sm, width: 32 },
  integrationIconText: { color: colors.mint, fontSize: 21, fontWeight: "800", marginTop: -3 },
  integrationCopy: { flex: 1 },
  integrationEyebrow: { color: colors.mint, fontSize: 9, fontWeight: "900", letterSpacing: 1.05 },
  integrationTitle: { color: colors.text, fontSize: 14, fontWeight: "800", marginTop: 2 },
  integrationBody: { color: colors.textMuted, fontSize: 11, lineHeight: 16, marginTop: 4 },
  footer: { alignItems: "center", borderTopColor: colors.borderSubtle, borderTopWidth: 1, marginTop: spacing.xl, paddingTop: spacing.md },
  footerText: { color: colors.textFaint, fontSize: 9, fontWeight: "700", letterSpacing: 0.55, marginBottom: 4, textAlign: "center" },
});
