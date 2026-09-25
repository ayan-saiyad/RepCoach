import { demoDashboardData } from "@/lib/demo-data";
import type { RuntimeConfig } from "@/lib/runtime-config";
import type {
  CoachReply,
  DashboardData,
  DashboardSummary,
  SessionDetail,
} from "@/lib/types";

const REQUEST_TIMEOUT_MS = 5_000;

export interface DashboardApiContext {
  config: RuntimeConfig;
}

export class ApiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiUnavailableError";
  }
}

export class ApiAuthenticationError extends Error {
  constructor(message = "Your sign-in session has expired.") {
    super(message);
    this.name = "ApiAuthenticationError";
  }
}

export class ApiAccessDeniedError extends Error {
  constructor(message = "You do not have access to this athlete data.") {
    super(message);
    this.name = "ApiAccessDeniedError";
  }
}

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`/api/backend${path}`, {
      ...init,
      headers: { Accept: "application/json", ...init.headers },
      cache: "no-store",
      signal: controller.signal,
    });
    if (response.status === 401) throw new ApiAuthenticationError();
    if (response.status === 403) throw new ApiAccessDeniedError();
    if (!response.ok) {
      throw new ApiUnavailableError(`The RepCoach API returned ${response.status}.`);
    }
    return (await response.json()) as T;
  } catch (error) {
    if (
      error instanceof ApiUnavailableError ||
      error instanceof ApiAuthenticationError ||
      error instanceof ApiAccessDeniedError
    ) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new ApiUnavailableError("The RepCoach API took too long to respond.");
    }
    throw new ApiUnavailableError("Could not reach the RepCoach API.");
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function loadDashboard(context: DashboardApiContext): Promise<DashboardData> {
  try {
    const summary = await apiFetch<DashboardSummary>("/dashboard/summary");
    const newestSession = summary.recent_sessions[0];
    const latestSession = newestSession
      ? await apiFetch<SessionDetail>(`/sessions/${encodeURIComponent(newestSession.id)}`)
      : null;
    return { summary, latestSession, usingDemoData: false };
  } catch (error) {
    if (!context.config.demoMode) throw error;
    const message = error instanceof Error ? error.message : "Could not reach the RepCoach API.";
    return {
      ...demoDashboardData,
      message: `Demo mode is enabled. ${message}`,
    };
  }
}

export async function loadSessionDetail(sessionId: string): Promise<SessionDetail> {
  return apiFetch<SessionDetail>(`/sessions/${encodeURIComponent(sessionId)}`);
}

export async function askCoach(question: string): Promise<CoachReply> {
  return apiFetch<CoachReply>("/coach", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  });
}
