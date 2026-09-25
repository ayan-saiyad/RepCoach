export type SessionStatus = "active" | "completed" | "abandoned";
export type AnalysisStatus = "queued" | "processing" | "complete" | "failed";

export interface RepFeatures {
  minimum_knee_angle: number;
  maximum_torso_lean: number;
  maximum_knee_valgus: number;
  eccentric_duration_ms: number;
  concentric_duration_ms: number;
  landmark_confidence: number;
}

export interface Rep {
  id: string;
  ordinal: number;
  preliminary_score: number;
  final_score: number | null;
  form_label: string;
  feedback: string;
  analysis_status: AnalysisStatus;
  features: RepFeatures;
  created_at: string;
}

export interface WorkoutSession {
  id: string;
  user_id: string;
  exercise_slug: string;
  status: SessionStatus;
  target_reps: number;
  rep_count: number;
  average_form_score: number | null;
  source: string;
  started_at: string;
  completed_at: string | null;
}

export interface SessionDetail extends WorkoutSession {
  reps: Rep[];
}

export interface TrendPoint {
  date: string;
  average_score: number;
  reps: number;
}

export interface DashboardSummary {
  user_id: string;
  total_sessions: number;
  total_reps: number;
  weekly_reps: number;
  average_form_score: number | null;
  current_streak_days: number;
  common_cue: string | null;
  recent_sessions: WorkoutSession[];
  form_trend: TrendPoint[];
  generated_at: string;
}

export interface DashboardData {
  summary: DashboardSummary;
  latestSession: SessionDetail | null;
  usingDemoData: boolean;
  message?: string;
}

export interface CoachCitation {
  memory_id: string;
  content: string;
  created_at: string;
}

export interface CoachReply {
  answer: string;
  provider: "bedrock" | "local";
  citations: CoachCitation[];
}
