import { NextResponse } from "next/server";

import { startPkceChallenge } from "@/lib/auth-server";
import { getRequiredServerConfig } from "@/lib/runtime-config-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const revalidate = 0;

function errorRedirect(request: Request): NextResponse {
  return NextResponse.redirect(new URL("/auth/error?reason=configuration", request.url));
}

export async function GET(request: Request) {
  let config;
  try {
    config = getRequiredServerConfig();
  } catch {
    return errorRedirect(request);
  }
  if (config.demoMode || !config.cognito) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  const response = NextResponse.redirect(new URL(config.cognito.hostedUiUrl));
  const { challenge, state } = startPkceChallenge(response, config);
  const authorizeUrl = new URL("/oauth2/authorize", config.cognito.hostedUiUrl);
  authorizeUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: config.cognito.clientId,
    redirect_uri: config.cognito.redirectUri,
    scope: config.cognito.scopes.join(" "),
    state,
    code_challenge_method: "S256",
    code_challenge: challenge,
  }).toString();
  response.headers.set("Location", authorizeUrl.toString());
  response.headers.set("Cache-Control", "no-store, max-age=0");
  return response;
}
