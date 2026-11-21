"use server";

import { requireRole, FULL_ACCESS } from "@/lib/auth";

import { db } from "@/lib/db";
import { getOverdueChecklists } from "@/lib/checklists";
import { getOverdueRetailFollowups } from "@/lib/retail-overdue";

/** Which board column an alert belongs to. Everything new defaults to "other",
 *  so an alert added later still appears instead of being silently dropped. */
export type AlertCategory = "checklist" | "riderCash" | "retail" | "other";

export type AppAlert = {
  id: string;
  title: string;
  message: string;
  severity: "info" | "warning" | "critical";
  category: AlertCategory;
  link?: string;
};

export async function getAlerts(): Promise<{ alerts: AppAlert[]; dbReady: boolean }> {
  await requireRole(FULL_ACCESS);
  try {
    const alerts: AppAlert[] = [];

    // Cash riders have collected that nobody has confirmed receiving.
    //
    // Keyed on receivedAt alone, NOT on handedOverAt as well. Rider Cash is a cashbox:
    // until a manager confirms receipt this money is in no payment head at all, so a
    // collection the rider marked "handed over" in the app but that never got confirmed
    // is just as unaccounted-for as one they never marked. Filtering on handedOverAt
    // hid exactly those rows.
    const pendingCount = await db.payment.count({
      where: { head: "RIDER_CASH", receivedAt: null },
    });
    if (pendingCount > 0) {
      alerts.push({
        id: "rider-cash-pending",
        category: "riderCash",
        title: "Rider Cash — Not Yet Received",
        message: `${pendingCount} collection${pendingCount !== 1 ? "s" : ""} still with rider${pendingCount !== 1 ? "s" : ""} — not in any account until you confirm receipt.`,
        severity: "warning",
        link: "/payments/rider-cash",
      });
    }

    // Daily checklists past their due time and not yet finished today.
    const overdueChecklists = await getOverdueChecklists();
    for (const c of overdueChecklists) {
      alerts.push({
        id: `checklist-overdue-${c.id}`,
        category: "checklist",
        title: "Checklist overdue",
        message: `${c.assigneeName} hasn't finished "${c.title}" (due ${c.dueTime}).`,
        severity: "warning",
        link: "/checklists",
      });
    }

    // Retail marts still holding product past the day we said we would check back.
    const overdueRetail = await getOverdueRetailFollowups();
    for (const r of overdueRetail) {
      alerts.push({
        id: `retail-followup-${r.id}`,
        category: "retail",
        title: "Mart visit overdue",
        message: `${r.martName} still has product from ${r.placementNo} — due to check back ${r.dueDate}, ${r.daysLate} day${r.daysLate !== 1 ? "s" : ""} ago.`,
        severity: "warning",
        link: "/retail",
      });
    }

    return { alerts, dbReady: true };
  } catch (e) {
    console.error("[getAlerts]", e);
    return { alerts: [], dbReady: false };
  }
}

export async function getAlertCount(): Promise<number> {
  await requireRole(FULL_ACCESS);
  try {
    const { alerts } = await getAlerts();
    return alerts.length;
  } catch {
    return 0;
  }
}
