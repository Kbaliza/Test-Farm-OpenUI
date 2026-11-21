import { NextResponse } from "next/server";
import { db } from "@/lib/db";

// Liveness/readiness probe for Docker and the deploy workflow.
//
// proxy.ts excludes /api/ from its matcher, so this is a PUBLIC endpoint —
// it deliberately returns nothing beyond ok/not-ok. No version, no error text,
// no DB details.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // Cheapest possible round-trip: proves the pooler connection is alive, which
    // is what actually breaks in production.
    await db.$queryRaw`SELECT 1`;
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}
