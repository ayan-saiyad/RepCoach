import type { DashboardData, Rep, SessionDetail, WorkoutSession } from "@/lib/types";

// A fixed clock keeps the server-rendered fallback identical during client hydration.
// Live API data replaces this immediately when the local stack is available.
const now = new Date("2026-09-24T15:00:00.000Z");
const relativeIso = (daysAgo: number, hours = 8) => {
  const date = new Date(now);
  date.setDate(date.getDate() - daysAgo);
  date.setHours(hours, 0, 0, 0);
  return date.toISOString();
};

const reps: Rep[] = [
  {
    id: "rep-1001",
    ordinal: 1,
    preliminary_score: 93,
    final_score: 94,
    form_label: "good",
    feedback: "Strong first rep. Keep that controlled tempo.",
    analysis_status: "complete",
    features: { minimum_knee_angle: 83, maximum_torso_lean: 17, maximum_knee_valgus: 4, eccentric_duration_ms: 1190, concentric_duration_ms: 860, landmark_confidence: 0.97 },
    created_at: relativeIso(0, 7),
  },
  {
    id: "rep-1002",
    ordinal: 2,
    preliminary_score: 89,
    final_score: 90,
    form_label: "good",
    feedback: "Depth and knee tracking stayed consistent.",
    analysis_status: "complete",
    features: { minimum_knee_angle: 80, maximum_torso_lean: 19, maximum_knee_valgus: 5, eccentric_duration_ms: 1110, concentric_duration_ms: 810, landmark_confidence: 0.96 },
    created_at: relativeIso(0, 7),
  },
  {
    id: "rep-1003",
    ordinal: 3,
    preliminary_score: 82,
    final_score: 83,
    form_label: "shallow_depth",
    feedback: "Sink two inches deeper while keeping your chest proud.",
    analysis_status: "complete",
    features: { minimum_knee_angle: 102, maximum_torso_lean: 18, maximum_knee_valgus: 4, eccentric_duration_ms: 980, concentric_duration_ms: 760, landmark_confidence: 0.97 },
    created_at: relativeIso(0, 7),
  },
  {
    id: "rep-1004",
    ordinal: 4,
    preliminary_score: 86,
    final_score: 87,
    form_label: "good",
    feedback: "Nice correction. Your depth is back in range.",
    analysis_status: "complete",
    features: { minimum_knee_angle: 88, maximum_torso_lean: 21, maximum_knee_valgus: 5, eccentric_duration_ms: 1090, concentric_duration_ms: 790, landmark_confidence: 0.95 },
    created_at: relativeIso(0, 7),
  },
  {
    id: "rep-1005",
    ordinal: 5,
    preliminary_score: 78,
    final_score: 79,
    form_label: "rushed_rep",
    feedback: "Own the descent: aim for a smooth 2-second lower.",
    analysis_status: "complete",
    features: { minimum_knee_angle: 85, maximum_torso_lean: 20, maximum_knee_valgus: 6, eccentric_duration_ms: 690, concentric_duration_ms: 640, landmark_confidence: 0.96 },
    created_at: relativeIso(0, 7),
  },
  {
    id: "rep-1006",
    ordinal: 6,
    preliminary_score: 91,
    final_score: 92,
    form_label: "good",
    feedback: "Excellent finish. Tempo and alignment were steady.",
    analysis_status: "complete",
    features: { minimum_knee_angle: 81, maximum_torso_lean: 18, maximum_knee_valgus: 3, eccentric_duration_ms: 1160, concentric_duration_ms: 820, landmark_confidence: 0.98 },
    created_at: relativeIso(0, 7),
  },
];

const latestSession: SessionDetail = {
  id: "demo-session-01",
  user_id: "demo-athlete",
  exercise_slug: "bodyweight-squat",
  status: "completed",
  target_reps: 8,
  rep_count: reps.length,
  average_form_score: 87.5,
  source: "mobile",
  started_at: relativeIso(0, 7),
  completed_at: relativeIso(0, 7),
  reps,
};

const recentSessions: WorkoutSession[] = [
  latestSession,
  { id: "demo-session-02", user_id: "demo-athlete", exercise_slug: "reverse-lunge", status: "completed", target_reps: 10, rep_count: 20, average_form_score: 89.1, source: "mobile", started_at: relativeIso(1, 6), completed_at: relativeIso(1, 6) },
  { id: "demo-session-03", user_id: "demo-athlete", exercise_slug: "bodyweight-squat", status: "completed", target_reps: 12, rep_count: 12, average_form_score: 84.4, source: "mobile", started_at: relativeIso(2, 7), completed_at: relativeIso(2, 7) },
  { id: "demo-session-04", user_id: "demo-athlete", exercise_slug: "push-up", status: "completed", target_reps: 8, rep_count: 16, average_form_score: 91.2, source: "mobile", started_at: relativeIso(4, 8), completed_at: relativeIso(4, 8) },
];

export const demoDashboardData: DashboardData = {
  summary: {
    user_id: "demo-athlete",
    total_sessions: 18,
    total_reps: 244,
    weekly_reps: 72,
    average_form_score: 88.6,
    current_streak_days: 6,
    common_cue: "Own the descent: aim for a smooth 2-second lower.",
    recent_sessions: recentSessions,
    form_trend: [
      { date: relativeIso(6).slice(0, 10), average_score: 82, reps: 18 },
      { date: relativeIso(5).slice(0, 10), average_score: 84, reps: 21 },
      { date: relativeIso(4).slice(0, 10), average_score: 86, reps: 16 },
      { date: relativeIso(3).slice(0, 10), average_score: 85, reps: 14 },
      { date: relativeIso(2).slice(0, 10), average_score: 84.4, reps: 12 },
      { date: relativeIso(1).slice(0, 10), average_score: 89.1, reps: 20 },
      { date: relativeIso(0).slice(0, 10), average_score: 87.5, reps: 6 },
    ],
    generated_at: now.toISOString(),
  },
  latestSession,
  usingDemoData: true,
  message: "Showing a representative athlete profile while your local API starts.",
};

const demoDetailFor = (session: WorkoutSession, index: number): SessionDetail => {
  if (session.id === latestSession.id) return latestSession;
  const baseline = session.average_form_score ?? 82;
  return {
    ...session,
    reps: reps.map((rep, repIndex) => {
      const modifier = [3, 1, -4, 0, -6, 2][repIndex] ?? 0;
      const score = Math.max(65, Math.min(98, baseline + modifier));
      return {
        ...rep,
        id: `${session.id}-rep-${repIndex + 1}`,
        ordinal: repIndex + 1,
        preliminary_score: score,
        final_score: score,
        feedback: repIndex === 4
          ? "Slow your next descent slightly and stay braced through the bottom."
          : rep.feedback,
        created_at: relativeIso(index + 1, 7),
      };
    }),
  };
};

export function getDemoSessionDetail(sessionId: string): SessionDetail | null {
  const index = recentSessions.findIndex((session) => session.id === sessionId);
  return index === -1 ? null : demoDetailFor(recentSessions[index], index);
}
