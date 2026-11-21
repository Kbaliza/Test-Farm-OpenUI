import { describe, it, expect, afterEach } from "vitest";
import { db, cleanups, resetTestRole } from "../setup";
import { createProduct, onHand, uniq } from "../helpers";
import { confirmArrival, sendToRetail } from "@/app/(dashboard)/inventory/farm-arrival/actions";
import { confirmRetailArrival } from "@/app/(dashboard)/inventory/retail/actions";
import { getWastageData } from "@/app/(dashboard)/inventory/wastage/actions";

afterEach(() => resetTestRole());

describe("Packaging accepts, then sends to Retail as its own step (no van, no inventory lost)", () => {
  it("accepting puts it in inventory and creates no Retail load; sending records the handover; Retail only confirms", async () => {
    const p = await createProduct({ unit: "LITER" });
    const items = [{ productId: p.id, productName: "Milk", unit: "LITER" as const, quantity: 100 }];
    const farm = await db.farmDispatch.create({ data: { declaredItems: items as never, status: "PENDING" } });
    const since = new Date();
    cleanups.push(async () => {
      const sends = await db.retailDispatch.findMany({ where: { farmDispatchId: null, createdAt: { gte: since } }, select: { id: true, declaredItems: true } });
      for (const r of sends.filter((x) => (x.declaredItems as { productId: string }[]).some((i) => i.productId === p.id))) {
        await db.inventoryMovement.deleteMany({ where: { reference: r.id } });
        await db.retailDispatch.delete({ where: { id: r.id } }).catch(() => {});
      }
      await db.inventoryMovement.deleteMany({ where: { reference: farm.id } });
      await db.farmDispatch.delete({ where: { id: farm.id } }).catch(() => {});
    });

    const before = await onHand(p.id);

    // Accept: into packaging, nothing forwarded yet.
    expect(await confirmArrival(farm.id, items, null)).toEqual({ ok: true });
    expect(await db.retailDispatch.count({ where: { farmDispatchId: farm.id } })).toBe(0);
    expect(await db.vanDispatch.count({ where: { farmDispatchId: farm.id } })).toBe(0);
    expect(await onHand(p.id)).toBeCloseTo(before + 100, 3); // in inventory on accepting

    // Send: one Retail load; nothing added — it is already in inventory.
    expect(await sendToRetail([{ productId: p.id, quantity: 100 }])).toEqual({ ok: true });
    expect(await onHand(p.id)).toBeCloseTo(before + 100, 3);
    const retail = (await db.retailDispatch.findMany({ where: { farmDispatchId: null, createdAt: { gte: since } } }))
      .find((r) => (r.declaredItems as { productId: string }[]).some((i) => i.productId === p.id))!;
    expect(retail).toBeTruthy();
    // Retail confirming adds nothing more — it was already counted.
    expect(await confirmRetailArrival(retail.id, items, null)).toEqual({ ok: true });
    expect(await onHand(p.id)).toBeCloseTo(before + 100, 3);
  });
});

describe("Rider-reported wastage shows in the Wastage log under 'Rider delivery'", () => {
  it("a WASTAGE movement carrying a riderId surfaces as a Rider delivery entry", async () => {
    const p = await createProduct({ unit: "LITER" });
    const user = await db.user.create({ data: { email: uniq("rd") + "@t.local", name: "Rider Wasim", role: "RIDER", active: true, supabaseId: uniq("sb") } });
    const rider = await db.rider.create({ data: { userId: user.id } });
    const m = await db.inventoryMovement.create({ data: { type: "WASTAGE", productId: p.id, quantity: 7, riderId: rider.id, reason: "Rider wastage" } });
    cleanups.push(async () => {
      await db.inventoryMovement.delete({ where: { id: m.id } }).catch(() => {});
      await db.rider.delete({ where: { id: rider.id } }).catch(() => {});
      await db.user.delete({ where: { id: user.id } }).catch(() => {});
    });

    const { entries } = await getWastageData();
    const row = entries.find((e) => e.id === m.id);
    expect(row).toBeTruthy();
    expect(row!.stage).toBe("Rider delivery");
    expect(row!.loggedBy).toBe("Rider Wasim");
    expect(row!.loss).toBeCloseTo(7, 3);
  });
});
