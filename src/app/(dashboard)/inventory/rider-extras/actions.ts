"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";

import { requireRole, FULL_ACCESS } from "@/lib/auth";
import { db } from "@/lib/db";
import { dateStrRangePKT, toDateStrPKT } from "@/lib/pkt";
import { END_OF_SHIFT_RETURN_REASON } from "@/lib/rider-stock";

// Extras are set on the Shift Editor with the rest of the shift's load (saved by
// Save route / Save plan); returns are confirmed on the Rider Item Returns page.
// There is no standalone page, so no rider/shift/product picker context is needed here.

export type ExtraRow = {
  id: string;
  productId: string;
  productName: string;
  unit: string;
  givenQty: number;
  returnedQty: number;
  status: string; // OUT | RETURNED
  confirmedByName: string | null;
};

export async function getRiderExtras(shiftId: string, date: string): Promise<{ rows: ExtraRow[]; dbReady: boolean }> {
  await requireRole(FULL_ACCESS);
  if (!shiftId || !date) return { rows: [], dbReady: true };
  try {
    const rows = await db.riderExtraItem.findMany({
      where: { shiftId, date: dateStrRangePKT(date) },
      include: { product: { select: { name: true, unit: true } } },
      orderBy: { createdAt: "asc" },
    });
    return {
      dbReady: true,
      rows: rows.map((r) => ({
        id: r.id,
        productId: r.productId,
        productName: r.product.name,
        unit: r.product.unit,
        givenQty: Number(r.givenQty),
        returnedQty: Number(r.returnedQty),
        status: r.status,
        confirmedByName: r.confirmedByName,
      })),
    };
  } catch {
    return { rows: [], dbReady: false };
  }
}

// Spare stock still out with a rider (given, not yet confirmed returned), grouped
// per rider + shift. Feeds the Inventory > Rider Item Returns page, where the
// manager receives the leftovers back into inventory.
export type RiderReturnItem = {
  id: string;
  productName: string;
  unit: string;
  givenQty: number;
  returnedQty: number;
  /** OUT = still with the rider; RETURNED = the office has received it back. */
  status: string;
};
export type RiderReturnGroup = {
  riderId: string;
  riderName: string;
  shiftId: string;
  shiftName: string;
  /** "YYYY-MM-DD" PKT day the extras were handed out. */
  date: string;
  /** False once every item has been received back — kept on the page as history. */
  open: boolean;
  items: RiderReturnItem[];
};

export async function getRiderReturns(): Promise<{ groups: RiderReturnGroup[]; dbReady: boolean }> {
  // Packaging staff work the Rider Item Returns page too.
  await requireRole([...FULL_ACCESS, "PACKAGING"]);
  try {
    // Everything still out, plus what has been received back recently, so the page
    // shows given against returned instead of dropping a group the moment it is
    // confirmed (which left nothing to see).
    const rows = await db.riderExtraItem.findMany({
      where: {
        // Extras can be planned before a rider is assigned to the shift, so a row
        // with no rider on it is still stock that went out and has to come back.
        OR: [{ status: "OUT" }, { date: { gte: new Date(Date.now() - 14 * 86_400_000) } }],
      },
      select: {
        id: true, givenQty: true, returnedQty: true, status: true, date: true, riderId: true, shiftId: true,
        product: { select: { name: true, unit: true } },
        shift: { select: { name: true } },
        rider: { select: { user: { select: { name: true } } } },
      },
      orderBy: { createdAt: "asc" },
    });

    // One group per rider + shift, so the manager receives a rider's leftovers for
    // a specific shift together.
    const map = new Map<string, RiderReturnGroup>();
    for (const e of rows) {
      const date = toDateStrPKT(e.date);
      const key = `${e.riderId ?? "none"}:${e.shiftId}:${date}`;
      const g = map.get(key) ?? {
        riderId: e.riderId ?? "",
        riderName: e.rider?.user?.name ?? "Rider",
        shiftId: e.shiftId,
        shiftName: e.shift?.name ?? "—",
        date,
        open: false,
        items: [],
      };
      if (e.status === "OUT") g.open = true;
      g.items.push({
        id: e.id,
        productName: e.product.name,
        unit: e.product.unit,
        givenQty: Number(e.givenQty),
        returnedQty: Number(e.returnedQty),
        status: e.status,
      });
      map.set(key, g);
    }
    // Still out first (there is something to do), then the most recent history.
    const groups = [...map.values()].sort(
      (a, b) =>
        Number(b.open) - Number(a.open) ||
        b.date.localeCompare(a.date) ||
        a.riderName.localeCompare(b.riderName) ||
        a.shiftName.localeCompare(b.shiftName)
    );
    return { groups, dbReady: true };
  } catch {
    return { groups: [], dbReady: false };
  }
}

// ── What riders send back at the end of a shift, from the mobile app ──────────
// The app writes these straight to InventoryMovement (type RETURNED, reason
// "End of shift return", with the rider stamped on the row). They are already
// counted back into storage by the on-hand formula, so this is a record of what
// came in — nothing to confirm. Until now no screen read them at all, so the
// office could not see the milk and eggs the riders had handed back.
export type AppReturnGroup = {
  key: string;
  /** "YYYY-MM-DD" PKT day */
  date: string;
  riderName: string;
  /** One line per product, quantities added up across the day's returns. */
  items: { productName: string; unit: string; quantity: number }[];
  /** PKT clock time of the last return that day, e.g. "18:42". */
  lastTime: string;
};

/** "18:42" in PKT — riders finish in the evening, so the time tells them apart. */
function pktTimeOfDay(d: Date): string {
  return d.toLocaleTimeString("en-GB", { timeZone: "Asia/Karachi", hour: "2-digit", minute: "2-digit" });
}

export async function getAppRiderReturns(days = 14): Promise<AppReturnGroup[]> {
  await requireRole([...FULL_ACCESS, "PACKAGING"]);
  try {
    const rows = await db.inventoryMovement.findMany({
      where: {
        type: "RETURNED",
        reason: END_OF_SHIFT_RETURN_REASON,
        date: { gte: new Date(Date.now() - days * 86_400_000) },
      },
      select: {
        id: true, date: true, quantity: true,
        product: { select: { name: true, unit: true } },
        rider: { select: { user: { select: { name: true } } } },
      },
      orderBy: { date: "desc" },
      take: 500,
    });

    // One line per product per rider-day. A rider who records two returns in an
    // evening was listing the same milk twice, which read as a muddle.
    const map = new Map<string, AppReturnGroup & { byProduct: Map<string, { productName: string; unit: string; quantity: number }> }>();
    for (const m of rows) {
      const date = toDateStrPKT(m.date);
      const riderName = m.rider?.user?.name ?? "Rider";
      const key = `${date}:${riderName}`;
      const g = map.get(key) ?? {
        key, date, riderName, items: [],
        lastTime: pktTimeOfDay(m.date), // rows arrive newest first
        byProduct: new Map<string, { productName: string; unit: string; quantity: number }>(),
      };
      const pk = `${m.product.name}:${m.product.unit}`;
      const line = g.byProduct.get(pk) ?? { productName: m.product.name, unit: m.product.unit, quantity: 0 };
      line.quantity += Number(m.quantity);
      g.byProduct.set(pk, line);
      map.set(key, g);
    }
    return [...map.values()].map((g) => ({
      key: g.key,
      date: g.date,
      riderName: g.riderName,
      lastTime: g.lastTime,
      items: [...g.byProduct.values()].sort((a, b) => a.productName.localeCompare(b.productName)),
    }));
  } catch {
    return [];
  }
}

// Extras are no longer handed out here. They are set in the Shift Editor with the
// rest of the shift's load and saved by Save route / Save plan (saveRoute in
// customers/pre-delivery/actions.ts), which checks the whole load against Retail.
export type ExtraResult = { ok: true } | { ok: false; error: string };

export async function confirmExtraReturn(extraId: string, returnedQty: number): Promise<ExtraResult> {
  const user = await requireRole([...FULL_ACCESS, "PACKAGING"]);

  const qty = Number(returnedQty);
  if (!extraId) return { ok: false, error: "Missing item." };
  if (!Number.isFinite(qty) || qty < 0) return { ok: false, error: "Enter a valid returned quantity (0 or more)." };

  const row = await db.riderExtraItem.findUnique({ where: { id: extraId }, select: { givenQty: true, status: true } });
  if (!row) return { ok: false, error: "That extra item no longer exists." };
  if (row.status !== "OUT") return { ok: false, error: "This return was already confirmed." };
  if (qty > Number(row.givenQty) + 1e-6) return { ok: false, error: "Cannot return more than was given." };

  try {
    // Compare-and-swap on status so a double-confirm can't restock twice.
    const res = await db.riderExtraItem.updateMany({
      where: { id: extraId, status: "OUT" },
      data: { returnedQty: new Prisma.Decimal(qty), status: "RETURNED", confirmedById: user.id, confirmedByName: user.name },
    });
    if (res.count === 0) return { ok: false, error: "This return was already confirmed." };
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not confirm the return. Please try again." };
  } finally {
    revalidatePath("/inventory/rider-returns"); // the Rider Item Returns page
    revalidatePath("/customers/pre-delivery"); // the shift editor's extras list
    revalidatePath("/inventory");
    revalidatePath("/");
  }
}
