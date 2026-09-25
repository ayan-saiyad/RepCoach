import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

import {
  authCookieNames,
  clearAuthCookies,
  exchangeAuthorizationCode,
  persistAccessToken,
  stateMatches,
} from "@/lib/auth-server";
import { getRequiredServerConfig } from "@/lib/runtime-config-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const revalidate = 0;

function errorRedirect(request: NextRequest, reason: string, config?: ReturnType<typeof getRequiredServerConfig>) {
  const response = NextResponse.redirect(new URL(`/auth/error?reason=${reason}`, request.url));
  if (config) clearAuthCookies(response, config);
  response.headers.set("Cache-Control", "no-store, max-age=0");
  return response;
}

export async function GET(request: NextRequest) {
  let config;
  try {
    config = getRequiredServerConfig();
  } catch {
    return errorRedirect(request, "configuration");
  }
  if (config.demoMode || !config.cognito) return errorRedirect(request, "configuration", config);

  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const providerError = request.nextUrl.searchParams.get("error");
  const store = await cookies();
  const names = authCookieNames(config);
  const expectedState = store.get(names.oauthState)?.value;
  const verifier = store.get(names.oauthVerifier)?.value;
  if (providerError || !code || !state || !verifier || !stateMatches(expectedState, state)) {
    return errorRedirect(request, "callback", config);
  }

  try {
    const session = await exchangeAuthorizationCode(config, code, verifier);
    const response = NextResponse.redirect(new URL("/", request.url));
    clearAuthCookies(response, config);
    persistAccessToken(response, config, session);
    response.headers.set("Cache-Control", "no-store, max-age=0");
    return response;
  } catch {
    return errorRedirect(request, "exchange", config);
  }
}
