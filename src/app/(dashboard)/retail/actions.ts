"use server";

import { requireRole, requireAdmin, requireUser, RETAIL_ACCESS, FULL_ACCESS } from "@/lib/auth";
import { unitSuffix } from "@/lib/units";
import type { Unit } from "@/lib/units";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { getOnHandByProduct } from "@/lib/inventory-onhand";
import { getHeadBalances, VISIBLE_HEADS, INFLOW_HEADS } from "@/lib/head-balances";
import { isHeldHead, type PaymentHeadName } from "@/lib/payment-heads";
import { quantityProblem } from "@/lib/quantity";
import { todayPKTString, toDateStrPKT, pktNoonToUTC, dateRangeFromToPKT } from "@/lib/pkt";
import {
  openQty,
  openValue,
  isFullyResolved,
  resolutionTotals,
  validateResolution,
  martBalance,
  applyFifo,
  round2,
  round3,
} from "@/lib/retail-math";
import { dueDateFor, bucketFor, ageInDays, daysOverdue, type FollowupBucket } from "@/lib/retail-followup";

// Retail marts take product on CONSIGNMENT: it is dropped at their shop, and days
// later they report what sold and what expired and pay for the sold part.
//
// The one rule this module lives by: it writes NO InventoryMovement, ever. Stock
// leaves through the `retailOut` term in src/lib/inventory-onhand.ts, which reads
// RetailPlacementLine.quantity directly. A drop deducts once; reporting it sold or
// expired moves money, never stock. That is what makes double-deduction
// structurally impossible rather than merely guarded against.

export type ActionResult = { ok: true } | { ok: false; error: string };

// ── Types the client reads ───────────────────────────────────────────────────

export type RetailProduct = {
  productId: string;
  productName: string;
  unit: Unit;
  defaultRate: number;
  onHand: number;
  /** Retail — no stock figure, so no ceiling on what may be dropped. */
  retailOnly: boolean;
  /** Size of one pack for ml/g products, so the dialog can show "250 ml × 40". */
  packSize: number | null;
};

export type RetailMartOption = {
  id: string;
  name: string;
  areaName: string | null;
  city: string | null;
  followUpDays: number;
};

export type RetailContext = {
  products: RetailProduct[];
  marts: RetailMartOption[];
  heads: { head: string; label: string; balance: number }[];
  today: string;
  dbReady: boolean;
};

export type PlacementLineView = {
  id: string;
  productId: string;
  productName: string;
  unit: Unit;
  /** Snapshot from the drop, so an edited product never rewrites this line. */
  packSize: number | null;
  rate: number;
  /**
   * What one unit costs us, live from the product. The dialog needs it to show
   * the same "our loss" figure the server is about to store — the invariant this
   * whole module is built on. The figure that gets STORED is snapshotted at
   * resolution time, so editing the cost later cannot move a loss already booked.
   */
  costPrice: number | null;
  quantity: number;
  soldQty: number;
  wastedQty: number;
  openQty: number;
};

export type PlacementView = {
  id: string;
  placementNo: string;
  martId: string;
  martName: string;
  date: string; // PKT day string
  dueDate: string;
  bucket: FollowupBucket;
  ageDays: number;
  overdueDays: number;
  status: "OPEN" | "PART" | "CLOSED" | "VOID";
  lines: PlacementLineView[];
  droppedValue: number;
  soldValue: number;
  wastedValue: number;
  openValue: number;
  notes: string | null;
  voided: boolean;
};

export type RetailKpis = {
  soldValue: number;
  received: number;
  pending: number;
  outAtMarts: number;
  /** Revenue forgone on expired product, at the shop's rate. */
  wastedValue: number;
  /** What that product actually cost us. Null when a cost was missing. */
  wastedCost: number | null;
  activeMarts: number;
};

export type RetailOverview = {
  kpis: RetailKpis;
  placements: PlacementView[];
  today: string;
  dbReady: boolean;
};

export type MartRow = {
  id: string;
  name: string;
  managerName: string | null;
  phone: string | null;
  areaName: string | null;
  city: string | null;
  followUpDays: number;
  active: boolean;
  balanceOwed: number;
  collected: number;
  stockOutValue: number;
  openDrops: number;
};

export type RetailMartsData = { marts: MartRow[]; dbReady: boolean };

// ── Reads ────────────────────────────────────────────────────────────────────

export async function getRetailContext(): Promise<RetailContext> {
  await requireRole(RETAIL_ACCESS);
  const empty: RetailContext = { products: [], marts: [], heads: [], today: todayPKTString(), dbReady: false };
  try {
    const [products, onHand, marts, heads] = await Promise.all([
      db.product.findMany({
        // The one product list that deliberately keeps retail products: this is
        // the screen they exist for.
        where: { active: true },
        select: { id: true, name: true, unit: true, defaultRate: true, retailOnly: true, packSize: true },
        orderBy: { name: "asc" },
      }),
      getOnHandByProduct(),
      db.retailVendor.findMany({
        where: { active: true },
        select: { id: true, name: true, areaName: true, city: true, followUpDays: true },
        orderBy: { name: "asc" },
      }),
      getHeadBalances(),
    ]);
    return {
      products: products.map((p) => ({
        productId: p.id,
        productName: p.name,
        unit: p.unit as Unit,
        defaultRate: Number(p.defaultRate),
        onHand: onHand.get(p.id) ?? 0,
        retailOnly: p.retailOnly,
        packSize: p.packSize == null ? null : Number(p.packSize),
      })),
      marts,
      // Only for money coming in from a mart — never into Meezan, the owners' account.
      heads: heads.filter((h) => isHeldHead(h.head)),
      today: todayPKTString(),
      dbReady: true,
    };
  } catch (e) {
    console.error("[getRetailContext]", e);
    return empty;
  }
}

const PLACEMENT_INCLUDE = {
  retailVendor: { select: { id: true, name: true, followUpDays: true } },
  lines: { include: { product: { select: { name: true, unit: true, costPrice: true } } } },
} satisfies Prisma.RetailPlacementInclude;

type PlacementRow = Prisma.RetailPlacementGetPayload<{ include: typeof PLACEMENT_INCLUDE }>;

function toPlacementView(p: PlacementRow, today: string): PlacementView {
  const lines: PlacementLineView[] = p.lines.map((l) => {
    const view = {
      id: l.id,
      productId: l.productId,
      productName: l.product.name,
      unit: l.product.unit as Unit,
      packSize: l.packSize == null ? null : Number(l.packSize),
      rate: Number(l.rate),
      costPrice: l.product.costPrice == null ? null : Number(l.product.costPrice),
      quantity: Number(l.quantity),
      soldQty: Number(l.soldQty),
      wastedQty: Number(l.wastedQty),
    };
    return { ...view, openQty: openQty(view) };
  });

  const dropDay = toDateStrPKT(p.date);
  const dueDate = p.followUpAt ? toDateStrPKT(p.followUpAt) : dueDateFor(dropDay, p.retailVendor.followUpDays);
  const closed = isFullyResolved(lines);
  const touched = lines.some((l) => l.soldQty > 0 || l.wastedQty > 0);

  return {
    id: p.id,
    placementNo: p.placementNo,
    martId: p.retailVendor.id,
    martName: p.retailVendor.name,
    date: dropDay,
    dueDate,
    bucket: bucketFor(dueDate, today),
    ageDays: ageInDays(dropDay, today),
    overdueDays: daysOverdue(dueDate, today),
    status: p.voidedAt ? "VOID" : closed ? "CLOSED" : touched ? "PART" : "OPEN",
    lines,
    droppedValue: round2(lines.reduce((s, l) => s + l.quantity * l.rate, 0)),
    soldValue: round2(lines.reduce((s, l) => s + l.soldQty * l.rate, 0)),
    wastedValue: round2(lines.reduce((s, l) => s + l.wastedQty * l.rate, 0)),
    openValue: openValue(lines),
    notes: p.notes,
    voided: !!p.voidedAt,
  };
}

export async function getRetailOverview(from?: string, to?: string): Promise<RetailOverview> {
  await requireRole(RETAIL_ACCESS);
  const today = todayPKTString();
  const empty: RetailOverview = {
    kpis: { soldValue: 0, received: 0, pending: 0, outAtMarts: 0, wastedValue: 0, wastedCost: 0, activeMarts: 0 },
    placements: [],
    today,
    dbReady: false,
  };
  try {
    // An open-ended filter is allowed from either side: "everything since the 1st"
    // or "everything up to today".
    const window =
      from || to ? dateRangeFromToPKT(from || "2000-01-01", to || today) : undefined;

    const [placements, openPlacements, resolutions, payments, receivables, martCount] = await Promise.all([
      db.retailPlacement.findMany({
        where: window ? { date: window } : undefined,
        include: PLACEMENT_INCLUDE,
        orderBy: { date: "desc" },
        take: 400,
      }),
      // Anything still unresolved, whatever period is selected — stock sitting at a
      // shop does not stop being out because you filtered the log to last week.
      db.retailPlacement.findMany({ where: { voidedAt: null }, include: PLACEMENT_INCLUDE }),
      db.retailResolution.findMany({
        where: window ? { date: window } : undefined,
        select: { soldAmount: true, wastedValue: true, wastedCost: true },
      }),
      db.retailPayment.findMany({
        where: window ? { date: window } : undefined,
        select: { amount: true },
      }),
      db.retailReceivable.findMany({ select: { amount: true, received: true } }),
      db.retailVendor.count({ where: { active: true } }),
    ]);

    const outAtMarts = round2(
      openPlacements.reduce(
        (s, p) => s + openValue(p.lines.map((l) => ({
          quantity: Number(l.quantity),
          soldQty: Number(l.soldQty),
          wastedQty: Number(l.wastedQty),
          rate: Number(l.rate),
        }))),
        0
      )
    );

    return {
      kpis: {
        soldValue: round2(resolutions.reduce((s, r) => s + Number(r.soldAmount), 0)),
        received: round2(payments.reduce((s, r) => s + Number(r.amount), 0)),
        pending: martBalance(receivables.map((r) => ({ amount: Number(r.amount), received: Number(r.received) }))),
        outAtMarts,
        wastedValue: round2(resolutions.reduce((s, r) => s + Number(r.wastedValue), 0)),
        // Null the moment any resolution in the window lacked a cost — a total
        // covering only part of the loss reads as if it covered all of it.
        wastedCost: resolutions.some((r) => r.wastedCost == null)
          ? null
          : round2(resolutions.reduce((s, r) => s + Number(r.wastedCost), 0)),
        activeMarts: martCount,
      },
      placements: placements.map((p) => toPlacementView(p, today)),
      today,
      dbReady: true,
    };
  } catch (e) {
    console.error("[getRetailOverview]", e);
    return empty;
  }
}

export async function getRetailMarts(): Promise<RetailMartsData> {
  await requireRole(RETAIL_ACCESS);
  try {
    const [marts, receivables, payments, openPlacements] = await Promise.all([
      db.retailVendor.findMany({ orderBy: [{ active: "desc" }, { name: "asc" }] }),
      db.retailReceivable.findMany({ select: { retailVendorId: true, amount: true, received: true } }),
      db.retailPayment.groupBy({ by: ["retailVendorId"], _sum: { amount: true } }),
      db.retailPlacement.findMany({
        where: { voidedAt: null },
        select: {
          retailVendorId: true,
          lines: { select: { quantity: true, soldQty: true, wastedQty: true, rate: true } },
        },
      }),
    ]);

    const owedBy = new Map<string, { amount: number; received: number }[]>();
    for (const r of receivables) {
      const arr = owedBy.get(r.retailVendorId) ?? [];
      arr.push({ amount: Number(r.amount), received: Number(r.received) });
      owedBy.set(r.retailVendorId, arr);
    }
    const collectedBy = new Map(payments.map((p) => [p.retailVendorId, Number(p._sum.amount ?? 0)]));

    const outBy = new Map<string, { value: number; drops: number }>();
    for (const p of openPlacements) {
      const lines = p.lines.map((l) => ({
        quantity: Number(l.quantity),
        soldQty: Number(l.soldQty),
        wastedQty: Number(l.wastedQty),
        rate: Number(l.rate),
      }));
      const value = openValue(lines);
      if (value <= 0.005) continue;
      const cur = outBy.get(p.retailVendorId) ?? { value: 0, drops: 0 };
      outBy.set(p.retailVendorId, { value: round2(cur.value + value), drops: cur.drops + 1 });
    }

    return {
      marts: marts.map((m) => ({
        id: m.id,
        name: m.name,
        managerName: m.managerName,
        phone: m.phone,
        areaName: m.areaName,
        city: m.city,
        followUpDays: m.followUpDays,
        active: m.active,
        balanceOwed: martBalance(owedBy.get(m.id) ?? []),
        collected: collectedBy.get(m.id) ?? 0,
        stockOutValue: outBy.get(m.id)?.value ?? 0,
        openDrops: outBy.get(m.id)?.drops ?? 0,
      })),
      dbReady: true,
    };
  } catch (e) {
    console.error("[getRetailMarts]", e);
    return { marts: [], dbReady: false };
  }
}

export async function getRetailPlacement(id: string): Promise<PlacementView | null> {
  await requireRole(RETAIL_ACCESS);
  try {
    const p = await db.retailPlacement.findUnique({ where: { id }, include: PLACEMENT_INCLUDE });
    return p ? toPlacementView(p, todayPKTString()) : null;
  } catch (e) {
    console.error("[getRetailPlacement]", e);
    return null;
  }
}

// ── Marts ────────────────────────────────────────────────────────────────────

export type MartInput = {
  name: string;
  managerName?: string | null;
  phone?: string | null;
  address?: string | null;
  areaName?: string | null;
  city?: string | null;
  notes?: string | null;
  followUpDays?: number | null;
};

function cleanMart(data: MartInput) {
  const t = (v: string | null | undefined) => (v ?? "").trim() || null;
  const days = Number(data.followUpDays);
  return {
    name: (data.name ?? "").trim(),
    managerName: t(data.managerName),
    phone: t(data.phone),
    address: t(data.address),
    areaName: t(data.areaName),
    city: t(data.city),
    notes: t(data.notes),
    followUpDays: Number.isFinite(days) && days >= 0 && days <= 60 ? Math.floor(days) : 3,
  };
}

export async function createRetailVendor(
  data: MartInput
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  await requireRole(RETAIL_ACCESS);
  try {
    const clean = cleanMart(data);
    if (!clean.name) return { ok: false, error: "Enter the shop's name." };
    const existing = await db.retailVendor.findUnique({ where: { name: clean.name }, select: { id: true } });
    if (existing) return { ok: false, error: `"${clean.name}" is already on the list.` };
    const mart = await db.retailVendor.create({ data: clean, select: { id: true } });
    revalidateRetail();
    return { ok: true, id: mart.id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to add the shop." };
  }
}

export async function updateRetailVendor(id: string, data: MartInput): Promise<ActionResult> {
  await requireRole(RETAIL_ACCESS);
  try {
    const clean = cleanMart(data);
    if (!clean.name) return { ok: false, error: "Enter the shop's name." };
    const clash = await db.retailVendor.findFirst({
      where: { name: clean.name, NOT: { id } },
      select: { id: true },
    });
    if (clash) return { ok: false, error: `"${clean.name}" is already on the list.` };
    await db.retailVendor.update({ where: { id }, data: clean });
    revalidateRetail();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to save the shop." };
  }
}

export async function setRetailVendorActive(id: string, active: boolean): Promise<ActionResult> {
  await requireRole(RETAIL_ACCESS);
  try {
    if (!active) {
      // Deactivating hides a shop from the pickers. Refuse while they still hold
      // stock or owe money, or it silently disappears with an open balance.
      const [open, receivables] = await Promise.all([
        db.retailPlacement.findMany({
          where: { retailVendorId: id, voidedAt: null },
          select: { lines: { select: { quantity: true, soldQty: true, wastedQty: true, rate: true } } },
        }),
        db.retailReceivable.findMany({ where: { retailVendorId: id }, select: { amount: true, received: true } }),
      ]);
      const stillOut = open.some((p) =>
        p.lines.some((l) => openQty({ quantity: Number(l.quantity), soldQty: Number(l.soldQty), wastedQty: Number(l.wastedQty) }) > 0.000001)
      );
      const owed = martBalance(receivables.map((r) => ({ amount: Number(r.amount), received: Number(r.received) })));
      if (stillOut) return { ok: false, error: "This shop still has stock to account for. Resolve those drops first." };
      if (owed > 0.005) return { ok: false, error: `This shop still owes ₨${Math.round(owed).toLocaleString("en-PK")}. Collect or write it off first.` };
    }
    await db.retailVendor.update({ where: { id }, data: { active } });
    revalidateRetail();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to update the shop." };
  }
}

// ── Placements (the drop) ────────────────────────────────────────────────────

export type PlacementLineInput = { productId: string; quantity: number; rate: number };

export type CreatePlacementInput = {
  retailVendorId: string;
  date: string;
  notes?: string | null;
  lines: PlacementLineInput[];
};

export async function createRetailPlacement(
  data: CreatePlacementInput
): Promise<{ ok: true; placementNo: string } | { ok: false; error: string }> {
  const user = await requireUser();
  await requireRole(RETAIL_ACCESS);
  try {
    if (!data.retailVendorId) return { ok: false, error: "Select a shop." };
    const mart = await db.retailVendor.findUnique({
      where: { id: data.retailVendorId },
      select: { id: true, name: true, active: true },
    });
    if (!mart) return { ok: false, error: "That shop is not on the list." };
    if (!mart.active) return { ok: false, error: `${mart.name} is not active.` };

    const rawLines = (data.lines ?? []).filter((l) => l.productId && Number(l.quantity) > 0);
    if (rawLines.length === 0) return { ok: false, error: "Add at least one product." };

    const products = await db.product.findMany({
      where: { id: { in: rawLines.map((l) => l.productId) }, active: true },
      select: { id: true, name: true, unit: true, retailOnly: true, packSize: true },
    });
    const byId = new Map(products.map((p) => [p.id, p]));

    // Same validation the OTC sale does: a non-finite number would poison every
    // downstream sum, and the shared quantity rule keeps decimals sane.
    for (const l of rawLines) {
      const p = byId.get(l.productId);
      if (!p) return { ok: false, error: "One of the products is no longer active." };
      if (!Number.isFinite(l.rate) || l.rate < 0) return { ok: false, error: `${p.name}: enter a valid rate.` };
      if (!Number.isFinite(l.quantity)) return { ok: false, error: `${p.name}: enter a valid quantity.` };
      const problem = quantityProblem(p.name, p.unit, l.quantity);
      if (problem) return { ok: false, error: problem };
    }

    // The same product can appear on two lines — check the TOTAL against stock.
    //
    // Every line is in this map, retail products included: they are counted now.
    // Everything downstream — the pre-check, the advisory locks and the re-check
    // inside the transaction — reads this same map, so a drop mixing a bottle
    // with real milk guards and locks both.
    const wanted = new Map<string, number>();
    for (const l of rawLines) {
      wanted.set(l.productId, round3((wanted.get(l.productId) ?? 0) + l.quantity));
    }

    const onHandPre = await getOnHandByProduct();
    for (const [productId, qty] of wanted) {
      const p = byId.get(productId)!;
      const have = onHandPre.get(productId) ?? 0;
      if (qty > have + 1e-6) {
        return { ok: false, error: `Not enough ${p.name}: ${fmtQty(have)}${unitSuffix(p.unit)} in storage, ${fmtQty(qty)}${unitSuffix(p.unit)} requested.` };
      }
    }

    const when = !data.date || data.date === todayPKTString() ? new Date() : pktNoonToUTC(data.date);
    const notes = (data.notes ?? "").trim() || null;

    // Retry on a placement-number collision, exactly as the OTC invoice number does.
    let placementNo = "";
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        placementNo = await db.$transaction(async (tx) => {
          // Serialise against every other outflow path (OTC sale, waste entry,
          // rider extras) on the SAME lock key, in sorted order to avoid deadlock.
          for (const productId of [...wanted.keys()].sort()) {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"stock:" + productId}))`;
          }
          // Authoritative re-check inside the lock.
          const onHand = await getOnHandByProduct();
          for (const [productId, qty] of wanted) {
            const p = byId.get(productId)!;
            const have = onHand.get(productId) ?? 0;
            if (qty > have + 1e-6) {
              throw new StockError(`Not enough ${p.name}: ${fmtQty(have)}${unitSuffix(p.unit)} in storage, ${fmtQty(qty)}${unitSuffix(p.unit)} requested.`);
            }
          }

          const no = await nextNo(tx, "RetailPlacement", "placementNo", "RP");
          await tx.retailPlacement.create({
            data: {
              placementNo: no,
              retailVendorId: mart.id,
              date: when,
              notes,
              enteredById: user.id,
              lines: {
                create: rawLines.map((l) => {
                  const p = byId.get(l.productId)!;
                  return {
                    productId: l.productId,
                    unit: p.unit,
                    // Snapshot, so editing the product's pack size later cannot
                    // rewrite what this drop recorded.
                    packSize: p.packSize,
                    rate: new Prisma.Decimal(round2(l.rate)),
                    quantity: new Prisma.Decimal(round3(l.quantity)),
                  };
                }),
              },
            },
          });
          return no;
        });
        break;
      } catch (e) {
        if (e instanceof StockError) return { ok: false, error: e.message };
        const collision =
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === "P2002" &&
          (e.meta?.target as string[] | undefined)?.some((t) => t.includes("placementNo"));
        if (!collision || attempt === 4) throw e;
      }
    }

    revalidateRetail();
    return { ok: true, placementNo };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to record the drop." };
  }
}

export async function voidRetailPlacement(id: string, reason: string): Promise<ActionResult> {
  try {
    // Voiding silently puts stock back, so it is an admin action.
    //
    // Inside the try on purpose: requireAdmin() THROWS, and outside it that
    // throw escaped the action entirely instead of coming back as
    // { ok: false }. The caller then had a rejected promise rather than an
    // error to show, so a non-admin pressing this saw the button do nothing.
    const user = await requireAdmin();
    const p = await db.retailPlacement.findUnique({
      where: { id },
      select: { id: true, placementNo: true, voidedAt: true, _count: { select: { resolutions: true } } },
    });
    if (!p) return { ok: false, error: "That drop no longer exists." };
    if (p.voidedAt) return { ok: false, error: `${p.placementNo} is already voided.` };
    if (p._count.resolutions > 0) {
      return {
        ok: false,
        error: `${p.placementNo} has already been reported on and cannot be voided. Record what actually happened instead.`,
      };
    }
    await db.retailPlacement.update({
      where: { id },
      data: { voidedAt: new Date(), voidedById: user.id, voidReason: (reason ?? "").trim() || null },
    });
    revalidateRetail();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to void the drop." };
  }
}

// ── Resolution (what sold, what expired) ─────────────────────────────────────

export type ResolveInput = {
  placementId: string;
  date: string;
  entries: { lineId: string; soldQty: number; wastedQty: number }[];
  /** Optional payment taken on the spot. */
  paidAmount?: number;
  paymentHead?: string | null;
  notes?: string | null;
  /** One per dialog open — makes a double-click a no-op. */
  clientToken?: string | null;
};

export async function resolveRetailPlacement(
  data: ResolveInput
): Promise<{ ok: true; resolutionNo: string } | { ok: false; error: string }> {
  const user = await requireUser();
  await requireRole(RETAIL_ACCESS);
  try {
    const paid = round2(Math.max(0, Number(data.paidAmount) || 0));
    if (paid > 0.005 && !VISIBLE_HEADS.filter(isHeldHead).includes(data.paymentHead ?? "")) {
      return { ok: false, error: "Select where the money went." };
    }
    const when = !data.date || data.date === todayPKTString() ? new Date() : pktNoonToUTC(data.date);

    const out = await db.$transaction(async (tx) => {
      // One resolution at a time per drop, so two people reporting the same visit
      // cannot both pass the "still unaccounted" check.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"retail:placement:" + data.placementId}))`;

      const placement = await tx.retailPlacement.findUnique({
        where: { id: data.placementId },
        include: PLACEMENT_INCLUDE,
      });
      if (!placement) throw new StockError("That drop no longer exists.");
      if (placement.voidedAt) throw new StockError(`${placement.placementNo} was voided.`);

      const lines = placement.lines.map((l) => ({
        id: l.id,
        productName: l.product.name,
        unit: l.product.unit,
        rate: Number(l.rate),
        costPrice: l.product.costPrice == null ? null : Number(l.product.costPrice),
        quantity: Number(l.quantity),
        soldQty: Number(l.soldQty),
        wastedQty: Number(l.wastedQty),
      }));

      const entries = (data.entries ?? [])
        .map((e) => ({ lineId: e.lineId, soldQty: Number(e.soldQty) || 0, wastedQty: Number(e.wastedQty) || 0 }))
        .filter((e) => e.soldQty > 0.000001 || e.wastedQty > 0.000001);

      // The identical function the dialog runs while you type.
      const problem = validateResolution(lines, entries.length ? entries : [{ lineId: lines[0]?.id ?? "", soldQty: 0, wastedQty: 0 }]);
      if (problem) throw new StockError(problem);

      const rateOf = (lineId: string) => lines.find((l) => l.id === lineId)?.rate ?? 0;
      const costOf = (lineId: string) => lines.find((l) => l.id === lineId)?.costPrice ?? null;
      const totals = resolutionTotals(entries, rateOf, costOf);

      const resolutionNo = await nextNo(tx, "RetailResolution", "resolutionNo", "RR");

      // Money is owed only for what actually sold.
      let receivableId: string | null = null;
      if (totals.soldAmount > 0.005) {
        const receivable = await tx.retailReceivable.create({
          data: {
            retailVendorId: placement.retailVendorId,
            date: when,
            amount: new Prisma.Decimal(totals.soldAmount),
            received: new Prisma.Decimal(0),
            source: "PLACEMENT",
            notes: `Sold at mart — ${placement.placementNo}`,
          },
          select: { id: true },
        });
        receivableId = receivable.id;
      }

      await tx.retailResolution.create({
        data: {
          resolutionNo,
          placementId: placement.id,
          retailVendorId: placement.retailVendorId,
          date: when,
          soldAmount: new Prisma.Decimal(totals.soldAmount),
          wastedValue: new Prisma.Decimal(totals.wastedValue),
          wastedCost: totals.wastedCost == null ? null : new Prisma.Decimal(totals.wastedCost),
          notes: (data.notes ?? "").trim() || null,
          receivableId,
          clientToken: (data.clientToken ?? "").trim() || null,
          enteredById: user.id,
          lines: {
            create: entries.map((e) => ({
              placementLineId: e.lineId,
              soldQty: new Prisma.Decimal(round3(e.soldQty)),
              wastedQty: new Prisma.Decimal(round3(e.wastedQty)),
              rate: new Prisma.Decimal(round2(rateOf(e.lineId))),
              // Snapshotted: the cost is editable, and a loss already reported
              // must not move when it changes.
              unitCost: costOf(e.lineId) == null ? null : new Prisma.Decimal(round2(costOf(e.lineId)!)),
              amount: new Prisma.Decimal(totals.amounts[e.lineId] ?? 0),
            })),
          },
        },
      });

      // Running totals on the drop's own lines. `quantity` is never touched, so
      // the stock deduction stays exactly what was dropped.
      for (const e of entries) {
        await tx.retailPlacementLine.update({
          where: { id: e.lineId },
          data: {
            soldQty: { increment: new Prisma.Decimal(round3(e.soldQty)) },
            wastedQty: { increment: new Prisma.Decimal(round3(e.wastedQty)) },
          },
        });
      }

      if (paid > 0.005) {
        await applyReceipt(tx, {
          martId: placement.retailVendorId,
          martName: placement.retailVendor.name,
          amount: paid,
          head: data.paymentHead as PaymentHeadName,
          when,
          userId: user.id,
          note: `Retail receipt — ${placement.retailVendor.name} (${resolutionNo})`,
        });
      }

      return resolutionNo;
    });

    revalidateRetail();
    revalidatePath("/inventory/wastage");
    return { ok: true, resolutionNo: out };
  } catch (e) {
    if (e instanceof StockError) return { ok: false, error: e.message };
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const target = (e.meta?.target as string[] | undefined) ?? [];
      if (target.some((t) => t.includes("clientToken"))) {
        // The same dialog submitted twice — the first one counted.
        return { ok: false, error: "That report was already saved." };
      }
    }
    return { ok: false, error: e instanceof Error ? e.message : "Failed to save the report." };
  }
}

// ── Money in ─────────────────────────────────────────────────────────────────

export async function recordRetailReceipt(data: {
  retailVendorId: string;
  amount: number;
  head: string;
  date?: string;
  notes?: string | null;
}): Promise<{ ok: true; applied: number } | { ok: false; error: string }> {
  const user = await requireUser();
  await requireRole(RETAIL_ACCESS);
  try {
    const amount = round2(Number(data.amount));
    if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "Enter an amount greater than zero." };
    // Money coming IN — Rider Cash is not a receiving account (INFLOW_HEADS).
    if (!INFLOW_HEADS.includes(data.head)) return { ok: false, error: "Select where the money went." };

    const mart = await db.retailVendor.findUnique({
      where: { id: data.retailVendorId },
      select: { id: true, name: true },
    });
    if (!mart) return { ok: false, error: "That shop is not on the list." };

    const when = !data.date || data.date === todayPKTString() ? new Date() : pktNoonToUTC(data.date);

    const applied = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"retail:vendor:" + mart.id}))`;
      return applyReceipt(tx, {
        martId: mart.id,
        martName: mart.name,
        amount,
        head: data.head as PaymentHeadName,
        when,
        userId: user.id,
        note: (data.notes ?? "").trim() || `Retail receipt — ${mart.name}`,
      });
    });

    revalidateRetail();
    return { ok: true, applied };
  } catch (e) {
    if (e instanceof StockError) return { ok: false, error: e.message };
    return { ok: false, error: e instanceof Error ? e.message : "Failed to record the payment." };
  }
}

/**
 * Apply money received from a mart: FIFO across its open receivables, then one
 * ordinary Payment row (so head balances pick it up with no changes anywhere)
 * plus the RetailPayment link that says which shop it came from.
 *
 * Money IN, so there is no head-funds guard — that guards outflows.
 */
async function applyReceipt(
  tx: Prisma.TransactionClient,
  args: { martId: string; martName: string; amount: number; head: PaymentHeadName; when: Date; userId: string; note: string }
): Promise<number> {
  const open = await tx.retailReceivable.findMany({
    where: { retailVendorId: args.martId },
    orderBy: { date: "asc" },
    select: { id: true, amount: true, received: true },
  });
  const owed = martBalance(open.map((r) => ({ amount: Number(r.amount), received: Number(r.received) })));
  if (args.amount - owed > 0.005) {
    throw new StockError(
      owed <= 0.005
        ? `${args.martName} does not owe anything right now. Record the sale first.`
        : `${args.martName} only owes ₨${Math.round(owed).toLocaleString("en-PK")}. Reduce the amount, or record the sale first.`
    );
  }

  const spread = applyFifo(
    open.map((r) => ({ id: r.id, amount: Number(r.amount), received: Number(r.received) })),
    args.amount
  );
  for (const s of spread) {
    await tx.retailReceivable.update({
      where: { id: s.id },
      data: { received: { increment: new Prisma.Decimal(s.take) } },
    });
  }

  const payment = await tx.payment.create({
    data: {
      date: args.when,
      customerId: null,
      amount: new Prisma.Decimal(args.amount),
      head: args.head,
      notes: args.note,
      enteredById: args.userId,
    },
    select: { id: true },
  });
  await tx.retailPayment.create({
    data: {
      retailVendorId: args.martId,
      date: args.when,
      amount: new Prisma.Decimal(args.amount),
      head: args.head,
      paymentId: payment.id,
      notes: args.note,
      enteredById: args.userId,
    },
  });
  return args.amount;
}

// ── Shared bits ──────────────────────────────────────────────────────────────

// ── Retail stock ───────────────────────────────────────────────────────────
//
// Retail products sit outside the milk pipeline, so no dispatch confirmation and
// no production run brings their stock in — the count is entered here instead.
// Quantity only: this deliberately creates no expense and no payable. The cost
// price exists to value what we lose, not to book what we spent.

export type RetailStockRow = {
  productId: string;
  productName: string;
  unit: Unit;
  packSize: number | null;
  costPrice: number | null;
  defaultRate: number;
  /** At the farm, ready to sell or drop. */
  onHand: number;
  /** Still unsold at shops. NOT part of onHand — it left storage when it was dropped. */
  atShops: number;
  /** onHand × costPrice, or null when no cost has been set. */
  stockValue: number | null;
};

export type RetailStockEntryRow = {
  id: string;
  date: string;
  productName: string;
  unit: Unit;
  quantity: number;
  note: string | null;
  enteredBy: string | null;
  voided: boolean;
};

export type RetailStockData = {
  rows: RetailStockRow[];
  entries: RetailStockEntryRow[];
  /** Products with no cost set — every loss figure for them reads as a dash. */
  missingCost: number;
  totalStockValue: number;
  today: string;
  dbReady: boolean;
};

export async function getRetailStock(): Promise<RetailStockData> {
  await requireRole(RETAIL_ACCESS);
  const empty: RetailStockData = {
    rows: [], entries: [], missingCost: 0, totalStockValue: 0,
    today: todayPKTString(), dbReady: false,
  };
  try {
    const [products, onHand, placementLines, entries] = await Promise.all([
      db.product.findMany({
        where: { active: true, retailOnly: true },
        select: { id: true, name: true, unit: true, packSize: true, costPrice: true, defaultRate: true },
        orderBy: { name: "asc" },
      }),
      getOnHandByProduct(),
      db.retailPlacementLine.findMany({
        where: { placement: { voidedAt: null }, product: { retailOnly: true } },
        select: { productId: true, quantity: true, soldQty: true, wastedQty: true },
      }),
      db.retailStockEntry.findMany({
        where: { product: { retailOnly: true } },
        orderBy: { date: "desc" },
        take: 100,
        select: {
          id: true, date: true, quantity: true, note: true, voidedAt: true,
          product: { select: { name: true, unit: true } },
          enteredBy: { select: { name: true } },
        },
      }),
    ]);

    const atShops = new Map<string, number>();
    for (const l of placementLines) {
      const open = openQty({
        quantity: Number(l.quantity),
        soldQty: Number(l.soldQty),
        wastedQty: Number(l.wastedQty),
      });
      atShops.set(l.productId, (atShops.get(l.productId) ?? 0) + open);
    }

    const rows: RetailStockRow[] = products.map((p) => {
      const cost = p.costPrice == null ? null : Number(p.costPrice);
      const have = onHand.get(p.id) ?? 0;
      return {
        productId: p.id,
        productName: p.name,
        unit: p.unit,
        packSize: p.packSize == null ? null : Number(p.packSize),
        costPrice: cost,
        defaultRate: Number(p.defaultRate),
        onHand: have,
        atShops: Math.round((atShops.get(p.id) ?? 0) * 1000) / 1000,
        stockValue: cost == null ? null : round2(have * cost),
      };
    });

    return {
      rows,
      entries: entries.map((e) => ({
        id: e.id,
        date: toDateStrPKT(e.date),
        productName: e.product.name,
        unit: e.product.unit,
        quantity: Number(e.quantity),
        note: e.note,
        enteredBy: e.enteredBy?.name ?? null,
        voided: e.voidedAt != null,
      })),
      missingCost: rows.filter((r) => r.costPrice == null).length,
      totalStockValue: round2(rows.reduce((s, r) => s + (r.stockValue ?? 0), 0)),
      today: todayPKTString(),
      dbReady: true,
    };
  } catch {
    return empty;
  }
}

export async function addRetailStock(data: {
  productId: string;
  quantity: number;
  date?: string;
  note?: string;
}): Promise<ActionResult> {
  const user = await requireUser();
  await requireRole(RETAIL_ACCESS);
  try {
    const product = await db.product.findFirst({
      where: { id: data.productId, active: true },
      select: { id: true, name: true, unit: true, retailOnly: true },
    });
    if (!product) return { ok: false, error: "That product no longer exists." };
    // The formula only reads entries on retailOnly products, so a row here would
    // already be inert — but refusing it outright keeps the table meaning one thing.
    if (!product.retailOnly) {
      return {
        ok: false,
        error: `${product.name} is farm stock — it arrives through production and packaging, not here.`,
      };
    }
    const qty = Number(data.quantity);
    if (!Number.isFinite(qty) || qty <= 0) return { ok: false, error: "Enter how many to add." };
    const problem = quantityProblem(product.name, product.unit, qty);
    if (problem) return { ok: false, error: problem };

    // No advisory lock here: this only ever INSERTs, and on-hand is a sum over
    // rows, so there is no read-modify-write for a concurrent sale to lose.
    await db.retailStockEntry.create({
      data: {
        date: data.date ? pktNoonToUTC(data.date) : new Date(),
        productId: product.id,
        quantity: new Prisma.Decimal(qty),
        note: data.note?.trim() || null,
        enteredById: user.id,
      },
    });
    revalidateRetail();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to add stock." };
  }
}

export async function setProductCost(productId: string, costPrice: number | null): Promise<ActionResult> {
  // This decides what every future loss is worth, so it stays with the
  // full-access roles rather than the retail manager.
  await requireRole(FULL_ACCESS);
  try {
    if (costPrice != null && (!Number.isFinite(costPrice) || costPrice < 0)) {
      return { ok: false, error: "Cost cannot be negative." };
    }
    const product = await db.product.findUnique({ where: { id: productId }, select: { id: true } });
    if (!product) return { ok: false, error: "That product no longer exists." };
    await db.product.update({
      where: { id: productId },
      data: { costPrice: costPrice == null ? null : new Prisma.Decimal(round2(costPrice)) },
    });
    revalidateRetail();
    revalidatePath("/inventory/products");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to save the cost." };
  }
}

export async function voidRetailStockEntry(id: string, reason: string): Promise<ActionResult> {
  // Voiding an ADD removes stock, unlike voiding a drop which returns it — so
  // unlike voidRetailPlacement this one has to be stock-guarded.
  const user = await requireAdmin();
  try {
    const note = reason.trim();
    if (!note) return { ok: false, error: "Say why this entry is being removed." };

    return await db.$transaction(async (tx) => {
      const entry = await tx.retailStockEntry.findUnique({
        where: { id },
        select: {
          id: true,
          quantity: true,
          voidedAt: true,
          product: { select: { id: true, name: true, unit: true } },
        },
      });
      if (!entry) return { ok: false as const, error: "That entry no longer exists." };
      if (entry.voidedAt) return { ok: false as const, error: "That entry has already been removed." };

      // The same key every other outflow takes, so this cannot race a sale or a drop.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"stock:" + entry.product.id}))`;
      const onHand = await getOnHandByProduct();
      const have = onHand.get(entry.product.id) ?? 0;
      const qty = Number(entry.quantity);
      if (qty > have + 1e-6) {
        return {
          ok: false as const,
          error: `Only ${fmtQty(have)}${unitSuffix(entry.product.unit)} of ${entry.product.name} is left — the rest has been sold or dropped, so this entry can no longer be removed.`,
        };
      }
      await tx.retailStockEntry.update({
        where: { id },
        data: { voidedAt: new Date(), voidedById: user.id, voidReason: note },
      });
      return { ok: true as const };
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to remove the entry." };
  } finally {
    revalidateRetail();
  }
}

class StockError extends Error {}

/** "RP-0007" / "RR-0012", continuing from the highest number already used. */
async function nextNo(
  tx: Prisma.TransactionClient,
  table: string,
  column: string,
  prefix: string
): Promise<string> {
  const rows = await tx.$queryRawUnsafe<{ max: number | null }[]>(
    `SELECT MAX(CAST(substring("${column}" from '^${prefix}-([0-9]+)$') AS INTEGER)) AS max FROM "${table}"`
  );
  const next = (rows[0]?.max ?? 0) + 1;
  return `${prefix}-${String(next).padStart(4, "0")}`;
}

function fmtQty(n: number): string {
  return n % 1 === 0 ? n.toFixed(0) : String(Math.round(n * 1000) / 1000);
}


function revalidateRetail() {
  revalidatePath("/retail");
  revalidatePath("/retail/inventory");
  revalidatePath("/inventory");
  revalidatePath("/ledgers");
  revalidatePath("/");
  // Stock decides what these two screens may offer, so they go stale too.
  revalidatePath("/over-the-counter/sale");
  revalidatePath("/customers/pre-delivery");
}
