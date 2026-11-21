"use server";

import { requireRole } from "@/lib/auth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { randomUUID } from "crypto";
import { todayPKTString, dateStrRangePKT } from "@/lib/pkt";
import {
  DILUTION_REASON, DILUTION_REASON_STORAGE, DILUTION_REASONS,
  preparedBuffalo, cowLeft, dilutionProblem, splitDilutionSource,
} from "@/lib/buffalo-dilution";
import { quantityProblem } from "@/lib/quantity";
import { getMixMilkAvailability, isPackagingUnlocked } from "./mix-milk-actions";

export type DilutionEntry = {
  id: string;
  date: string;
  pktDate: string | null;
  buffaloBase: number;
  cowMilkAdded: number;
  notes: string | null;
};

export type DilutionSide = {
  productId: string;
  name: string;
  /** Dispatched to packaging today. */
  received: number;
  /** Still free to use here (dispatched − whatever packaging has already taken). */
  available: number;
  /**
   * On-hand stock, drawn on BEFORE today's production.
   *
   * Only meaningful on the cow side. Buffalo is never taken from stock: what is
   * in stock has already been standardised, so using it as the base would
   * dilute milk that was diluted once already.
   */
  inStorage: number;
  /** inStorage + available — everything that may go into the buffalo today. */
  total: number;
};

export type DilutionContext = {
  buffalo: DilutionSide | null;
  cow: DilutionSide | null;
  /** Cow milk stirred into buffalo milk so far today. */
  addedToday: number;
  /** Buffalo dispatched here + everything stirred in = what packaging forwards on. */
  prepared: number;
  entries: DilutionEntry[];
  /** Nothing dispatched to packaging yet — the section stays locked. */
  locked: boolean;
  dbReady: boolean;
};

export type DilutionResult = { ok: true } | { ok: false; error: string };

type BatchRow = {
  id: string;
  date: Date;
  pktDate: string | null;
  buffaloBase: { toString(): string };
  cowMilkAdded: { toString(): string };
  notes: string | null;
};

// Both sides of the day, read from the SAME pool the mix milk panel uses — so
// "available" here can never mean something different from what that card shows.
// Standardising happens at packaging, out of milk already dispatched there.
export async function getDilutionContext(date?: string): Promise<DilutionContext> {
  await requireRole(["ADMIN", "MANAGER", "PACKAGING"]);
  const empty: DilutionContext = {
    buffalo: null, cow: null, addedToday: 0, prepared: 0, entries: [], locked: true, dbReady: false,
  };
  try {
    const targetDate = date ?? todayPKTString();
    const [pools, rows, unlocked] = await Promise.all([
      getMixMilkAvailability(targetDate),
      db.$queryRaw<BatchRow[]>`
        SELECT id, date, "pktDate", "buffaloBase", "cowMilkAdded", notes
        FROM "BuffaloDilutionBatch"
        WHERE "pktDate" = ${targetDate}
        ORDER BY "createdAt" DESC
      `,
      isPackagingUnlocked(),
    ]);

    const sideOf = (keyword: string, includeAdded = false): DilutionSide | null => {
      const p = pools.find((a) => a.name.toLowerCase().includes(keyword));
      if (!p) return null;
      // Buffalo draws on today's production alone, so its storage figure is
      // deliberately zero rather than its real stock: showing stock there would
      // invite someone to use it.
      const isBuffalo = includeAdded;
      // Everything is in inventory now (accepted straight in). The buffalo side
      // is the buffalo in inventory — the base cow milk is stirred into; the cow
      // side is the cow milk in inventory that may be given to it.
      const available = isBuffalo ? p.inStorage : 0;
      const inStorage = isBuffalo ? 0 : p.inStorage;
      return {
        productId: p.productId,
        name: p.name,
        received: p.received,
        // The buffalo side shows what is actually on the floor — what arrived,
        // less what mixing took, PLUS what has already been stirred in. The cow
        // side is what may still be given away, which is the mixable figure.
        available,
        inStorage,
        total: available + inStorage,
      };
    };

    const buffalo = sideOf("buffalo", true);
    const cow = sideOf("cow");

    const entries: DilutionEntry[] = rows.map((r) => ({
      id: r.id,
      date: r.date.toISOString(),
      pktDate: r.pktDate,
      buffaloBase: Number(r.buffaloBase),
      cowMilkAdded: Number(r.cowMilkAdded),
      notes: r.notes,
    }));
    const addedToday = entries.reduce((s, e) => s + e.cowMilkAdded, 0);

    return {
      buffalo,
      cow,
      addedToday,
      // `available` already carries what has been stirred in, so this is simply
      // what packaging can forward on right now.
      prepared: buffalo?.available ?? 0,
      entries,
      // Locked until packaging has accepted something from production — the
      // same lock the mix milk panel uses.
      locked: !unlocked,
      dbReady: true,
    };
  } catch {
    return empty;
  }
}

export async function logBuffaloDilution(data: {
  date: string;
  cowMilk: number;
  notes?: string;
}): Promise<DilutionResult> {
  await requireRole(["ADMIN", "MANAGER", "PACKAGING"]);
  try {
    const ctx = await getDilutionContext(data.date);
    if (!ctx.dbReady) return { ok: false, error: "Database unavailable." };
    if (!ctx.buffalo) return { ok: false, error: 'No active buffalo milk product found. Add it in Products first.' };
    if (!ctx.cow) return { ok: false, error: 'No active cow milk product found. Add it in Products first.' };
    if (ctx.locked) return { ok: false, error: "Accept a load from production first — the buffalo is prepared from what packaging has accepted." };

    // Same decimal rule as every other quantity box on this page.
    const decimals = quantityProblem(ctx.cow.name, "LITER", data.cowMilk);
    if (decimals) return { ok: false, error: decimals };

    // The authoritative gate. The browser runs the identical check, but a server
    // action is a directly-invocable POST (stale tab, retry, two operators), and
    // `available` already has skim, yoghurt, calf, kitchen, wastage and anything
    // dispatched taken out — so the same litres cannot be given away twice.
    const problem = dilutionProblem({
      cowAdded: data.cowMilk,
      cowAvailable: ctx.cow.total,
      cowName: ctx.cow.name,
    });
    if (problem) return { ok: false, error: problem };

    const [y, m, d] = data.date.split("-").map(Number);
    const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;
    const pktTodMs = (Date.now() + PKT_OFFSET_MS) % 86_400_000;
    const dateObj = new Date(Date.UTC(y, m - 1, d) - PKT_OFFSET_MS + pktTodMs);

    const batchId = randomUUID();
    await db.$executeRaw`
      INSERT INTO "BuffaloDilutionBatch" (id, date, "pktDate", "buffaloBase", "cowMilkAdded", notes, "createdAt")
      VALUES (${batchId}, ${dateObj}, ${data.date}, ${ctx.buffalo.available}, ${data.cowMilk}, ${data.notes || null}, NOW())
    `;

    // INVENTORY FIRST, then today's dispatch. The two halves are written as
    // separate rows because they mean different things downstream: the storage
    // half comes off on-hand, the packaging half is docked from the load. One row
    // with one reason could only ever be one of those, so a storage draw would
    // either never leave stock or wrongly dock a load it never touched.
    const split = splitDilutionSource(data.cowMilk, ctx.cow.available, ctx.cow.inStorage);

    // Two sides of one move, written together: the cow milk leaves, the buffalo
    // milk grows by exactly the same amount. All rows carry the batch id, so
    // deleting the entry takes every one of them and they can never drift apart.
    const cowRows = [
      { qty: split.fromStorage, reason: DILUTION_REASON_STORAGE },
      { qty: split.fromPackaging, reason: DILUTION_REASON },
    ]
      .filter((r) => r.qty > 0)
      .map((r) => ({
        date: dateObj,
        type: "KITCHEN_USE" as const,
        productId: ctx.cow!.productId,
        quantity: new Prisma.Decimal(r.qty),
        reference: batchId,
        reason: r.reason,
      }));

    await db.inventoryMovement.createMany({
      data: [
        ...cowRows,
        {
          // The buffalo gains the whole amount however the cow milk was sourced —
          // the milk is in the vat either way.
          date: dateObj,
          type: "PRODUCED" as const,
          productId: ctx.buffalo.productId,
          quantity: new Prisma.Decimal(data.cowMilk),
          reference: batchId,
          reason: DILUTION_REASON,
        },
      ],
    });

    revalidateAll();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to save." };
  }
}

export async function deleteBuffaloDilution(id: string): Promise<DilutionResult> {
  await requireRole(["ADMIN", "MANAGER", "PACKAGING"]);
  try {
    // Both movements share the batch id, so the two sides always go together.
    // reason: { in: … } matters. Filtering on the packaging reason alone would
    // leave a storage row behind, and that cow milk would stay out of stock for
    // ever with no entry left to explain it.
    await db.inventoryMovement.deleteMany({
      where: { reference: id, reason: { in: [...DILUTION_REASONS] } },
    });
    await db.$executeRaw`DELETE FROM "BuffaloDilutionBatch" WHERE id = ${id}`;
    revalidateAll();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to delete." };
  }
}

/** Today's cow-into-buffalo total, for callers that only need the one number. */
export async function getDilutionAddedToday(date?: string): Promise<number> {
  await requireRole(["ADMIN", "MANAGER", "PACKAGING"]);
  try {
    const range = dateStrRangePKT(date ?? todayPKTString());
    const rows = await db.inventoryMovement.findMany({
      where: { date: range, type: "KITCHEN_USE", reason: { in: [...DILUTION_REASONS] } },
      select: { quantity: true },
    });
    return rows.reduce((s, r) => s + Number(r.quantity), 0);
  } catch {
    return 0;
  }
}

/** What is left of the cow milk once the day's dilutions are taken out. */
export async function getCowLeftAfterDilution(cowAvailable: number, date?: string): Promise<number> {
  return cowLeft(cowAvailable, await getDilutionAddedToday(date));
}

function revalidateAll() {
  revalidatePath("/inventory/farm-arrival");
  revalidatePath("/inventory/production");
  revalidatePath("/inventory/reconciliation");
  revalidatePath("/inventory/wastage");
  revalidatePath("/inventory");
  revalidatePath("/");
}
