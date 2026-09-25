import { NextResponse } from "next/server";

import { clearAuthCookies } from "@/lib/auth-server";
import { getServerRuntimeConfig } from "@/lib/runtime-config-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const revalidate = 0;

export async function GET(request: Request) {
  const config = getServerRuntimeConfig();
  const destination = config.cognito
    ? new URL("/logout", config.cognito.hostedUiUrl)
    : new URL("/", request.url);
  if (config.cognito) {
    destination.search = new URLSearchParams({
      client_id: config.cognito.clientId,
      logout_uri: config.cognito.logoutUri,
    }).toString();
  }
  const response = NextResponse.redirect(destination);
  clearAuthCookies(response, config);
  response.headers.set("Cache-Control", "no-store, max-age=0");
  return response;
}
