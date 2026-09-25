import { demoDashboardData } from "@/lib/demo-data";
import type {
  CoachReply,
  DashboardData,
  DashboardSummary,
  SessionDetail,
} from "@/lib/types";

export const API_ORIGIN = (
  process.env.NEXT_PUBLIC_API_BASE_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:8000"
).replace(/\/$/, "");
export const DASHBOARD_USER_ID = process.env.NEXT_PUBLIC_DEMO_USER_ID ?? "demo-athlete";
const REQUEST_TIMEOUT_MS = 3_500;

class ApiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiUnavailableError";
  }
}

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${API_ORIGIN}${path}`, {
      ...init,
      headers: { Accept: "application/json", ...init.headers },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new ApiUnavailableError(`The API returned ${response.status}.`);
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof ApiUnavailableError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new ApiUnavailableError("The API took too long to respond.");
    }
    throw new ApiUnavailableError("Could not reach the API.");
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function loadDashboard(): Promise<DashboardData> {
  try {
    const summary = await apiFetch<DashboardSummary>(`/v1/dashboard/${encodeURIComponent(DASHBOARD_USER_ID)}/summary`);
    const newestSession = summary.recent_sessions[0];
    const latestSession = newestSession
      ? await apiFetch<SessionDetail>(`/v1/sessions/${encodeURIComponent(newestSession.id)}`)
      : null;

    return { summary, latestSession, usingDemoData: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not reach the API.";
    return { ...demoDashboardData, message: `${demoDashboardData.message} ${message}` };
  }
}

export async function loadSessionDetail(sessionId: string): Promise<SessionDetail> {
  return apiFetch<SessionDetail>(`/v1/sessions/${encodeURIComponent(sessionId)}`);
}

export async function askCoach(question: string): Promise<CoachReply> {
  return apiFetch<CoachReply>("/v1/coach/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: DASHBOARD_USER_ID, question }),
  });
}

export { ApiUnavailableError };
