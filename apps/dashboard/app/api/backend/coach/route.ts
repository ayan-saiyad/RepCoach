import { NextRequest, NextResponse } from "next/server";

import { proxyBackend } from "@/lib/backend-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const revalidate = 0;

interface CoachRequest {
  question?: unknown;
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as CoachRequest | null;
  const question = body?.question;
  if (typeof question !== "string" || question.trim().length < 3 || question.length > 1_000) {
    return NextResponse.json(
      { detail: "Ask a coaching question between 3 and 1,000 characters." },
      { status: 400, headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
  }
  return proxyBackend(request, {
    method: "POST",
    path: "/v1/coach/query",
    body: (userId) => JSON.stringify({ user_id: userId, question: question.trim() }),
    requireSameOrigin: true,
  });
}
