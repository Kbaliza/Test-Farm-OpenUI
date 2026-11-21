import "server-only";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { addDaysToDateStr, dateStrRangePKT, pktNoonToUTC, todayPKTString } from "@/lib/pkt";
import { computeReturnsBoard, retailLeftover } from "@/lib/rider-returns-board";
import { RETAIL_RETURN_STAGE } from "@/lib/rider-return-math";
import { DAY_CLOSE_REASON } from "@/lib/missing";

// The day-end close.
//
// Every day ends empty. Whatever the retail centre is still holding at midnight,
// and whatever a rider took out and never brought back, is written off — the
// retail centre's leftover through its own day-end handback, the rider's through
// his returns — under one reason, so nothing slides silently back into stock the
// next morning.
//
//   · A rider who has not ended a round by midnight has it ended for him: the
//     round is completed and marked autoClosedAt, which the rider app reads to
//     close the shift on the phone. What he still owes back — the Rider Item
//     Returns "missing" figure — becomes his wastage.
//   · The retail centre's leftover that nobody handed back becomes Retail's
//     wastage, through an automatic day-end handback. A handback the office has
//     already saved for that day is left exactly as it is.
//
// Every entry is dated 11:59:59 PM on the day it closes. Run for a day again and
// it works the figures out afresh and replaces only what it wrote itself — a late
// return or a corrected delivery moves the write-off, never doubles it.
//
// A round that was never started is not a rider's to answer for: nobody took its
// milk, which is why it is still on the retail centre's shelf — and so in Retail's
// leftover instead.

export { DAY_CLOSE_REASON };
const AUTO_REVIEWER = "Day-end close (automatic)";
const autoToken = (date: string) => `dayclose:${date}`;

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const EPS = 0.0005;

export type DayCloseResult = {
  date: string;
  routesClosed: number;
  riderWaste: { riderId: string; productId: string; qty: number }[];
  retailWaste: { productId: string; qty: number }[];
};

/**
 * Close one day. The day must be over — closing today would empty a working shop.
 * `dryRun` works everything out and writes nothing: what the close would do.
 */
export async function closeDay(date: string, { dryRun = false }: { dryRun?: boolean } = {}): Promise<DayCloseResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date >= todayPKTString()) {
    throw new Error(`closeDay: ${date} has not ended yet`);
  }
  const range = dateStrRangePKT(date);
  const dayEnd = new Date(range.lte.getTime() - 999); // 23:59:59 PKT

  // ── 1. End the rounds the riders left open ───────────────────────────────────
  const routes = await db.route.findMany({
    where: { date: range },
    select: { id: true, status: true, autoClosedAt: true, shift: { select: { riderId: true } } },
  });
  const ids = routes.map((r) => r.id);
  const loads = ids.length
    ? await db.inventoryMovement.findMany({
        where: { type: "HANDED_OVER", reference: { in: ids }, riderId: { not: null } },
        select: { reference: true, riderId: true },
      })
    : [];
  const loadedBy = new Map<string, Set<string>>();
  for (const m of loads) {
    const set = loadedBy.get(m.reference!) ?? new Set<string>();
    set.add(m.riderId!);
    loadedBy.set(m.reference!, set);
  }
  // Started = the app moved it on, or the rider confirmed a load against it.
  const toClose = routes.filter((r) => r.status !== "COMPLETED" && (r.status === "IN_PROGRESS" || loadedBy.has(r.id)));
  if (toClose.length && !dryRun) {
    await db.route.updateMany({
      where: { id: { in: toClose.map((r) => r.id) }, status: { not: "COMPLETED" } },
      data: { status: "COMPLETED", completedAt: dayEnd, autoClosedAt: new Date() },
    });
  }
  const closedIds = new Set([...toClose.map((r) => r.id), ...routes.filter((r) => r.autoClosedAt).map((r) => r.id)]);

  // Who answers for each closed round: whoever loaded it, else the shift's rider.
  const routeOfRider = new Map<string, string>();
  for (const r of routes) {
    if (!closedIds.has(r.id)) continue;
    const riders = loadedBy.get(r.id) ?? new Set(r.shift.riderId ? [r.shift.riderId] : []);
    for (const rid of riders) if (!routeOfRider.has(rid)) routeOfRider.set(rid, r.id);
  }

  // ── 2. The figures, after the rounds are closed ─────────────────────────────
  // Read after step 1: a round closed just now holds its load from here on, and
  // both the board and Retail's leftover must see it that way.
  const [board, left, review] = await Promise.all([
    routeOfRider.size ? computeReturnsBoard(date, date) : Promise.resolve(null),
    retailLeftover(date),
    db.retailReturnReview.findUnique({
      where: { date: pktNoonToUTC(date) },
      select: { id: true, reviewedById: true, clientToken: true },
    }),
  ]);

  // The board keeps this close's earlier write-offs apart from what the rider
  // reported (row.writtenOff), so the figure below is as if it had never run.
  // A reviewer's shortfall is NOT added: the review already took it out of stock.
  const riderWaste: DayCloseResult["riderWaste"] = [];
  for (const riderId of routeOfRider.keys()) {
    const row = board?.rows.find((x) => x.date === date && x.riderId === riderId);
    if (!row) continue;
    // Exactly the Rider Item Returns page's "missing": what he took, less what
    // reached customers, less what he handed back, less what he reported wasting.
    const pids = new Set([...Object.keys(row.got), ...Object.keys(row.riderWasted)]);
    for (const pid of pids) {
      const missing = r3((row.got[pid] ?? 0) - (row.delivered[pid] ?? 0) - (row.returned[pid] ?? 0) - (row.riderWasted[pid] ?? 0));
      if (missing > EPS) riderWaste.push({ riderId, productId: pid, qty: missing });
    }
  }

  // Retail: only a handback this close made itself may be rewritten.
  const autoReview = !!review && !review.reviewedById && review.clientToken === autoToken(date);
  const manualReview = !!review && !autoReview;
  const retailWaste: DayCloseResult["retailWaste"] = manualReview
    ? []
    : [...left].filter(([, q]) => q > EPS).map(([productId, qty]) => ({ productId, qty: r3(qty) }));

  if (dryRun) return { date, routesClosed: toClose.length, riderWaste, retailWaste };

  // ── 3. Write it, replacing only this close's own rows ───────────────────────
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"dayclose:" + date}))`;

    if (routeOfRider.size) {
      await tx.inventoryMovement.deleteMany({
        where: {
          type: "WASTAGE", reason: DAY_CLOSE_REASON, stage: null, enteredById: null,
          reference: { in: ids }, riderId: { in: [...routeOfRider.keys()] },
        },
      });
      if (riderWaste.length) {
        await tx.inventoryMovement.createMany({
          data: riderWaste.map((w) => ({
            date: dayEnd,
            type: "WASTAGE" as const,
            productId: w.productId,
            quantity: new Prisma.Decimal(w.qty),
            reason: DAY_CLOSE_REASON,
            riderId: w.riderId,
            // The round it came off, so every page puts it on that round's day.
            reference: routeOfRider.get(w.riderId)!,
          })),
        });
      }
    }

    if (!manualReview) {
      let reviewId = autoReview ? review!.id : null;
      if (reviewId) {
        await tx.retailReturnLine.deleteMany({ where: { reviewId } });
        await tx.inventoryMovement.deleteMany({ where: { reference: reviewId, type: "WASTAGE" } });
        if (!retailWaste.length) {
          await tx.retailReturnReview.delete({ where: { id: reviewId } });
          reviewId = null;
        }
      } else if (retailWaste.length) {
        reviewId = (await tx.retailReturnReview.create({
          data: {
            date: pktNoonToUTC(date),
            reviewedByName: AUTO_REVIEWER,
            notes: "Nothing was handed back by midnight, so the leftover was written off.",
            clientToken: autoToken(date),
          },
          select: { id: true },
        })).id;
      }
      if (reviewId && retailWaste.length) {
        await tx.retailReturnLine.createMany({
          data: retailWaste.map((w) => ({
            reviewId: reviewId!,
            productId: w.productId,
            leftoverQty: new Prisma.Decimal(w.qty),
            stockQty: new Prisma.Decimal(0),
            wasteQty: new Prisma.Decimal(w.qty),
            wasteReason: DAY_CLOSE_REASON,
          })),
        });
        // The same shape the office's own handback writes, so every page already
        // reads it: Retail's write-off on the day, out of stock from the next.
        await tx.inventoryMovement.createMany({
          data: retailWaste.map((w) => ({
            date: dayEnd,
            type: "WASTAGE" as const,
            productId: w.productId,
            quantity: new Prisma.Decimal(w.qty),
            reason: DAY_CLOSE_REASON,
            stage: RETAIL_RETURN_STAGE,
            reference: reviewId!,
          })),
        });
      }
    }
  }, { maxWait: 10_000, timeout: 60_000 });

  return { date, routesClosed: toClose.length, riderWaste, retailWaste };
}

// ── When it runs ──────────────────────────────────────────────────────────────

// "dayEnd.*", not the "dayclose.*" these replaced: two "dayclose" rows were
// written to the live database by a test run before this went live, and a
// fresh set of keys means the first real run starts from its own deploy day.
const SINCE_KEY = "dayEnd.since";     // the first day this close is allowed to touch
const RAN_KEY = "dayEnd.ranOn";       // the PKT day it last ran on
const LAST_KEY = "dayEnd.lastClosed"; // the last day it closed
/** Days looked at again on each run, so a return handed in late still corrects them. */
const RECHECK_DAYS = 3;

async function setting(key: string): Promise<string | null> {
  return (await db.appSetting.findUnique({ where: { key } }))?.value ?? null;
}

/**
 * Close every day that is due. Called each minute by the server; does its work
 * at most once per PKT day, on the first call after midnight.
 *
 * It only ever touches days from the day it first ran, so switching it on does
 * not reach back and write off weeks of old rounds.
 */
export async function runDueDayCloses(): Promise<DayCloseResult[]> {
  const today = todayPKTString();
  const since = await setting(SINCE_KEY);
  if (!since) {
    await db.appSetting.upsert({ where: { key: SINCE_KEY }, create: { key: SINCE_KEY, value: today }, update: {} });
    return [];
  }

  // Claim today's run. One row, compared and set in one statement, so two
  // servers (or two ticks) can never both run it.
  await db.appSetting.upsert({ where: { key: RAN_KEY }, create: { key: RAN_KEY, value: "" }, update: {} });
  const claimed = await db.$executeRaw`
    UPDATE "AppSetting" SET value = ${today}, "updatedAt" = now()
    WHERE key = ${RAN_KEY} AND value < ${today}`;
  if (claimed !== 1) return [];

  const yesterday = addDaysToDateStr(today, -1);
  const prevRan = await setting(LAST_KEY);
  // From the day after the last one closed — or, if days were missed, from the
  // first missed one — and always the last few days again.
  let from = addDaysToDateStr(yesterday, -(RECHECK_DAYS - 1));
  if (prevRan && addDaysToDateStr(prevRan, 1) < from) from = addDaysToDateStr(prevRan, 1);
  if (!prevRan && since < from) from = since;
  if (from < since) from = since;

  const results: DayCloseResult[] = [];
  for (let d = from; d <= yesterday; d = addDaysToDateStr(d, 1)) {
    try {
      results.push(await closeDay(d));
      await db.appSetting.upsert({ where: { key: LAST_KEY }, create: { key: LAST_KEY, value: d }, update: { value: d } });
    } catch (e) {
      // One bad day must not stop the rest; it is looked at again tomorrow.
      console.error(`[day-close] ${d}`, e);
    }
  }
  if (results.length) {
    console.log("[day-close]", results.map((r) => `${r.date}: ${r.routesClosed} round(s) closed, ${r.riderWaste.length} rider and ${r.retailWaste.length} retail write-off line(s)`).join("; "));
  }
  return results;
}
