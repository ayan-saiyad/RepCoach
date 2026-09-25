import * as Crypto from "expo-crypto";

import type { RepEvent, SquatRepFeatures } from "./rep-engine";

export type SessionStatus = "active" | "completed" | "abandoned";
export type AnalysisStatus = "queued" | "processing" | "complete" | "failed";

export interface ApiRepFeatures {
  minimum_knee_angle: number;
  maximum_torso_lean: number;
  maximum_knee_valgus: number;
  eccentric_duration_ms: number;
  concentric_duration_ms: number;
  landmark_confidence: number;
}

export interface CreateSessionInput {
  user_id: string;
  display_name: string;
  exercise_slug: "bodyweight-squat";
  target_reps: number;
  source: "expo-mobile";
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

export interface ApiRep {
  id: string;
  ordinal: number;
  preliminary_score: number;
  final_score: number | null;
  form_label: string;
  feedback: string;
  analysis_status: AnalysisStatus;
  features: ApiRepFeatures;
  created_at: string;
}

export interface CompleteSessionResponse {
  session: WorkoutSession;
  coaching_note: string;
}

export interface RecordedRep {
  rep: ApiRep;
  replayed: boolean;
}

export class ApiError extends Error {
  public constructor(
    message: string,
    public readonly status?: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const configuredBaseUrl = process.env.EXPO_PUBLIC_API_BASE_URL;
export const apiBaseUrl = (configuredBaseUrl ?? "http://localhost:8000").replace(/\/$/, "");

export function isLoopbackApiUrl(baseUrl = apiBaseUrl): boolean {
  return /:\/\/(localhost|127\.0\.0\.1)(?::|\/|$)/i.test(baseUrl);
}

export function toApiFeatures(features: SquatRepFeatures): ApiRepFeatures {
  return {
    minimum_knee_angle: features.minimumKneeAngle,
    maximum_torso_lean: features.maximumTorsoLean,
    maximum_knee_valgus: features.maximumKneeValgus,
    eccentric_duration_ms: features.eccentricDurationMs,
    concentric_duration_ms: features.concentricDurationMs,
    landmark_confidence: features.landmarkConfidence,
  };
}

/** A key is generated once per event and retained when an upload is retried. */
export function createRepIdempotencyKey(): string {
  return Crypto.randomUUID();
}

function responseBody(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function errorMessage(status: number, payload: unknown): string {
  if (typeof payload === "object" && payload !== null && "detail" in payload) {
    const detail = (payload as { detail?: unknown }).detail;
    if (typeof detail === "string") return detail;
  }
  return `RepCoach API request failed (${status}).`;
}

export class RepCoachApiClient {
  public constructor(private readonly baseUrl = apiBaseUrl) {}

  public createSession(input: CreateSessionInput): Promise<WorkoutSession> {
    return this.request<WorkoutSession>("/v1/sessions", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  public async recordRep(sessionId: string, event: RepEvent, idempotencyKey: string): Promise<RecordedRep> {
    const response = await this.requestWithResponse<ApiRep>(`/v1/sessions/${sessionId}/reps`, {
      method: "POST",
      body: JSON.stringify({
        idempotency_key: idempotencyKey,
        client_completed_at: new Date().toISOString(),
        features: toApiFeatures(event.features),
      }),
    });
    return {
      rep: response.payload,
      replayed: response.headers.get("Idempotent-Replay") === "true",
    };
  }

  public completeSession(sessionId: string): Promise<CompleteSessionResponse> {
    return this.request<CompleteSessionResponse>(`/v1/sessions/${sessionId}/complete`, {
      method: "POST",
    });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    return (await this.requestWithResponse<T>(path, init)).payload;
  }

  private async requestWithResponse<T>(path: string, init: RequestInit): Promise<{ payload: T; headers: Headers }> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...init.headers,
        },
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Network request failed";
      throw new ApiError(`Could not reach the RepCoach API: ${reason}`);
    }

    const payload = responseBody(await response.text());
    if (!response.ok) throw new ApiError(errorMessage(response.status, payload), response.status, payload);
    return { payload: payload as T, headers: response.headers };
  }
}

export interface PendingRepUpload {
  event: RepEvent;
  idempotencyKey: string;
}

export function makePendingRepUpload(event: RepEvent): PendingRepUpload {
  return { event, idempotencyKey: createRepIdempotencyKey() };
}
