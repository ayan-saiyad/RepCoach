import { NextRequest } from "next/server";

import { proxyBackend } from "@/lib/backend-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const revalidate = 0;

const SESSION_ID = /^[A-Za-z0-9-]{1,64}$/;

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await context.params;
  if (!SESSION_ID.test(sessionId)) {
    return Response.json(
      { detail: "Session was not found." },
      { status: 404, headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  }
  return proxyBackend(request, {
    method: "GET",
    path: `/v1/sessions/${encodeURIComponent(sessionId)}`,
  });
}
