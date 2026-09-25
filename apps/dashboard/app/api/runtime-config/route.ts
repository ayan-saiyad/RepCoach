import { NextResponse } from "next/server";

import { getRuntimeConfig } from "@/lib/runtime-config-server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(getRuntimeConfig(), {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
