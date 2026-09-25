import { NextRequest } from "next/server";

import { proxyBackend } from "@/lib/backend-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const revalidate = 0;

export async function GET(request: NextRequest) {
  return proxyBackend(request, {
    method: "GET",
    path: (userId) => `/v1/dashboard/${encodeURIComponent(userId)}/summary`,
  });
}
