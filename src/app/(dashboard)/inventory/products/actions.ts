"use server";

import { requireRole, FULL_ACCESS } from "@/lib/auth";

import { UNITS, isPackUnit, packSizeProblem, type Unit } from "@/lib/units";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";

export type ProductRow = {
  id: string;
  name: string;
  unit: Unit;
  defaultRate: number;
  active: boolean;
  /** Sold at retail rather than through the milk pipeline; stocked on the Retail Inventory page. */
  retailOnly: boolean;
  /** The size of one pack, for ml/g products. Null for everything else. */
  packSize: number | null;
  createdAt: string;
};

export type ActionResult = { ok: true } | { ok: false; error: string };

export async function getProducts(): Promise<{ products: ProductRow[]; dbReady: boolean }> {
  await requireRole(FULL_ACCESS);
  try {
    const products = await db.product.findMany({
      orderBy: { name: "asc" },
    });
    return {
      products: products.map((p) => ({
        id: p.id,
        name: p.name,
        unit: p.unit,
        defaultRate: Number(p.defaultRate),
        active: p.active,
        retailOnly: p.retailOnly,
        packSize: p.packSize == null ? null : Number(p.packSize),
        createdAt: p.createdAt.toISOString(),
      })),
      dbReady: true,
    };
  } catch {
    return { products: [], dbReady: false };
  }
}

export type ProductInput = {
  name: string;
  unit: Unit;
  defaultRate: number;
  retailOnly?: boolean;
  packSize?: number | null;
};

/**
 * A pack size belongs to a pack unit and nowhere else, so it is dropped rather
 * than argued with when the unit is not one — which is what the write already
 * did. Switching a bottle from ml to litres would otherwise be refused over a
 * value the save was going to discard anyway.
 */
function cleanPackSize(unit: Unit, packSize: number | null | undefined): number | null {
  return isPackUnit(unit) ? (packSize ?? null) : null;
}

/**
 * Why these values cannot be saved, or null when they are fine. Shared by add and
 * edit so the two can never disagree, and enforced here rather than in the form —
 * a server action is a directly-invocable POST.
 */
function productProblem(data: ProductInput): string | null {
  if (!data.name.trim()) return "Product name is required.";
  if (!UNITS.includes(data.unit)) return "Choose a unit.";
  if (!Number.isFinite(data.defaultRate) || data.defaultRate < 0) return "Rate cannot be negative.";
  // ml and g exist for bottles and sachets. Allowing them on a
  // stock-tracked product would put a pack count into the litre figures that the
  // production and packaging screens add up.
  if (isPackUnit(data.unit) && !data.retailOnly) {
    return "Millilitre and gram are for retail-only products — tick “Retail only” first.";
  }
  return packSizeProblem(data.unit, data.packSize ?? null);
}

export async function addProduct(data: ProductInput): Promise<ActionResult> {
  await requireRole(FULL_ACCESS);
  const packSize = cleanPackSize(data.unit, data.packSize);
  const problem = productProblem({ ...data, packSize });
  if (problem) return { ok: false, error: problem };

  try {
    await db.product.create({
      data: {
        name: data.name.trim(),
        unit: data.unit,
        defaultRate: new Prisma.Decimal(data.defaultRate),
        retailOnly: !!data.retailOnly,
        packSize: packSize == null ? null : new Prisma.Decimal(packSize),
      },
    });
    revalidatePath("/inventory/products");
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to add product";
    if (msg.includes("Unique constraint")) return { ok: false, error: "A product with that name already exists." };
    return { ok: false, error: msg };
  }
}

/**
 * Whether this product has ever moved as stock.
 *
 * Every table the on-hand figure is built from, which is the question that
 * matters: if any of them holds a row, the product has real stock history and
 * pulling it out of the stock screens would strand that history where nothing
 * reports it. Billing and subscription rows are deliberately NOT in this list —
 * they are commercial records and carry no stock.
 */
async function stockHistoryOf(productId: string): Promise<string | null> {
  const where = { where: { productId } };
  const [production, moves, routeItems, deliveries, otcSales, otcPurchases, extras, samples, retail, retailStock] =
    await Promise.all([
      db.productionLog.count(where),
      db.inventoryMovement.count(where),
      db.routeStopItem.count(where),
      db.deliveryEntry.count(where),
      db.otcSaleLine.count(where),
      db.otcPurchaseLine.count(where),
      db.riderExtraItem.count(where),
      db.sampleItem.count(where),
      db.retailPlacementLine.count(where),
      // Retail stock lives in its own table. Without it here, a bottle with
      // 100 counted in could be un-ticked and walk into the milk screens
      // carrying stock those screens have never heard of.
      db.retailStockEntry.count(where),
    ]);
  const found: string[] = [];
  if (production) found.push(`${production} production ${production === 1 ? "entry" : "entries"}`);
  if (moves) found.push(`${moves} stock ${moves === 1 ? "movement" : "movements"}`);
  if (routeItems) found.push(`${routeItems} round ${routeItems === 1 ? "item" : "items"}`);
  if (deliveries) found.push(`${deliveries} ${deliveries === 1 ? "delivery" : "deliveries"}`);
  if (otcSales || otcPurchases) found.push(`${otcSales + otcPurchases} counter lines`);
  if (extras) found.push(`${extras} rider ${extras === 1 ? "extra" : "extras"}`);
  if (samples) found.push(`${samples} sample ${samples === 1 ? "line" : "lines"}`);
  if (retail) found.push(`${retail} mart ${retail === 1 ? "line" : "lines"}`);
  if (retailStock) found.push(`${retailStock} stock ${retailStock === 1 ? "entry" : "entries"}`);
  return found.length === 0 ? null : found.join(", ");
}

/**
 * Edit a product: its name, unit, pack size, rate, and whether it is stock-tracked.
 *
 * `retailOnly` may only be moved while the product has no stock history. Turning
 * it on for a product that has some would pull it out of every stock screen and
 * silently change past Milk Flow and reconciliation figures; turning it off would
 * put a product with no stock behind it into them. Once it has moved as stock the
 * flag is settled, and the form says so rather than failing quietly.
 */
export async function updateProduct(
  id: string,
  data: {
    name: string;
    unit: Unit;
    defaultRate: number;
    packSize?: number | null;
    retailOnly?: boolean;
  }
): Promise<ActionResult> {
  await requireRole(FULL_ACCESS);
  try {
    const existing = await db.product.findUnique({
      where: { id },
      select: { retailOnly: true, name: true },
    });
    if (!existing) return { ok: false, error: "That product no longer exists." };

    const retailOnly = data.retailOnly ?? existing.retailOnly;
    if (retailOnly !== existing.retailOnly) {
      const history = await stockHistoryOf(id);
      if (history) {
        return {
          ok: false,
          error: retailOnly
            ? `“${existing.name}” already has stock history (${history}), so it cannot become retail-only — that history would vanish from the stock screens.`
            : `“${existing.name}” already has records against it (${history}), so it cannot start being stock-tracked — there is no stock behind them.`,
        };
      }
    }

    const packSize = cleanPackSize(data.unit, data.packSize);
    const problem = productProblem({ ...data, retailOnly, packSize });
    if (problem) return { ok: false, error: problem };

    await db.product.update({
      where: { id },
      data: {
        name: data.name.trim(),
        unit: data.unit,
        defaultRate: new Prisma.Decimal(data.defaultRate),
        retailOnly,
        packSize: packSize == null ? null : new Prisma.Decimal(packSize),
      },
    });
    revalidatePath("/inventory/products");
    revalidatePath("/retail");
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to update the product";
    if (msg.includes("Unique constraint")) return { ok: false, error: "A product with that name already exists." };
    return { ok: false, error: msg };
  }
}

export async function deleteProduct(id: string): Promise<ActionResult> {
  await requireRole(FULL_ACCESS);
  try {
    // Soft-delete: deactivate so historical records are preserved
    await db.product.update({
      where: { id },
      data: { active: false },
    });
    revalidatePath("/inventory/products");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to delete product" };
  }
}

export async function restoreProduct(id: string): Promise<ActionResult> {
  await requireRole(FULL_ACCESS);
  try {
    await db.product.update({
      where: { id },
      data: { active: true },
    });
    revalidatePath("/inventory/products");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to restore product" };
  }
}
