import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { NextResponse } from "next/server";

import type { DashboardServerConfig } from "@/lib/runtime-config-server";

const SUBJECT_PATTERN = /^[A-Za-z0-9-]{8,128}$/;

export interface AuthCookieNames {
  accessToken: string;
  oauthState: string;
  oauthVerifier: string;
}

export interface AccessTokenSession {
  accessToken: string;
  userId: string;
  expiresAt: number;
}

interface CognitoTokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
}

export class ServerAuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerAuthenticationError";
  }
}

export function authCookieNames(config: DashboardServerConfig): AuthCookieNames {
  const prefix = config.secureCookies ? "__Host-repcoach-" : "repcoach-";
  return {
    accessToken: `${prefix}access-token`,
    oauthState: `${prefix}oauth-state`,
    oauthVerifier: `${prefix}oauth-verifier`,
  };
}

function cookieOptions(config: DashboardServerConfig, maxAge: number) {
  return {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "lax" as const,
    path: "/",
    maxAge,
  };
}

export function clearAuthCookies(response: NextResponse, config: DashboardServerConfig): void {
  const names = authCookieNames(config);
  for (const name of Object.values(names)) {
    response.cookies.set(name, "", cookieOptions(config, 0));
  }
}

export function startPkceChallenge(
  response: NextResponse,
  config: DashboardServerConfig,
): { state: string; challenge: string } {
  const names = authCookieNames(config);
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  response.cookies.set(names.oauthState, state, cookieOptions(config, 10 * 60));
  response.cookies.set(names.oauthVerifier, verifier, cookieOptions(config, 10 * 60));
  return { state, challenge };
}

export function stateMatches(expected: string | undefined, actual: string | null): boolean {
  if (!expected || !actual) return false;
  const expectedValue = Buffer.from(expected);
  const actualValue = Buffer.from(actual);
  return (
    expectedValue.length === actualValue.length && timingSafeEqual(expectedValue, actualValue)
  );
}

function parseJwtPayload(accessToken: string): Record<string, unknown> {
  const parts = accessToken.split(".");
  if (parts.length !== 3) throw new ServerAuthenticationError("Invalid access token.");
  try {
    const parsed: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new ServerAuthenticationError("Invalid access token.");
  }
}

export function accessTokenSession(accessToken: string): AccessTokenSession {
  const claims = parseJwtPayload(accessToken);
  const userId = claims.sub;
  const expiresAt = claims.exp;
  if (
    claims.token_use !== "access" ||
    typeof userId !== "string" ||
    !SUBJECT_PATTERN.test(userId) ||
    typeof expiresAt !== "number" ||
    expiresAt <= Math.floor(Date.now() / 1_000) + 30
  ) {
    throw new ServerAuthenticationError("Access token is invalid or expired.");
  }
  return { accessToken, userId, expiresAt };
}

export async function exchangeAuthorizationCode(
  config: DashboardServerConfig,
  code: string,
  verifier: string,
): Promise<AccessTokenSession> {
  if (!config.cognito || code.length < 8 || code.length > 4_096) {
    throw new ServerAuthenticationError("The sign-in callback is invalid.");
  }
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.cognito.clientId,
    code,
    redirect_uri: config.cognito.redirectUri,
    code_verifier: verifier,
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`${config.cognito.hostedUiUrl}/oauth2/token`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new ServerAuthenticationError("Sign-in could not be completed.");
    const payload = (await response.json()) as CognitoTokenResponse;
    if (typeof payload.access_token !== "string" || typeof payload.expires_in !== "number") {
      throw new ServerAuthenticationError("The identity provider returned an invalid token response.");
    }
    const session = accessTokenSession(payload.access_token);
    const providerExpiry = Math.floor(Date.now() / 1_000) + Math.floor(payload.expires_in);
    if (providerExpiry < session.expiresAt) session.expiresAt = providerExpiry;
    return session;
  } catch (error) {
    if (error instanceof ServerAuthenticationError) throw error;
    throw new ServerAuthenticationError("The identity provider is unavailable.");
  } finally {
    clearTimeout(timeout);
  }
}

export function persistAccessToken(
  response: NextResponse,
  config: DashboardServerConfig,
  session: AccessTokenSession,
): void {
  const secondsUntilExpiry = Math.max(1, session.expiresAt - Math.floor(Date.now() / 1_000));
  response.cookies.set(
    authCookieNames(config).accessToken,
    session.accessToken,
    cookieOptions(config, secondsUntilExpiry),
  );
}
