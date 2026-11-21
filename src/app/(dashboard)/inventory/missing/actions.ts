"use server";

// The Missing log: milk that went out and never came back, by whose hands it
// was last in.
//
//   · A rider's: what he took, less what reached customers, less what he handed
//     back, less what he reported wasting — plus anything the reviewer said he
//     never actually handed over. The same arithmetic as the Rider Item Returns
//     board's "missing", one line per rider, day and product.
//   · The retail centre's: what it still held when the day closed and nobody
//     handed back — written off by the day-end close under DAY_CLOSE_REASON.
//
// Written off or not, missing is missing: a rider's line stays on this log after
// midnight has taken it out of stock, marked as written off.

import { requireRole, FULL_ACCESS } from "@/lib/auth";
import { db } from "@/lib/db";
import { addDaysToDateStr, dateRangeFromToPKT, toDateStrPKT, todayPKTString } from "@/lib/pkt";
import { computeReturnsBoard, retailLeftover } from "@/lib/rider-returns-board";
import { DAY_CLOSE_REASON } from "@/lib/missing";
import { RETAIL_RETURN_STAGE } from "@/lib/rider-return-math";

const PAGE_ROLES = [...FULL_ACCESS, "PACKAGING", "RETAIL_MANAGER"] as const;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

export type MissingRow = {
  key: string;
  date: string;
  kind: "rider" | "retail";
  /** The rider, or "Retail centre". */
  who: string;
  productId: string;
  product: string;
  unit: string;
  /** Rider lines only; null on a retail line. */
  took: number | null;
  delivered: number | null;
  returned: number | null;
  riderWasted: number | null;
  /** What the reviewer said was never handed over, out of the app's return. */
  reviewMissing: number | null;
  missing: number;
  /** written-off: the day-end close took it out of stock. open: a rider's day
   *  not closed yet. pending: today's retail leftover, the close has not run. */
  status: "written-off" | "open" | "pending";
};

export type MissingLog = { from: string; to: string; rows: MissingRow[]; dbReady: boolean };

export async function getMissingLog(from: string, to: string): Promise<MissingLog> {
  await requireRole([...PAGE_ROLES]);
  const today = todayPKTString();
  const t = DAY.test(to) ? to : today;
  const f = DAY.test(from) ? from : addDaysToDateStr(t, -6);
  const [lo, hi] = f <= t ? [f, t] : [t, f];
  try {
    const [board, retailRows, products] = await Promise.all([
      computeReturnsBoard(lo, hi),
      db.inventoryMovement.findMany({
        where: { type: "WASTAGE", reason: DAY_CLOSE_REASON, stage: RETAIL_RETURN_STAGE, date: dateRangeFromToPKT(lo, hi) },
        select: { date: true, productId: true, quantity: true },
      }),
      db.product.findMany({ select: { id: true, name: true, unit: true } }),
    ]);
    const meta = new Map(products.map((p) => [p.id, p]));
    const rows: MissingRow[] = [];

    for (const r of board.rows) {
      const pids = new Set([...Object.keys(r.got), ...Object.keys(r.returned), ...Object.keys(r.riderWasted), ...Object.keys(r.reviewMissing)]);
      for (const pid of pids) {
        const p = meta.get(pid);
        if (!p) continue;
        const took = r.got[pid] ?? 0, delivered = r.delivered[pid] ?? 0, returned = r.returned[pid] ?? 0;
        const riderWasted = r.riderWasted[pid] ?? 0, reviewMissing = r.reviewMissing[pid] ?? 0;
        const missing = r3(took - delivered - returned - riderWasted + reviewMissing);
        if (missing <= 0.0005) continue;
        rows.push({
          key: `rider:${r.date}:${r.riderId ?? "norider"}:${pid}`, date: r.date, kind: "rider", who: r.riderName,
          productId: pid, product: p.name, unit: p.unit, took: r3(took), delivered: r3(delivered), returned: r3(returned),
          riderWasted: r3(riderWasted), reviewMissing: r3(reviewMissing), missing,
          status: (r.writtenOff[pid] ?? 0) > 0.0005 ? "written-off" : "open",
        });
      }
    }

    // Retail: what the day-end close wrote off, one line per day and product.
    const retail = new Map<string, { date: string; productId: string; qty: number }>();
    for (const m of retailRows) {
      const date = toDateStrPKT(m.date);
      const k = `${date}:${m.productId}`;
      const cur = retail.get(k) ?? { date, productId: m.productId, qty: 0 };
      cur.qty += Number(m.quantity);
      retail.set(k, cur);
    }
    for (const x of retail.values()) {
      const p = meta.get(x.productId);
      if (!p || x.qty <= 0.0005) continue;
      rows.push({ key: `retail:${x.date}:${x.productId}`, date: x.date, kind: "retail", who: "Retail centre", productId: x.productId, product: p.name, unit: p.unit, took: null, delivered: null, returned: null, riderWasted: null, reviewMissing: null, missing: r3(x.qty), status: "written-off" });
    }
    // Today is not closed yet: what Retail still holds would be written off at
    // midnight unless someone hands it back first.
    if (hi >= today && lo <= today) {
      const left = await retailLeftover(today);
      for (const [pid, qty] of left) {
        const p = meta.get(pid);
        if (!p || qty <= 0.0005) continue;
        rows.push({ key: `retail:${today}:${pid}:pending`, date: today, kind: "retail", who: "Retail centre", productId: pid, product: p.name, unit: p.unit, took: null, delivered: null, returned: null, riderWasted: null, reviewMissing: null, missing: r3(qty), status: "pending" });
      }
    }

    rows.sort((a, b) => b.date.localeCompare(a.date) || a.kind.localeCompare(b.kind) || a.who.localeCompare(b.who) || a.product.localeCompare(b.product));
    return { from: lo, to: hi, rows, dbReady: true };
  } catch (e) {
    console.error("[getMissingLog]", e);
    return { from: lo, to: hi, rows: [], dbReady: false };
  }
}
