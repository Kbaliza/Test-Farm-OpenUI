"use server";

import { revalidatePath } from "next/cache";
import type { Unit } from "@/lib/units";
import { Prisma } from "@prisma/client";

import type { Role } from "@prisma/client";
import { requireRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { getOnHandByProduct } from "@/lib/inventory-onhand";

// The pipeline stages a manual write-off can be attributed to (the Van stage was
// removed). The Wastage log filter (src/components/inventory/wastage-client.tsx)
// additionally shows a read-only "Rider delivery" stage that manual entry omits.
// "Riders" is stock written off on the riders' side, logged from the office. It
// deducts from storage like every manual entry; the app's own rider wastage stays
// under "Rider delivery".
const WASTE_STAGES = ["Production", "Packaging", "Retail", "Yoghurt", "Riders"] as const;
export type WasteStage = (typeof WASTE_STAGES)[number];

// The standard dispute-reason list (canonical copy — mirrors the per-dispatch
// DISPUTE_REASONS in the packaging/van/retail clients).
const STANDARD_REASONS = [
  "Spillage during transport",
  "Packaging damage",
  "Packet leaked",
  "During packaging",
  "Van To Retail",
  "Yogurt Making",
  "Freezer",
  "Spoiled",
  "Human Error",
  "Packaging Seal",
  "Chiller Failure",
  "Other",
];

export type WasteEntryProduct = {
  id: string;
  name: string;
  unit: Unit;
  inStorage: number;
};

export type WasteEntryContext = {
  dbReady: boolean;
  loggedByName: string;
  stages: readonly string[];
  reasons: string[];
  products: WasteEntryProduct[];
};

// Packaging staff use both the Waste entry page and the Packaging page's wastage
// card (which is always the Packaging stage).
const PACKAGING_ACCESS: Role[] = ["ADMIN", "MANAGER", "PACKAGING"];
const PACKAGING_STAGE = "Packaging";

export async function getWasteEntryContext(): Promise<WasteEntryContext> {
  const user = await requireRole(PACKAGING_ACCESS);
  return loadWasteContext(user.name, WASTE_STAGES);
}

/** The same form data for the Packaging page's wastage card. */
export async function getPackagingWasteContext(): Promise<WasteEntryContext> {
  const user = await requireRole(PACKAGING_ACCESS);
  return loadWasteContext(user.name, [PACKAGING_STAGE]);
}

async function loadWasteContext(loggedByName: string, stages: readonly string[]): Promise<WasteEntryContext> {
  try {
    const [products, onHand, savedReasonRows] = await Promise.all([
      db.product.findMany({
        where: { active: true, retailOnly: false },
        select: { id: true, name: true, unit: true },
        orderBy: { name: "asc" },
      }),
      getOnHandByProduct(),
      db.inventoryMovement.findMany({
        where: { type: "WASTAGE" },
        distinct: ["reason"],
        select: { reason: true },
      }),
    ]);

    // Distinct saved WASTAGE reasons ∪ the standard dispute list, deduped, "Other" last.
    const saved = savedReasonRows.map((r) => r.reason).filter((r): r is string => !!r && r.trim() !== "");
    const set = new Set<string>([...saved, ...STANDARD_REASONS]);
    const reasons = [...set].filter((r) => r !== "Other").sort((a, b) => a.localeCompare(b));
    reasons.push("Other");

    return {
      dbReady: true,
      loggedByName,
      stages,
      reasons,
      products: products.map((p) => ({
        id: p.id,
        name: p.name,
        unit: p.unit as WasteEntryProduct["unit"],
        inStorage: onHand.get(p.id) ?? 0,
      })),
    };
  } catch {
    return { dbReady: false, loggedByName, stages, reasons: [], products: [] };
  }
}

const UNIT_LABEL: Record<string, string> = { LITER: "L", KG: "kg", PIECE: "pc" };

// "YYYY-MM-DDTHH:MM" (from a datetime-local input, PKT wall-clock) → UTC instant.
// Returns null on a malformed value so the caller can fall back to "now".
function pktLocalToUTC(local: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, mi) - 5 * 60 * 60 * 1000);
}

export type CreateWasteEntryInput = {
  productId: string;
  quantity: number;
  stage: string;
  reason: string;
  date: string; // datetime-local value (PKT)
};

export type WasteEntryResult = { ok: true } | { ok: false; error: string };

export async function createWasteEntry(input: CreateWasteEntryInput): Promise<WasteEntryResult> {
  const user = await requireRole(PACKAGING_ACCESS);
  return saveWasteEntry(user.id, input);
}

/** Packaging page: always the Packaging stage, whatever the browser sent. */
export async function createPackagingWasteEntry(input: CreateWasteEntryInput): Promise<WasteEntryResult> {
  const user = await requireRole(PACKAGING_ACCESS);
  return saveWasteEntry(user.id, { ...input, stage: PACKAGING_STAGE });
}

export type PackagingWasteRow = {
  id: string;
  date: string; // ISO
  productName: string;
  unit: Unit;
  quantity: number;
  reason: string;
  loggedBy: string;
};

/** Packaging-stage write-offs from the last 30 days, newest first. */
export async function getPackagingWasteLog(): Promise<PackagingWasteRow[]> {
  await requireRole(PACKAGING_ACCESS);
  try {
    const since = new Date(Date.now() - 30 * 86_400_000);
    const rows = await db.inventoryMovement.findMany({
      // The same rows the Wastage log shows under Packaging for manual entries.
      where: { type: "WASTAGE", stage: PACKAGING_STAGE, riderId: null, date: { gte: since } },
      select: {
        id: true, date: true, quantity: true, reason: true,
        product: { select: { name: true, unit: true } },
        enteredBy: { select: { name: true } },
      },
      orderBy: { date: "desc" },
      take: 100,
    });
    return rows.map((m) => ({
      id: m.id,
      date: m.date.toISOString(),
      productName: m.product.name,
      unit: m.product.unit as Unit,
      quantity: Number(m.quantity),
      reason: m.reason ?? "",
      loggedBy: m.enteredBy?.name ?? "—",
    }));
  } catch {
    return [];
  }
}

async function saveWasteEntry(userId: string, input: CreateWasteEntryInput): Promise<WasteEntryResult> {
  const quantity = Number(input.quantity);
  if (!input.productId) return { ok: false, error: "Pick a product." };
  if (!Number.isFinite(quantity) || quantity <= 0) return { ok: false, error: "Enter a waste quantity greater than 0." };
  if (!WASTE_STAGES.includes(input.stage as WasteStage)) return { ok: false, error: "Pick a valid stage." };
  const reason = (input.reason ?? "").trim();
  if (!reason) return { ok: false, error: "Pick or enter a reason." };

  const when = pktLocalToUTC(input.date) ?? new Date();

  const product = await db.product.findFirst({
    where: { id: input.productId, active: true },
    select: { id: true, name: true, unit: true, retailOnly: true },
  });
  if (!product) return { ok: false, error: "That product no longer exists." };
  if (product.retailOnly) {
    return { ok: false, error: `${product.name} is a retail product — this screen writes off milk-pipeline stock. Its losses are reported on the Retail page when a shop returns it.` };
  }

  try {
    return await db.$transaction(async (tx) => {
      // Serialize against every stock-outflow path (waste-entry, rider-extras, OTC
      // sale) on this product via the SHARED "stock:" lock key, so two concurrent
      // outflows can't each pass the ≤-stock check and jointly overshoot. The re-read
      // below then sees any committed sibling and validates against the reduced stock.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"stock:" + product.id}))`;

      const onHand = (await getOnHandByProduct()).get(product.id) ?? 0;
      if (quantity > onHand + 1e-6) {
        const ul = UNIT_LABEL[product.unit] ?? "";
        return {
          ok: false as const,
          error: `Cannot waste more than current stock (${onHand.toFixed(onHand % 1 === 0 ? 0 : 1)} ${ul} in storage).`,
        };
      }

      await tx.inventoryMovement.create({
        data: {
          date: when,
          type: "WASTAGE",
          productId: product.id,
          quantity: new Prisma.Decimal(quantity),
          reason,                 // shown verbatim in the Wastage log's Notes column
          stage: input.stage,     // marks this as a manual entry + drives the log's Stage column + the storage deduction
          enteredById: userId,    // "logged by" = this user
        },
      });

      return { ok: true as const };
    });
  } catch {
    return { ok: false, error: "Could not save the waste entry. Please try again." };
  } finally {
    revalidatePath("/inventory/waste-entry");
    revalidatePath("/inventory/farm-arrival");
    revalidatePath("/inventory/wastage");
    revalidatePath("/inventory");
    revalidatePath("/");
  }
}
