"use server";

// Rider item returns, shift by shift.
//
// The rider app records what was handed back at the end of a shift, and those
// RETURNED movements already count as stock again. Returned is not the same as
// usable, though: this is where the office splits each return into what goes
// into inventory and what was thrown away, and the wasted part is taken back out.
//
// Spare stock (RiderExtraItem) is received back in the same place: what the
// office accepts comes off what is still out with the rider, and the spoiled part
// is written off the same way.

import { requireRole, FULL_ACCESS } from "@/lib/auth";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { addDaysToDateStr, dateRangeFromToPKT, dateStrRangePKT, pktNoonToUTC, toDateStrPKT, todayPKTString } from "@/lib/pkt";
import { END_OF_SHIFT_RETURN_REASON } from "@/lib/rider-stock";
import { computeReturnsBoard, retailLeftover, type ReturnsBoard } from "@/lib/rider-returns-board";
import { REVIEW_MISSING_REASON } from "@/lib/missing";
import {
  RETAIL_RETURN_STAGE,
  RIDER_RETURN_STAGE,
  validateReturnAllocation,
  missingOf,
  type ReturnEntry,
  type ReturnLineSpec,
} from "@/lib/rider-return-math";

// Packaging receives the stock back at the farm; the retail manager works the
// same returns from the retail end.
const PAGE_ROLES = [...FULL_ACCESS, "PACKAGING", "RETAIL_MANAGER"] as const;
const isValidDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const r3 = (n: number) => Math.round(n * 1000) / 1000;

export type { ReturnProduct, RiderReturnRow, InventoryLevel, ReturnsBoard } from "@/lib/rider-returns-board";

/** The board: every rider who has something to hand back, in a date range. */
export async function getReturnsBoard(from: string, to: string, riderId?: string | null): Promise<ReturnsBoard> {
  await requireRole([...PAGE_ROLES]);
  return computeReturnsBoard(from, to, riderId);
}

// ── One rider's returns, for the dialog ──────────────────────────────────────

export type RiderReturnDetail =
  | {
      ok: true;
      date: string;
      riderId: string;
      riderName: string;
      /** Every line that has to be accounted for. */
      specs: (ReturnLineSpec & { givenQty?: number })[];
      /** The split already saved, if this has been reviewed before. */
      saved: { key: string; stockQty: number; wasteQty: number; wasteReason: string | null }[];
      reviewedByName: string | null;
      notes: string | null;
    }
  | { ok: false; error: string };

export async function getRiderReturnDetail(riderId: string, date: string): Promise<RiderReturnDetail> {
  await requireRole([...PAGE_ROLES]);
  if (!riderId || !isValidDate(date)) return { ok: false, error: "Choose a rider and a date." };
  try {
    const rider = await db.rider.findUnique({
      where: { id: riderId },
      select: { id: true, user: { select: { name: true } } },
    });
    if (!rider) return { ok: false, error: "That rider no longer exists." };

    const range = dateStrRangePKT(date);
    const [returnRows, extras, review, products] = await Promise.all([
      db.inventoryMovement.findMany({
        where: { type: "RETURNED", reason: END_OF_SHIFT_RETURN_REASON, date: range, riderId },
        select: { productId: true, quantity: true },
      }),
      // Every piece of spare stock he is carrying, whichever shift it was written
      // against — older rows carry only the shift, so both are asked for.
      db.riderExtraItem.findMany({
        where: { date: range, OR: [{ riderId }, { shift: { riderId } }] },
        select: { id: true, productId: true, givenQty: true, returnedQty: true, status: true },
        orderBy: { createdAt: "asc" },
      }),
      db.riderReturnReview.findUnique({
        where: { date_riderId: { date: pktNoonToUTC(date), riderId } },
        select: { reviewedByName: true, notes: true, lines: { select: { productId: true, source: true, extraItemId: true, stockQty: true, wasteQty: true, missingQty: true, wasteReason: true } } },
      }),
      db.product.findMany({ select: { id: true, name: true, unit: true } }),
    ]);
    const meta = new Map(products.map((p) => [p.id, p] as const));

    const byProduct = new Map<string, number>();
    for (const m of returnRows) byProduct.set(m.productId, r3((byProduct.get(m.productId) ?? 0) + Number(m.quantity)));

    const specs: (ReturnLineSpec & { givenQty?: number })[] = [];
    for (const [productId, qty] of byProduct) {
      const p = meta.get(productId);
      if (!p || qty <= 0.0005) continue;
      specs.push({ key: productId, source: "APP", productId, productName: p.name, unit: p.unit, returnedQty: qty });
    }
    for (const e of extras) {
      const p = meta.get(e.productId);
      const out = r3(Number(e.givenQty) - Number(e.returnedQty));
      // A settled extra still shows, so its split can be corrected; one that was
      // never given anything does not.
      const saved = review?.lines.find((l) => l.extraItemId === e.id);
      if (!p || (e.status !== "OUT" && !saved)) continue;
      specs.push({
        key: e.id,
        source: "EXTRA",
        productId: e.productId,
        productName: p.name,
        unit: p.unit,
        // What can still come back: what is out, plus whatever this review itself
        // already took back (so reopening it is not blocked by its own decision).
        returnedQty: r3(out + (saved ? Number(saved.stockQty) + Number(saved.wasteQty) : 0)),
        givenQty: Number(e.givenQty),
      });
    }
    specs.sort((a, b) => a.source.localeCompare(b.source) || a.productName.localeCompare(b.productName));

    return {
      ok: true,
      date,
      riderId,
      riderName: rider.user?.name ?? "Rider",
      specs,
      saved: (review?.lines ?? []).map((l) => ({
        key: l.source === "EXTRA" ? (l.extraItemId ?? "") : l.productId,
        stockQty: Number(l.stockQty),
        wasteQty: Number(l.wasteQty),
        missingQty: Number(l.missingQty),
        wasteReason: l.wasteReason,
      })),
      reviewedByName: review?.reviewedByName ?? null,
      notes: review?.notes ?? null,
    };
  } catch (e) {
    console.error("[getRiderReturnDetail]", e);
    return { ok: false, error: "Could not load that rider's returns." };
  }
}

// ── Saving the split ─────────────────────────────────────────────────────────

export type SaveReturnResult = { ok: true } | { ok: false; error: string };

/**
 * Record what happened to a shift's returns.
 *
 * What it writes, and why the stock stays right:
 *   · the app's returns already put the milk back, so only the WASTED part is
 *     written here — one WASTAGE row per line, stage "Rider return", carrying
 *     this review's id;
 *   · spare stock comes back by raising RiderExtraItem.returnedQty to what was
 *     accepted (stock + waste), which is what the stock formula reads;
 *   · reopening a review deletes the rows it wrote last time and writes them
 *     again, so the same milk can never be written off twice.
 */
export async function saveRiderReturnReview(input: {
  riderId: string;
  date: string;
  entries: ReturnEntry[];
  notes?: string | null;
  clientToken?: string | null;
}): Promise<SaveReturnResult> {
  const user = await requireRole([...PAGE_ROLES]);
  if (!input.riderId || !isValidDate(input.date)) return { ok: false, error: "Choose a rider and a date." };
  if (input.date > todayPKTString()) return { ok: false, error: "That day has not happened yet." };

  try {
    // Re-read what there is to account for: the browser may have been sitting
    // open while the rider app sent more.
    const detail = await getRiderReturnDetail(input.riderId, input.date);
    if (!detail.ok) return { ok: false, error: detail.error };

    const entries = (input.entries ?? []).map((e) => ({
      key: e.key,
      stockQty: Number(e.stockQty),
      wasteQty: Number(e.wasteQty),
      wasteReason: e.wasteReason ?? null,
    }));
    const problem = validateReturnAllocation(detail.specs, entries);
    if (problem) return { ok: false, error: problem };

    const byKey = new Map(entries.map((e) => [e.key, e]));
    const when = pktNoonToUTC(input.date);

    await db.$transaction(async (tx) => {
      // One review per rider per day. A second submit of the same dialog finds
      // its own token and is a no-op rather than a second write-off.
      if (input.clientToken) {
        const seen = await tx.riderReturnReview.findUnique({ where: { clientToken: input.clientToken }, select: { id: true } });
        if (seen) return;
      }
      const existing = await tx.riderReturnReview.findUnique({
        where: { date_riderId: { date: when, riderId: input.riderId } },
        select: { id: true },
      });
      let reviewId = existing?.id;
      if (reviewId) {
        // Rewrite it whole: the old lines and the wastage they caused go first.
        await tx.riderReturnLine.deleteMany({ where: { reviewId } });
        await tx.inventoryMovement.deleteMany({ where: { reference: reviewId, type: "WASTAGE" } });
        await tx.riderReturnReview.update({
          where: { id: reviewId },
          data: {
            notes: input.notes?.trim() || null,
            reviewedById: user.id,
            reviewedByName: user.name,
            ...(input.clientToken ? { clientToken: input.clientToken } : {}),
          },
        });
      } else {
        const created = await tx.riderReturnReview.create({
          data: {
            date: when,
            riderId: input.riderId,
            notes: input.notes?.trim() || null,
            reviewedById: user.id,
            reviewedByName: user.name,
            clientToken: input.clientToken || null,
          },
          select: { id: true },
        });
        reviewId = created.id;
      }

      const lines = detail.specs.map((spec) => {
        const e = byKey.get(spec.key)!;
        const stockQty = r3(e.stockQty);
        const wasteQty = r3(e.wasteQty);
        const missingQty = missingOf(spec, e);
        return {
          reviewId: reviewId!,
          productId: spec.productId,
          source: spec.source,
          extraItemId: spec.source === "EXTRA" ? spec.key : null,
          returnedQty: new Prisma.Decimal(spec.source === "APP" ? spec.returnedQty : r3(stockQty + wasteQty)),
          stockQty: new Prisma.Decimal(stockQty),
          wasteQty: new Prisma.Decimal(wasteQty),
          missingQty: new Prisma.Decimal(missingQty),
          wasteReason: wasteQty > 0.0005 ? e.wasteReason : null,
        };
      });
      if (lines.length > 0) await tx.riderReturnLine.createMany({ data: lines });

      // Spare stock: what was accepted comes off what is out with the rider.
      for (const spec of detail.specs) {
        if (spec.source !== "EXTRA") continue;
        const e = byKey.get(spec.key)!;
        const accepted = r3(e.stockQty + e.wasteQty);
        await tx.riderExtraItem.update({
          where: { id: spec.key },
          data: {
            returnedQty: new Prisma.Decimal(accepted),
            status: "RETURNED",
            confirmedById: user.id,
            confirmedByName: user.name,
          },
        });
      }

      // The spoiled part comes back out of stock — and so does the part that was
      // never handed over: the app's return put it in, it is not there. The
      // second carries REVIEW_MISSING_REASON, which keeps it off the Wastage log
      // and on the Missing log.
      const wasted = detail.specs
        .map((spec) => ({ spec, e: byKey.get(spec.key)! }))
        .filter(({ e }) => r3(e.wasteQty) > 0.0005);
      const short = detail.specs
        .map((spec) => ({ spec, e: byKey.get(spec.key)! }))
        .filter(({ spec, e }) => missingOf(spec, e) > 0.0005);
      if (wasted.length + short.length > 0) {
        await tx.inventoryMovement.createMany({
          data: [
            ...wasted.map(({ spec, e }) => ({
              date: new Date(),
              type: "WASTAGE" as const,
              productId: spec.productId,
              quantity: new Prisma.Decimal(r3(e.wasteQty)),
              reason: e.wasteReason ?? "Spoiled on return",
              stage: RIDER_RETURN_STAGE,
              reference: reviewId!,
              enteredById: user.id,
            })),
            ...short.map(({ spec, e }) => ({
              date: new Date(),
              type: "WASTAGE" as const,
              productId: spec.productId,
              quantity: new Prisma.Decimal(missingOf(spec, e)),
              reason: REVIEW_MISSING_REASON,
              stage: RIDER_RETURN_STAGE,
              reference: reviewId!,
              enteredById: user.id,
            })),
          ],
        });
      }
    }, { maxWait: 10_000, timeout: 30_000 });

    for (const p of ["/inventory/rider-returns", "/inventory", "/inventory/wastage", "/inventory/missing", "/inventory/farm-arrival", "/customers/pre-delivery", "/"]) {
      revalidatePath(p);
    }
    return { ok: true };
  } catch (e) {
    console.error("[saveRiderReturnReview]", e);
    return { ok: false, error: e instanceof Error ? e.message : "Could not save the split." };
  }
}

/** The riders the filter offers. */
export async function getRiderOptions(): Promise<{ id: string; name: string }[]> {
  await requireRole([...PAGE_ROLES]);
  try {
    const riders = await db.rider.findMany({
      where: { active: true },
      select: { id: true, user: { select: { name: true } } },
    });
    return riders
      .map((r) => ({ id: r.id, name: r.user?.name ?? "Rider" }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

// ── The retail centre's own leftover ─────────────────────────────────────────
//
// Packaging sends the day's load to Retail, and the riders take their shifts'
// share from there. Whatever the retail man still has afterwards comes back to
// the farm, and this is where it is split into usable stock and wastage.
//
//   sent to Retail − short on arrival − what the riders took = what is left
//
// Rider returns are not part of it: those come back on their own shifts and are
// split there, so the same milk is never counted in two places.

export type RetailReturnRow = {
  date: string;
  leftover: Record<string, number>;
  stock: Record<string, number>;
  waste: Record<string, number>;
  reviewed: boolean;
  reviewedByName: string | null;
};

export type RetailReturnDetail =
  | {
      ok: true;
      date: string;
      specs: ReturnLineSpec[];
      saved: { key: string; stockQty: number; wasteQty: number; wasteReason: string | null }[];
      reviewedByName: string | null;
      notes: string | null;
    }
  | { ok: false; error: string };

export async function getRetailReturnDetail(date: string): Promise<RetailReturnDetail> {
  await requireRole([...PAGE_ROLES]);
  if (!isValidDate(date)) return { ok: false, error: "Choose a date." };
  try {
    const [left, review, products] = await Promise.all([
      retailLeftover(date),
      db.retailReturnReview.findUnique({
        where: { date: pktNoonToUTC(date) },
        select: { reviewedByName: true, notes: true, lines: { select: { productId: true, stockQty: true, wasteQty: true, wasteReason: true } } },
      }),
      db.product.findMany({ select: { id: true, name: true, unit: true } }),
    ]);
    const meta = new Map(products.map((p) => [p.id, p] as const));

    const specs: ReturnLineSpec[] = [];
    for (const [productId, qty] of left) {
      const p = meta.get(productId);
      if (!p) continue;
      specs.push({ key: productId, source: "RETAIL", productId, productName: p.name, unit: p.unit, returnedQty: qty });
    }
    specs.sort((a, b) => a.productName.localeCompare(b.productName));

    return {
      ok: true,
      date,
      specs,
      saved: (review?.lines ?? []).map((l) => ({
        key: l.productId,
        stockQty: Number(l.stockQty),
        wasteQty: Number(l.wasteQty),
        wasteReason: l.wasteReason,
      })),
      reviewedByName: review?.reviewedByName ?? null,
      notes: review?.notes ?? null,
    };
  } catch (e) {
    console.error("[getRetailReturnDetail]", e);
    return { ok: false, error: "Could not work out what Retail had left." };
  }
}

/**
 * Record what the retail centre handed back.
 *
 * The usable part is at the farm again the moment this is saved (the stock
 * formula reads these lines for today); the wasted part is written off, stage
 * "Retail return", so it never comes back at all. From the next day the leftover
 * returns to inventory on its own, and only the write-off still applies — which
 * is why nothing here writes an arrival.
 */
export async function saveRetailReturnReview(input: {
  date: string;
  entries: ReturnEntry[];
  notes?: string | null;
  clientToken?: string | null;
}): Promise<SaveReturnResult> {
  const user = await requireRole([...PAGE_ROLES]);
  if (!isValidDate(input.date)) return { ok: false, error: "Choose a date." };
  if (input.date > todayPKTString()) return { ok: false, error: "That day has not happened yet." };

  try {
    const detail = await getRetailReturnDetail(input.date);
    if (!detail.ok) return { ok: false, error: detail.error };
    if (detail.specs.length === 0) return { ok: false, error: "Retail has nothing left over on that day." };

    const entries = (input.entries ?? []).map((e) => ({
      key: e.key,
      stockQty: Number(e.stockQty),
      wasteQty: Number(e.wasteQty),
      wasteReason: e.wasteReason ?? null,
    }));
    const problem = validateReturnAllocation(detail.specs, entries);
    if (problem) return { ok: false, error: problem };

    const byKey = new Map(entries.map((e) => [e.key, e]));
    const when = pktNoonToUTC(input.date);

    await db.$transaction(async (tx) => {
      if (input.clientToken) {
        const seen = await tx.retailReturnReview.findUnique({ where: { clientToken: input.clientToken }, select: { id: true } });
        if (seen) return;
      }
      const existing = await tx.retailReturnReview.findUnique({ where: { date: when }, select: { id: true } });
      let reviewId = existing?.id;
      if (reviewId) {
        await tx.retailReturnLine.deleteMany({ where: { reviewId } });
        await tx.inventoryMovement.deleteMany({ where: { reference: reviewId, type: "WASTAGE" } });
        await tx.retailReturnReview.update({
          where: { id: reviewId },
          data: {
            notes: input.notes?.trim() || null,
            reviewedById: user.id,
            reviewedByName: user.name,
            ...(input.clientToken ? { clientToken: input.clientToken } : {}),
          },
        });
      } else {
        const created = await tx.retailReturnReview.create({
          data: {
            date: when,
            notes: input.notes?.trim() || null,
            reviewedById: user.id,
            reviewedByName: user.name,
            clientToken: input.clientToken || null,
          },
          select: { id: true },
        });
        reviewId = created.id;
      }

      await tx.retailReturnLine.createMany({
        data: detail.specs.map((spec) => {
          const e = byKey.get(spec.key)!;
          return {
            reviewId: reviewId!,
            productId: spec.productId,
            leftoverQty: new Prisma.Decimal(spec.returnedQty),
            stockQty: new Prisma.Decimal(r3(e.stockQty)),
            wasteQty: new Prisma.Decimal(r3(e.wasteQty)),
            wasteReason: r3(e.wasteQty) > 0.0005 ? e.wasteReason : null,
          };
        }),
      });

      const wasted = detail.specs
        .map((spec) => ({ spec, e: byKey.get(spec.key)! }))
        .filter(({ e }) => r3(e.wasteQty) > 0.0005);
      if (wasted.length > 0) {
        await tx.inventoryMovement.createMany({
          data: wasted.map(({ spec, e }) => ({
            date: new Date(),
            type: "WASTAGE" as const,
            productId: spec.productId,
            quantity: new Prisma.Decimal(r3(e.wasteQty)),
            reason: e.wasteReason ?? "Spoiled at Retail",
            stage: RETAIL_RETURN_STAGE,
            reference: reviewId!,
            enteredById: user.id,
          })),
        });
      }
    }, { maxWait: 10_000, timeout: 30_000 });

    for (const p of ["/inventory/rider-returns", "/inventory", "/inventory/wastage", "/inventory/retail", "/inventory/farm-arrival", "/"]) {
      revalidatePath(p);
    }
    return { ok: true };
  } catch (e) {
    console.error("[saveRetailReturnReview]", e);
    return { ok: false, error: e instanceof Error ? e.message : "Could not save the retail return." };
  }
}

/** The retail centre's leftover for each day in a range, for the board. */
export async function getRetailReturnRows(from: string, to: string): Promise<RetailReturnRow[]> {
  await requireRole([...PAGE_ROLES]);
  if (!isValidDate(from) || !isValidDate(to)) return [];
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  try {
    const reviews = await db.retailReturnReview.findMany({
      where: { date: dateRangeFromToPKT(lo, hi) },
      select: { date: true, reviewedByName: true, lines: { select: { productId: true, leftoverQty: true, stockQty: true, wasteQty: true } } },
    });
    const byDate = new Map(reviews.map((r) => [toDateStrPKT(r.date), r] as const));

    const rows: RetailReturnRow[] = [];
    for (let d = lo; d <= hi; d = addDaysToDateStr(d, 1)) {
      const left = await retailLeftover(d);
      const review = byDate.get(d);
      if (left.size === 0 && !review) continue;
      const row: RetailReturnRow = {
        date: d,
        leftover: Object.fromEntries(left),
        stock: {},
        waste: {},
        reviewed: !!review,
        reviewedByName: review?.reviewedByName ?? null,
      };
      for (const l of review?.lines ?? []) {
        row.stock[l.productId] = r3((row.stock[l.productId] ?? 0) + Number(l.stockQty));
        row.waste[l.productId] = r3((row.waste[l.productId] ?? 0) + Number(l.wasteQty));
      }
      rows.push(row);
    }
    return rows.sort((a, b) => b.date.localeCompare(a.date));
  } catch (e) {
    console.error("[getRetailReturnRows]", e);
    return [];
  }
}
