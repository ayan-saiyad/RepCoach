import type { RuntimeConfig } from "@/lib/runtime-config";

export interface DashboardIdentity {
  userId: string;
  kind: "cognito" | "demo";
}

interface SessionResponse {
  authenticated?: unknown;
  userId?: unknown;
}

export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthenticationError";
  }
}

export function demoIdentity(config: RuntimeConfig): DashboardIdentity {
  return { kind: "demo", userId: config.demoUserId };
}

/** Read only the verified subject exposed by the same-origin auth session route. */
export async function readCognitoIdentity(): Promise<DashboardIdentity | null> {
  let response: Response;
  try {
    response = await fetch("/api/auth/session", { cache: "no-store" });
  } catch {
    throw new AuthenticationError("Could not verify your sign-in session.");
  }
  if (!response.ok) {
    throw new AuthenticationError("Could not verify your sign-in session.");
  }
  const payload = (await response.json()) as SessionResponse;
  if (payload.authenticated !== true) return null;
  if (typeof payload.userId !== "string" || !payload.userId) {
    throw new AuthenticationError("Your sign-in session is invalid.");
  }
  return { kind: "cognito", userId: payload.userId };
}

export function startCognitoLogin(): void {
  window.location.assign("/api/auth/login");
}

export function logout(): void {
  window.location.assign("/api/auth/logout");
}
