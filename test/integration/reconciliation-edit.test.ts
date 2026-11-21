import { describe, it, expect, afterEach } from "vitest";
import { db, cleanups, setTestRole, resetTestRole } from "../setup";
import { createProduct, uniq } from "../helpers";
import {
  getReconciliationDayEdit,
  saveReconciliationDayEdit,
} from "@/app/(dashboard)/inventory/reconciliation/actions";
import { todayPKTString, pktNoonToUTC } from "@/lib/pkt";

const DATE = todayPKTString();
const D = pktNoonToUTC(DATE);

afterEach(() => resetTestRole());

async function produced(productId: string, qty: number) {
  const m = await db.inventoryMovement.create({
    data: { date: D, type: "PRODUCED", productId, quantity: qty },
  });
  const l = await db.productionLog.create({ data: { date: D, productId, quantity: qty } });
  cleanups.push(async () => {
    await db.inventoryMovement.deleteMany({ where: { id: m.id } }).catch(() => {});
    await db.productionLog.deleteMany({ where: { id: l.id } }).catch(() => {});
  });
}

describe("reconciliation — admin day edit", () => {
  it("blocks reducing production below what has already been dispatched/used, then allows a valid edit", async () => {
    const p = await createProduct({ unit: "LITER" });
    await produced(p.id, 150);

    // 120 L already went to packaging that day (this is what mix milk is made from).
    const fd = await db.farmDispatch.create({
      data: { date: D, declaredItems: [{ productId: p.id, quantity: 120 }] },
    });
    cleanups.push(async () => { await db.farmDispatch.delete({ where: { id: fd.id } }).catch(() => {}); });

    // The editor reports the floor it may not go below.
    const load = await getReconciliationDayEdit(DATE);
    expect(load.ok).toBe(true);
    const row = load.ok ? load.rows.find((r) => r.productId === p.id)! : null;
    expect(row!.produced).toBe(150);
    expect(row!.dispatched).toBe(120);
    expect(row!.minProduced).toBe(120);

    // 150 → 100 must be refused: 120 is already out the door.
    const bad = await saveReconciliationDayEdit(DATE, [
      { productId: p.id, produced: 100, calfUse: 0, kitchenUse: 0 },
    ]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.conflicts?.join(" ")).toMatch(/dispatched to packaging/i);
      expect(bad.conflicts?.join(" ")).toMatch(/120/);
    }
    // …and nothing was written.
    const stillProduced = await db.inventoryMovement.aggregate({
      where: { type: "PRODUCED", productId: p.id }, _sum: { quantity: true },
    });
    expect(Number(stillProduced._sum.quantity ?? 0)).toBe(150);

    // 150 → 130 is fine (>= 120 dispatched) and rewrites BOTH tables.
    const good = await saveReconciliationDayEdit(DATE, [
      { productId: p.id, produced: 130, calfUse: 0, kitchenUse: 0 },
    ]);
    expect(good.ok).toBe(true);

    const after = await db.inventoryMovement.aggregate({
      where: { type: "PRODUCED", productId: p.id }, _sum: { quantity: true },
    });
    expect(Number(after._sum.quantity ?? 0)).toBe(130);
    const logs = await db.productionLog.aggregate({ where: { productId: p.id }, _sum: { quantity: true } });
    expect(Number(logs._sum.quantity ?? 0)).toBe(130); // ProductionLog kept in step
  }, 180_000);

  it("blocks raising calf/kitchen use above what was produced, and never touches batch-owned rows", async () => {
    const p = await createProduct({ unit: "LITER" });
    await produced(p.id, 100);

    // A batch-owned deduction (yoghurt) — the editor must leave this row alone.
    const yog = await db.inventoryMovement.create({
      data: { date: D, type: "KITCHEN_USE", productId: p.id, quantity: 20, reason: "Yoghurt processing", reference: uniq("batch") },
    });
    cleanups.push(async () => { await db.inventoryMovement.deleteMany({ where: { id: yog.id } }).catch(() => {}); });

    // 90 calf + 20 yoghurt = 110 > 100 produced → refused.
    const bad = await saveReconciliationDayEdit(DATE, [
      { productId: p.id, produced: 100, calfUse: 90, kitchenUse: 0 },
    ]);
    expect(bad.ok).toBe(false);

    // A valid split is accepted, and the yoghurt row survives untouched.
    const good = await saveReconciliationDayEdit(DATE, [
      { productId: p.id, produced: 100, calfUse: 30, kitchenUse: 10 },
    ]);
    expect(good.ok).toBe(true);

    const survivor = await db.inventoryMovement.findUnique({ where: { id: yog.id } });
    expect(survivor).toBeTruthy();
    expect(Number(survivor!.quantity)).toBe(20);

    const calf = await db.inventoryMovement.aggregate({
      where: { type: "CALF_USE", productId: p.id }, _sum: { quantity: true },
    });
    expect(Number(calf._sum.quantity ?? 0)).toBe(30);
  }, 180_000);

  it("is refused for a non-admin (manager)", async () => {
    setTestRole("MANAGER");
    await expect(getReconciliationDayEdit(DATE)).rejects.toThrow();
    await expect(
      saveReconciliationDayEdit(DATE, [{ productId: "x", produced: 1, calfUse: 0, kitchenUse: 0 }])
    ).rejects.toThrow();
  }, 120_000);
});
