import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { accessTokenSession, authCookieNames } from "@/lib/auth-server";
import { getRequiredServerConfig } from "@/lib/runtime-config-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const revalidate = 0;

export async function GET() {
  let config;
  try {
    config = getRequiredServerConfig();
  } catch {
    return NextResponse.json(
      { authenticated: false },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }
  if (config.demoMode) {
    return NextResponse.json(
      { authenticated: true, userId: config.demoUserId, demo: true },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }
  try {
    const token = (await cookies()).get(authCookieNames(config).accessToken)?.value;
    if (!token) throw new Error("no access token");
    const session = accessTokenSession(token);
    return NextResponse.json(
      { authenticated: true, userId: session.userId },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch {
    return NextResponse.json(
      { authenticated: false },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }
}
