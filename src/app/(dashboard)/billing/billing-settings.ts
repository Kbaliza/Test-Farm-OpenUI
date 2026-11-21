"use server";

import { db } from "@/lib/db";
import { requireRole, FULL_ACCESS } from "@/lib/auth";

const KEY = "billing.lastDate";

// Both actions below were missing a role guard. A "use server" export is a
// directly-invocable POST endpoint whose action id ships in the client bundle
// (these are imported by billing-client.tsx / payment-receiving-client.tsx), and
// proxy.ts only redirects GET navigations — so the setter was writable by an
// anonymous request with no cookie at all. Every other action in the app guards;
// this file was the exception.
export async function getBillingLastDate(): Promise<string | null> {
  await requireRole(FULL_ACCESS);
  try {
    const rows = await db.$queryRaw<{ value: string }[]>`
      SELECT value FROM "AppSetting" WHERE key = ${KEY} LIMIT 1
    `;
    return rows[0]?.value ?? null;
  } catch {
    return null;
  }
}

export async function setBillingLastDate(date: string): Promise<void> {
  await requireRole(FULL_ACCESS);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
  const todayPKT = new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (date > todayPKT) return;
  try {
    await db.$executeRaw`
      INSERT INTO "AppSetting" (key, value, "updatedAt")
      VALUES (${KEY}, ${date}, NOW())
      ON CONFLICT (key) DO UPDATE SET value = ${date}, "updatedAt" = NOW()
    `;
  } catch {
    // non-fatal — UI already updated optimistically
  }
}
