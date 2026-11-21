"use server";

import { requireRole, FULL_ACCESS } from "@/lib/auth";
import { isRoadWastage } from "@/lib/rider-stock";
import { MISSING_REASONS, isMissingReason } from "@/lib/missing";
import { SENT_TO_RETAIL } from "@/lib/packaging-stock";

import type { Unit } from "@/lib/units";
import { db } from "@/lib/db";
import { loadLoss } from "@/lib/mix-allocation";
import { packagingAttribution, EMPTY_SHARE } from "@/lib/packaging-attribution";
import { toDateStrPKT } from "@/lib/pkt";

export type WastageEntry = {
  id: string;
  date: string;
  // "Retail" is the packaging-to-retail internal leg. "Retail mart" is product
  // that expired on a SHOP's shelf — a different thing, so a different stage.
  // "Rider return" is the spoiled part of what a rider handed back, written off
  // when the office split the return on the Rider Item Returns page.
  stage: "Production" | "Packaging" | "Retail" | "Retail mart" | "Yoghurt" | "Rider delivery" | "Riders" | "Rider return";
  loggedBy: string; // stage label for derived rows; the actual user's name for manual Waste-entry rows
  productName: string;
  unit: Unit;
  loss: number;
  reason: string | null;
};

type DispatchItem = {
  productId: string;
  productName: string;
  unit: string;
  quantity: number;
};

function extractLosses(
  id: string,
  date: Date,
  stage: WastageEntry["stage"],
  loggedBy: WastageEntry["loggedBy"],
  declaredItems: unknown,
  receivedItems: unknown,
  reason: string | null,
  packaging: {
    mixUsed?: Record<string, number>;
    dilutionOut?: Record<string, number>;
    dilutionIn?: Record<string, number>;
  } = {}
): WastageEntry[] {
  if (!receivedItems) return [];

  // When the person explicitly logged honest wastage, the stage reflects their own
  // stage (not the upstream stage where the goods came from).
  const isExplicit = reason === "Explicit wastage";
  const effectiveStage: WastageEntry["stage"] = isExplicit
    ? stage === "Production" ? "Packaging"
    : stage === "Packaging" ? "Retail"
    : stage
    : stage;
  const displayReason = isExplicit ? null : reason;

  const declared = declaredItems as DispatchItem[];
  const received = receivedItems as DispatchItem[];
  const result: WastageEntry[] = [];
  for (const di of declared) {
    const ri = received.find((x) => x.productId === di.productId);
    const loss = loadLoss(di.quantity, ri?.quantity ?? di.quantity, {
      mixUsed: packaging.mixUsed?.[di.productId] ?? 0,
      dilutionOut: packaging.dilutionOut?.[di.productId] ?? 0,
      dilutionIn: packaging.dilutionIn?.[di.productId] ?? 0,
    });
    if (loss > 0.001) {
      result.push({
        id: `${id}:${di.productId}`,
        date: date.toISOString(),
        stage: effectiveStage,
        loggedBy,
        productName: di.productName,
        unit: di.unit as WastageEntry["unit"],
        loss,
        reason: displayReason,
      });
    }
  }
  return result;
}

type YoghurtBatchRow = { id: string; date: Date; boilingWaste: { toString(): string }; productionWaste: { toString(): string } };

export async function getWastageData(): Promise<{
  entries: WastageEntry[];
  dbReady: boolean;
}> {
  await requireRole([...FULL_ACCESS, "PACKAGING"]);
  try {
    const [farmDs, retailDs, prodWastageRows, wasteEntryRows, riderWastageRows] = await Promise.all([
      db.farmDispatch.findMany({
        orderBy: { date: "desc" },
        select: { id: true, date: true, declaredItems: true, receivedItems: true, reason: true },
      }),
      // Retail dispatch now comes straight from Packaging (the Van stage was removed).
      db.retailDispatch.findMany({
        orderBy: { date: "desc" },
        select: { id: true, date: true, declaredItems: true, receivedItems: true, reason: true },
      }),
      // Explicitly logged production-stage wastage (before dispatch). The three
      // WASTAGE queries below are kept MUTUALLY EXCLUSIVE (via stage/riderId) so a
      // single row can never be pulled into two of them and shown twice — e.g. a
      // manual Waste-entry that happens to use the reason "Production wastage".
      db.inventoryMovement.findMany({
        where: { type: "WASTAGE", reason: "Production wastage", stage: null, riderId: null },
        orderBy: { date: "desc" },
        select: { id: true, date: true, quantity: true, productId: true, product: { select: { name: true, unit: true } } },
      }),
      // Manual Waste-entry rows (stage set, no rider) — their own stage/reason/logged-by user
      // Missing milk (day-end write-offs, review shortfalls) is on its own log.
      db.inventoryMovement.findMany({
        where: { type: "WASTAGE", stage: { not: null }, riderId: null, NOT: { reason: { in: [...MISSING_REASONS] } } },
        orderBy: { date: "desc" },
        select: {
          id: true,
          date: true,
          quantity: true,
          stage: true,
          reason: true,
          product: { select: { name: true, unit: true } },
          enteredBy: { select: { name: true } },
        },
      }),
      // Rider-reported wastage — the mobile app writes a WASTAGE movement with a
      // riderId (and reason "Rider wastage") when a rider records breakage/spillage
      // at the end of a shift. Shown in the log under the "Rider delivery" stage.
      // (Already excluded from the in-storage deduction, which only counts stage-set
      // rows, and already nets out of on-van stock via riderWastageMap — so this is
      // display-only and changes no inventory math.)
      db.inventoryMovement.findMany({
        where: { type: "WASTAGE", riderId: { not: null }, stage: null },
        orderBy: { date: "desc" },
        select: {
          id: true,
          date: true,
          quantity: true,
          reason: true,
          product: { select: { name: true, unit: true } },
          rider: { select: { user: { select: { name: true } } } },
        },
      }),
    ]);

    // Queried separately so wastage works before prisma db push has been run for YoghurtBatch
    let yoghurtBatches: YoghurtBatchRow[] = [];
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      yoghurtBatches = await (db as any).yoghurtBatch.findMany({
        orderBy: { date: "desc" },
        select: { id: true, date: true, boilingWaste: true, productionWaste: true },
      });
    } catch {
      // table not created yet — skip silently
    }

    // What packaging did to each load, so ordinary processing is not reported as
    // wastage. Shared with the packaging screen, its confirm guard and the
    // inventory summary — one rule, one place.
    const shares = await packagingAttribution({
      gte: farmDs.reduce((min, d) => (d.date < min ? d.date : min), farmDs[0]?.date ?? new Date(0)),
      lte: farmDs.reduce((max, d) => (d.date > max ? d.date : max), farmDs[0]?.date ?? new Date(0)),
    });

    const martSpoilage = await db.retailResolutionLine.findMany({
      // Only stock-tracked product belongs in the farm's wastage log. A retail
      // bottle that expired is a retail loss, shown on the Retail page instead —
      // it never entered inventory, so it cannot leave it.
      where: { wastedQty: { gt: 0 }, placementLine: { product: { retailOnly: false } } },
      select: {
        id: true,
        wastedQty: true,
        resolution: {
          select: { date: true, resolutionNo: true, retailVendor: { select: { name: true } } },
        },
        placementLine: { select: { product: { select: { name: true, unit: true } } } },
      },
      orderBy: { resolution: { date: "desc" } },
      take: 500,
    });

    // Retail loads that were sends from packaging's inventory (see below).
    const inventorySendIds = new Set(
      (await db.inventoryMovement.findMany({
        where: { type: "DISPATCHED", reason: SENT_TO_RETAIL },
        select: { reference: true },
      })).map((m) => m.reference).filter((r): r is string => !!r),
    );

    const entries: WastageEntry[] = [
      // Manual Waste-entry rows — the exact number the user logged, with their chosen
      // stage/reason and the actual person who logged it.
      // Product that expired on a shop's shelf. Read from the retail records
      // directly: the stock already left storage when it was dropped, so writing
      // a WASTAGE movement here would deduct the same milk twice AND lock the
      // day against the reconciliation editor.
      ...martSpoilage.map((r) => ({
        id: `mart:${r.id}`,
        date: r.resolution.date.toISOString(),
        stage: "Retail mart" as const,
        loggedBy: r.resolution.retailVendor.name,
        productName: r.placementLine.product.name,
        unit: r.placementLine.product.unit as Unit,
        loss: Number(r.wastedQty),
        reason: "Expired unsold at the shop",
      })),
      ...wasteEntryRows.map((m) => ({
        id: m.id,
        date: m.date.toISOString(),
        stage: (m.stage ?? "Production") as WastageEntry["stage"],
        loggedBy: m.enteredBy?.name ?? "—",
        productName: m.product.name,
        unit: m.product.unit as WastageEntry["unit"],
        loss: Number(m.quantity),
        reason: m.reason,
      })),
      // Explicitly logged at production stage (before dispatch to packaging)
      ...prodWastageRows.map((m) => ({
        id: m.id,
        date: m.date.toISOString(),
        stage: "Production" as const,
        loggedBy: "Production" as const,
        productName: m.product.name,
        unit: m.product.unit as WastageEntry["unit"],
        loss: Number(m.quantity),
        reason: null,
      })),
      ...farmDs.flatMap((d) =>
        extractLosses(d.id, d.date, "Production", "Packaging", d.declaredItems, d.receivedItems, d.reason ?? null, shares.get(d.id) ?? EMPTY_SHARE)
      ),
      // Packaging → Retail transit loss (declared at packaging vs received at retail).
      // Sends from inventory are left out: their shortfall is written off as its
      // own Retail wastage row when Retail confirms, listed above with the manual
      // entries — reading it here as well would show the same loss twice.
      ...retailDs.filter((d) => !inventorySendIds.has(d.id)).flatMap((d) =>
        extractLosses(d.id, d.date, "Packaging", "Retail", d.declaredItems, d.receivedItems, d.reason ?? null)
      ),
      // Rider-reported wastage → shown under the "Rider delivery" stage, logged by the rider.
      // A row saying he accepted less than the sheet is not wastage (LOAD_SHORT_REASONS)
      // and is left out: nothing was lost, the milk stayed at the retail centre.
      ...riderWastageRows.filter((m) => isRoadWastage(m.reason) && !isMissingReason(m.reason)).map((m) => ({
        id: m.id,
        date: m.date.toISOString(),
        stage: "Rider delivery" as const,
        loggedBy: m.rider?.user?.name ?? "Rider",
        productName: m.product.name,
        unit: m.product.unit as WastageEntry["unit"],
        loss: Number(m.quantity),
        reason: m.reason ?? "Rider wastage",
      })),
      ...yoghurtBatches.flatMap((b) => {
        const result: WastageEntry[] = [];
        const boiling = Number(b.boilingWaste);
        const production = Number(b.productionWaste);
        if (boiling > 0.001) {
          result.push({ id: `${b.id}:boiling`, date: b.date.toISOString(), stage: "Yoghurt", loggedBy: "Yoghurt", productName: "Milk (Boiling)", unit: "LITER", loss: boiling, reason: "Boiling waste" });
        }
        if (production > 0.001) {
          result.push({ id: `${b.id}:production`, date: b.date.toISOString(), stage: "Yoghurt", loggedBy: "Yoghurt", productName: "Yoghurt (Spillage)", unit: "KG", loss: production, reason: "Production waste/spillage" });
        }
        return result;
      }),
    ];

    entries.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    return { entries, dbReady: true };
  } catch {
    return { entries: [], dbReady: false };
  }
}
