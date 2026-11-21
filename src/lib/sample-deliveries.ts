// Free samples are not customers, so a delivered sample writes no DeliveryEntry.
// Its milk still left the van: the Rider Item Returns board, the day-end close
// and the reconciliation must count it as delivered, or a rider who carried a
// sample reads that milk as missing — and the midnight close writes it off as
// his wastage.

import "server-only";

import { db } from "@/lib/db";
import { toDateStrPKT, type DateRangePKT } from "@/lib/pkt";

/**
 * Samples count as delivered from this day on. Earlier days were reviewed and
 * closed without them, and are left exactly as they were.
 */
export const SAMPLES_COUNTED_FROM = "2026-10-30";

export type SampleDelivery = { date: string; shiftId: string; productId: string; qty: number };

/** The items of every sample delivered in the range, on the day it was delivered. */
export async function sampleDeliveries(range: DateRangePKT): Promise<SampleDelivery[]> {
  const rows = await db.sampleLead.findMany({
    where: {
      shiftId: { not: null },
      // Delivered and still delivered: a resend puts it back to ASSIGNED, and a
      // failed run is NOT_DELIVERED.
      status: { in: ["DELIVERED", "FOLLOWUP", "CONVERTED", "DECLINED"] },
      OR: [{ riderOutcomeAt: range }, { deliveredAt: range }],
    },
    select: {
      shiftId: true, riderOutcome: true, riderOutcomeAt: true, deliveredAt: true,
      items: { select: { productId: true, quantity: true } },
    },
  });
  const lo = toDateStrPKT(range.gte), hi = toDateStrPKT(range.lte);
  const out: SampleDelivery[] = [];
  for (const s of rows) {
    // The rider's own report is the moment it happened; the office's stamp is
    // the fallback (it can be set later, from the round's end).
    const at = s.riderOutcome === "DELIVERED" && s.riderOutcomeAt ? s.riderOutcomeAt : s.deliveredAt;
    if (!at || !s.shiftId) continue;
    const date = toDateStrPKT(at);
    if (date < lo || date > hi || date < SAMPLES_COUNTED_FROM) continue;
    for (const it of s.items) {
      const qty = Number(it.quantity);
      if (qty > 0) out.push({ date, shiftId: s.shiftId, productId: it.productId, qty });
    }
  }
  return out;
}
