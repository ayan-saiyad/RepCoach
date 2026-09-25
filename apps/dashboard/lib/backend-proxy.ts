import "server-only";

import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

import { accessTokenSession, authCookieNames, clearAuthCookies } from "@/lib/auth-server";
import { getRequiredServerConfig } from "@/lib/runtime-config-server";

interface ProxyOptions {
  method: "GET" | "POST";
  path: string | ((userId: string) => string);
  body?: string | ((userId: string) => string);
  requireSameOrigin?: boolean;
}

interface BackendIdentity {
  userId: string;
  authorization: string | null;
}

function errorResponse(status: number, detail: string, config?: ReturnType<typeof getRequiredServerConfig>) {
  const response = NextResponse.json(
    { detail },
    { status, headers: { "Cache-Control": "private, no-store, max-age=0" } },
  );
  if (config) clearAuthCookies(response, config);
  return response;
}

async function backendIdentity(
  request: NextRequest,
  requireSameOrigin: boolean,
): Promise<{ config: ReturnType<typeof getRequiredServerConfig>; identity: BackendIdentity } | NextResponse> {
  let config;
  try {
    config = getRequiredServerConfig();
  } catch {
    return errorResponse(503, "Dashboard backend configuration is unavailable.");
  }
  if (requireSameOrigin && request.headers.get("origin") !== config.dashboardOrigin) {
    return errorResponse(403, "Cross-origin requests are not allowed.", config);
  }
  if (config.demoMode) {
    return {
      config,
      identity: { userId: config.demoUserId, authorization: null },
    };
  }
  try {
    const token = (await cookies()).get(authCookieNames(config).accessToken)?.value;
    if (!token) throw new Error("no access token");
    const session = accessTokenSession(token);
    return {
      config,
      identity: { userId: session.userId, authorization: `Bearer ${session.accessToken}` },
    };
  } catch {
    return errorResponse(401, "Sign-in is required.", config);
  }
}

function isResponse(value: unknown): value is NextResponse {
  return value instanceof NextResponse;
}

/**
 * Send a fixed, allow-listed request to the configured API origin. Browser
 * cookies and caller-provided authorization headers are never forwarded.
 */
export async function proxyBackend(
  request: NextRequest,
  options: ProxyOptions,
): Promise<NextResponse> {
  const context = await backendIdentity(request, options.requireSameOrigin ?? false);
  if (isResponse(context)) return context;

  const upstreamPath =
    typeof options.path === "function" ? options.path(context.identity.userId) : options.path;
  const upstreamBody =
    typeof options.body === "function" ? options.body(context.identity.userId) : options.body;
  const upstreamUrl = new URL(upstreamPath, context.config.apiBaseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (context.identity.authorization) {
      headers.Authorization = context.identity.authorization;
    } else {
      headers["X-RepCoach-Dev-User"] = context.identity.userId;
    }
    if (upstreamBody) headers["Content-Type"] = "application/json";
    const upstream = await fetch(upstreamUrl, {
      method: options.method,
      headers,
      body: upstreamBody,
      cache: "no-store",
      signal: controller.signal,
    });
    const responseHeaders = new Headers({ "Cache-Control": "private, no-store, max-age=0" });
    const contentType = upstream.headers.get("content-type");
    if (contentType) responseHeaders.set("Content-Type", contentType);
    const response = new NextResponse(await upstream.arrayBuffer(), {
      status: upstream.status,
      headers: responseHeaders,
    });
    if (upstream.status === 401) clearAuthCookies(response, context.config);
    return response;
  } catch {
    return errorResponse(502, "RepCoach API is temporarily unavailable.");
  } finally {
    clearTimeout(timeout);
  }
}
