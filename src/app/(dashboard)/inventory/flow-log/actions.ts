"use server";

// The Flow Log: one day of the farm, start to finish, with the time of every step.
//
// Production, packaging, the riders going out and the leftover coming back are each
// already recorded somewhere. What nobody could see was the DAY — whether the
// morning milking was late, when the first rider actually left, how long the round
// took, and whether the returns were ever accepted. This reads those rows and lays
// them out in order against the schedule they are supposed to keep. What each
// rider owes back is the Rider Item Returns page's business, not this one's.

import { requireRole, FULL_ACCESS } from "@/lib/auth";
import { db } from "@/lib/db";
import { isEggName } from "@/lib/product-names";
import { addDaysToDateStr, dateRangeFromToPKT, toDateStrPKT, todayPKTString } from "@/lib/pkt";
import { END_OF_SHIFT_RETURN_REASON } from "@/lib/rider-stock";
import { revalidatePath } from "next/cache";
import { FLOW_DEADLINES_KEY, deadlinesComplete, normaliseDeadlines, type FlowDeadlines } from "@/lib/flow-deadlines";

/** A step with a time, or a step that has not happened. */
export type FlowStep = {
  /** "prod:0", "acc:0", "pack:1", "racc:1", "egg", "dispatch", "rider:recv", "returns". */
  key: string;
  label: string;
  /** "HH:MM" PKT, or null when the step was never done. */
  at: string | null;
  /** What it moved, in its own unit. Null for a step that carries no quantity. */
  qty: number | null;
  unit: string | null;
  /** Eggs are shown apart from the milk at the same stage. */
  egg?: boolean;
  /** What the quantity is made of, e.g. "Cow Milk 163.8 L · Pure Buffalo 40 L". */
  detail?: string;
};

export type FlowRider = {
  riderId: string | null;
  name: string;
  /** The four stamps, each "HH:MM" PKT or null. */
  recv: string | null;
  start: string | null;
  end: string | null;
  ret: string | null;
  /** Litres of milk he took and handed back, for the card's own line. */
  load: number;
  delivered: number;
  returned: number;
};

export type FlowDay = {
  date: string;
  production: FlowStep[];
  /** Packaging accepting each load from the farm into its stock. */
  accepted: FlowStep[];
  packaging: FlowStep[];
  /** Retail accepting each send, in the same order as `packaging`'s sends. */
  retailAccepted: FlowStep[];
  dispatch: FlowStep;
  returnsAccepted: FlowStep;
  riders: FlowRider[];
  /** The Rider Item Returns figures for this day, reused verbatim. */
};

export type FlowLog = {
  from: string;
  to: string;
  days: FlowDay[];
  dbReady: boolean;
  error?: string;
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const PAGE_ROLES = [...FULL_ACCESS, "PACKAGING", "RETAIL_MANAGER"] as const;

/** "HH:MM" in PKT from a stored instant. */
function clockPKT(d: Date): string {
  return new Date(d).toLocaleTimeString("en-GB", {
    timeZone: "Asia/Karachi", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

export async function getFlowLog(from: string, to: string): Promise<FlowLog> {
  await requireRole([...PAGE_ROLES]);
  const today = todayPKTString();
  // Opens on today; a wider window is a filter the reader chooses.
  const f = DAY_RE.test(from) ? from : today;
  const t = DAY_RE.test(to) ? to : today;
  const [lo, hi] = f <= t ? [f, t] : [t, f];
  const blank: FlowLog = { from: lo, to: hi, days: [], dbReady: true };

  try {
    const range = dateRangeFromToPKT(lo, hi);

    const [products, prodLogs, dispatches, handed, returned, deliveries, reviews, farmLoads] =
      await Promise.all([
        db.product.findMany({ select: { id: true, name: true, unit: true } }),
        db.productionLog.findMany({
          where: { date: range },
          select: { date: true, createdAt: true, quantity: true, productId: true, shift: { select: { name: true } } },
          orderBy: { createdAt: "asc" },
        }),
        // A send to Retail is the packaging step finishing.
        db.retailDispatch.findMany({
          where: { date: range },
          select: { id: true, date: true, createdAt: true, declaredItems: true, receivedItems: true, status: true, confirmedAt: true },
          orderBy: { createdAt: "asc" },
        }),
        db.inventoryMovement.findMany({
          where: { type: "HANDED_OVER", date: range },
          select: { date: true, createdAt: true, quantity: true, productId: true, riderId: true },
        }),
        db.inventoryMovement.findMany({
          where: { type: "RETURNED", reason: END_OF_SHIFT_RETURN_REASON, date: range },
          select: { date: true, createdAt: true, quantity: true, productId: true, riderId: true },
        }),
        // Only the stamps matter here, so the rows are kept as small as possible.
        db.deliveryEntry.findMany({
          where: { date: range },
          select: { date: true, createdAt: true, quantity: true, productId: true, riderId: true, isReturn: true, isReplacement: true, customer: { select: { shiftId: true } } },
        }),
        db.riderReturnReview.findMany({
          where: { date: range },
          select: { date: true, createdAt: true },
          orderBy: { createdAt: "asc" },
        }),
        // Packaging accepting the farm's loads: the moment is acceptedAt, the
        // litres are the ARRIVED rows it wrote.
        db.farmDispatch.findMany({
          where: { acceptedAt: range },
          select: { id: true, acceptedAt: true },
          orderBy: { acceptedAt: "asc" },
        }),
      ]);
      const acceptedQty = new Map<string, number>();
      if (farmLoads.length) {
        const rows = await db.inventoryMovement.findMany({
          where: { type: "ARRIVED", reference: { in: farmLoads.map((f) => f.id) } },
          select: { reference: true, productId: true, quantity: true },
        });
        for (const m of rows) if (m.reference) acceptedQty.set(m.reference, (acceptedQty.get(m.reference) ?? 0) + Number(m.quantity));
      }
      // Sends Retail accepted before the time was recorded: the change log has it.
      const needTime = dispatches.filter((d) => d.status !== "PENDING" && !d.confirmedAt).map((d) => d.id);
      const auditTime = new Map<string, Date>();
      if (needTime.length) {
        const logs = await db.auditLog.findMany({
          where: { tableName: "RetailDispatch", operation: "UPDATE", rowId: { in: needTime }, changedFields: { has: "status" } },
          select: { rowId: true, at: true },
          orderBy: { at: "asc" },
        });
        for (const l of logs) if (l.rowId && !auditTime.has(l.rowId)) auditTime.set(l.rowId, l.at);
      }

    const unitOf = new Map(products.map((p) => [p.id, p.unit as string]));
    const milkIn = (items: unknown) =>
        ((items as { productId: string; quantity: number }[] | null) ?? []).reduce((t, it) => t + (milkIds.has(it.productId) ? Number(it.quantity) : 0), 0);
    const nameOf = new Map(products.map((p) => [p.id, p.name]));
    const isEgg = new Map(products.map((p) => [p.id, isEggName(p.name)]));
    const milkIds = new Set(products.filter((p) => p.unit === "LITER").map((p) => p.id));

    const shiftRider = new Map(
      (await db.shift.findMany({ select: { id: true, riderId: true } })).map((s) => [s.id, s.riderId])
    );
    const riderNames = new Map(
      (await db.rider.findMany({ select: { id: true, user: { select: { name: true } } } }))
        .map((r) => [r.id, r.user?.name ?? "Rider"])
    );

    /** Every day in the window, newest first, so an empty day still shows. */
    const dates: string[] = [];
    for (let d = hi; d >= lo; d = addDaysToDateStr(d, -1)) dates.push(d);

    const days: FlowDay[] = dates.map((date) => {
      const on = <T extends { date: Date }>(rows: T[]) => rows.filter((r) => toDateStrPKT(r.date) === date);

      // ── Production: each milking in the order it was recorded ──────────────
      // One save of the milk entry is one milking: it writes a row per product
      // (cow, buffalo) under the same instant. Read row by row, a single milking
      // showed up as two — "Milking 1" and "Milking 2" at the same minute.
      const myProd = on(prodLogs).filter((p) => milkIds.has(p.productId));
      const milkings: (typeof myProd)[] = [];
      for (const p of myProd) {
        const last = milkings[milkings.length - 1];
        if (last && last[0].createdAt.getTime() === p.createdAt.getTime()) last.push(p);
        else milkings.push([p]);
      }
      const production: FlowStep[] = milkings.map((rows, i) => ({
        key: `prod:${i}`,
        label: `Milking ${i + 1}`,
        at: clockPKT(rows[0].createdAt),
        qty: rows.reduce((t, r) => t + Number(r.quantity), 0),
        unit: "L",
        detail: rows.length > 1
          ? rows.map((r) => `${nameOf.get(r.productId) ?? "Milk"} ${Math.round(Number(r.quantity) * 100) / 100} L`).join(" · ")
          : nameOf.get(rows[0].productId),
      }));
      // A milking that never happened still has a target to miss — the page adds
      // one not-done step for each deadline left without a milking.

      // ── Packaging acceptance: each farm load taken into packaging's stock ──
      const accepted: FlowStep[] = farmLoads
        .filter((f) => f.acceptedAt && toDateStrPKT(f.acceptedAt) === date)
        .map((f, i) => ({ key: `acc:${i}`, label: `Accepted at packaging ${i + 1}`, at: clockPKT(f.acceptedAt!), qty: Math.round((acceptedQty.get(f.id) ?? 0) * 100) / 100, unit: "L" }));

      // ── Packaging: each send to Retail, plus eggs as their own steps ───────
      const myDisp = on(dispatches);
      const packaging: FlowStep[] = [];
      // ── Retail acceptance: the same sends, when Retail took them in ────────
      const retailAccepted: FlowStep[] = myDisp.map((d, i) => {
        const when = d.confirmedAt ?? auditTime.get(d.id) ?? null;
        const qty = d.receivedItems ? milkIn(d.receivedItems) : milkIn(d.declaredItems);
        return { key: `racc:${i}`, label: `Retail accepted send ${i + 1}`, at: when ? clockPKT(when) : null, qty: when ? qty : null, unit: "L", detail: d.status === "DISPUTED" ? "Disputed — less arrived than was sent" : undefined };
      });
      let eggCollected: { at: string; qty: number } | null = null as { at: string; qty: number } | null;
      myDisp.forEach((d, i) => {
        const items = (d.declaredItems as { productId: string; quantity: number }[] | null) ?? [];
        let milk = 0, eggs = 0;
        for (const it of items) {
          if (isEgg.get(it.productId)) eggs += Number(it.quantity);
          else if (milkIds.has(it.productId)) milk += Number(it.quantity);
        }
        packaging.push({ key: `pack:${i}`, label: `Send to Retail ${i + 1}`, at: clockPKT(d.createdAt), qty: milk, unit: "L" });
        if (eggs > 0 && eggCollected === null) eggCollected = { at: clockPKT(d.createdAt), qty: eggs };
      });
      // Eggs: one step. The same person collects and packs them, so it is done
      // when they go to Retail — or, until then, when they were entered.
      const myEggs = on(prodLogs).filter((p) => isEgg.get(p.productId));
      const eggQty = myEggs.reduce((s, p) => s + Number(p.quantity), 0);
      packaging.push({
        key: "egg", label: "Eggs collected & packed", egg: true,
        at: eggCollected ? eggCollected.at : myEggs.length ? clockPKT(myEggs[0].createdAt) : null,
        qty: eggCollected ? eggCollected.qty : myEggs.length ? eggQty : null, unit: "pc",
      });

      // ── Riders: four stamps each, from what each one actually did ──────────
      const handedToday = on(handed);
      const returnedToday = on(returned);
      const deliveredToday = on(deliveries);

      const riderIds = new Set<string>();
      for (const m of handedToday) if (m.riderId) riderIds.add(m.riderId);
      for (const m of returnedToday) if (m.riderId) riderIds.add(m.riderId);
      for (const d of deliveredToday) {
        const rid = d.riderId ?? (d.customer?.shiftId ? shiftRider.get(d.customer.shiftId) ?? null : null);
        if (rid) riderIds.add(rid);
      }

      const riders: FlowRider[] = [...riderIds].map((rid) => {
        const mine = handedToday.filter((m) => m.riderId === rid);
        const back = returnedToday.filter((m) => m.riderId === rid);
        const mineDeliv = deliveredToday.filter((d) => {
          const who = d.riderId ?? (d.customer?.shiftId ? shiftRider.get(d.customer.shiftId) ?? null : null);
          return who === rid && !d.isReturn && !d.isReplacement;
        });
        const stamps = mineDeliv.map((d) => d.createdAt).sort((a, b) => a.getTime() - b.getTime());
        const milkOnly = <T extends { productId: string; quantity: unknown }>(rows: T[]) =>
          rows.filter((r) => milkIds.has(r.productId)).reduce((s, r) => s + Number(r.quantity), 0);
        return {
          riderId: rid,
          name: riderNames.get(rid) ?? "Rider",
          recv: mine.length ? clockPKT(mine.map((m) => m.createdAt).sort((a, b) => a.getTime() - b.getTime())[0]) : null,
          start: stamps.length ? clockPKT(stamps[0]) : null,
          end: stamps.length ? clockPKT(stamps[stamps.length - 1]) : null,
          ret: back.length ? clockPKT(back.map((m) => m.createdAt).sort((a, b) => b.getTime() - a.getTime())[0]) : null,
          load: milkOnly(mine),
          delivered: milkOnly(mineDeliv),
          returned: milkOnly(back),
        };
      }).sort((a, b) => a.name.localeCompare(b.name));

      // The day's dispatch is the first load leaving; the returns step is the first
      // review accepted. Both are one moment for the whole day.
      const firstHanded = handedToday.map((m) => m.createdAt).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
      const firstReview = on(reviews).map((r) => r.createdAt).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;

      return {
        date,
        production,
        accepted,
        packaging,
        retailAccepted,
        dispatch: {
          key: "dispatch", label: "Dispatched Retail",
          at: firstHanded ? clockPKT(firstHanded) : null,
          qty: riders.reduce((s, r) => s + r.load, 0) || null, unit: "L",
        },
        returnsAccepted: {
          key: "returns", label: "Returned Accepted",
          at: firstReview ? clockPKT(firstReview) : null, qty: null, unit: null,
        },
        riders,
      };
    });

    void unitOf;
    return { from: lo, to: hi, days, dbReady: true };
  } catch (e) {
    console.error("[getFlowLog]", e);
    return { ...blank, dbReady: false, error: "Could not read the flow log." };
  }
}

/**
 * The day's deadlines, set once and applied to every day until changed again.
 * Managers only — the people being timed do not set their own targets.
 */
export async function saveFlowDeadlines(input: FlowDeadlines): Promise<{ ok: true } | { ok: false; error: string }> {
  await requireRole(FULL_ACCESS);
  // Refuse a blank or malformed time rather than quietly saving the default in
  // its place — the deadline saved must be the one that was entered.
  if (!input || !Array.isArray(input.production) || !Array.isArray(input.packaging) || typeof input.eggs !== "string" || !input.rider || !deadlinesComplete(input)) {
    return { ok: false, error: "Every deadline needs a time." };
  }
  const clean = normaliseDeadlines(input);
  try {
    const value = JSON.stringify(clean);
    await db.appSetting.upsert({ where: { key: FLOW_DEADLINES_KEY }, create: { key: FLOW_DEADLINES_KEY, value }, update: { value } });
    revalidatePath("/inventory/flow-log");
    return { ok: true };
  } catch (e) {
    console.error("[saveFlowDeadlines]", e);
    return { ok: false, error: "Could not save the deadlines." };
  }
}
