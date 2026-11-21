import { describe, it, expect, afterEach } from "vitest";
import { db, cleanups, setTestRole, resetTestRole } from "../setup";
import { createProduct, createCustomer, onHand, inRetail, uniq } from "../helpers";
import { confirmArrival, sendToRetail, getPoolView, deleteRetailSend, deleteRetailSendLine } from "@/app/(dashboard)/inventory/farm-arrival/actions";
import { isPackagingUnlocked, getMixMilkAvailability, logMixMilkBatch, deleteMixMilkBatch, getMixMilkBatches } from "@/app/(dashboard)/inventory/farm-arrival/mix-milk-actions";
import { logBuffaloDilution, deleteBuffaloDilution, getDilutionContext } from "@/app/(dashboard)/inventory/farm-arrival/dilution-actions";
import { todayPKTString, pktNoonToUTC } from "@/lib/pkt";
import { confirmRetailArrival } from "@/app/(dashboard)/inventory/retail/actions";
import { getWastageData } from "@/app/(dashboard)/inventory/wastage/actions";
import { packagingAttribution } from "@/lib/packaging-attribution";
import { MIX_REASON_PACKAGING } from "@/lib/mix-milk-source";
import { todayRangePKT } from "@/lib/pkt";

afterEach(() => resetTestRole());

type Item = { productId: string; productName: string; unit: "LITER"; quantity: number };

/** A production load of `qty` of a fresh product, cleaned up with everything written against it. */
async function load(qty: number) {
  const p = await createProduct({ unit: "LITER" });
  const items: Item[] = [{ productId: p.id, productName: p.name, unit: "LITER", quantity: qty }];
  const farm = await db.farmDispatch.create({ data: { declaredItems: items as never, status: "PENDING" } });
  cleanups.push(async () => {
    const refs = (await db.inventoryMovement.findMany({ where: { productId: p.id }, select: { reference: true } }))
      .map((m) => m.reference).filter((r): r is string => !!r && r !== farm.id);
    await db.inventoryMovement.deleteMany({ where: { productId: p.id } });
    await db.retailDispatch.deleteMany({ where: { id: { in: refs } } }).catch(() => {});
    await db.farmDispatch.delete({ where: { id: farm.id } }).catch(() => {});
  });
  return { p, items, farm };
}

async function sendOf(productId: string) {
  return (await getPoolView()).sentToday.find((s) => s.items.some((i) => i.productId === productId))!;
}

describe("accepting at packaging puts the milk into inventory", () => {
  it("inventory goes up by what was accepted, the moment it is accepted", async () => {
    const { p, items, farm } = await load(80);
    const before = await onHand(p.id);
    expect((await confirmArrival(farm.id, items, null)).ok).toBe(true);
    expect(await onHand(p.id)).toBeCloseTo(before + 80, 3);
    expect(await db.retailDispatch.count({ where: { farmDispatchId: farm.id } })).toBe(0);
  });

  it("accepting less puts in only what was accepted; more than was sent is refused", async () => {
    const { p, items, farm } = await load(50);
    const before = await onHand(p.id);
    expect((await confirmArrival(farm.id, [{ ...items[0], quantity: 51 }], null)).ok).toBe(false);
    expect((await confirmArrival(farm.id, [{ ...items[0], quantity: 47 }], "Spillage during transport")).ok).toBe(true);
    expect((await db.farmDispatch.findUniqueOrThrow({ where: { id: farm.id } })).status).toBe("DISPUTED");
    expect(await onHand(p.id)).toBeCloseTo(before + 47, 3);
  });

  it("cannot be accepted twice — the milk goes in once", async () => {
    const { p, items, farm } = await load(30);
    const before = await onHand(p.id);
    expect((await confirmArrival(farm.id, items, null)).ok).toBe(true);
    expect((await confirmArrival(farm.id, items, null)).ok).toBe(false);
    expect(await onHand(p.id)).toBeCloseTo(before + 30, 3);
  });

  it("unlocks buffalo and mix milk, which then see it as inventory", async () => {
    const { items, farm } = await load(10);
    await confirmArrival(farm.id, items, null);
    expect(await isPackagingUnlocked()).toBe(true);
    for (const a of await getMixMilkAvailability()) {
      expect(a.available).toBe(0);              // nothing sits outside inventory
      expect(a.total).toBeCloseTo(a.inStorage, 3);
    }
  });
});

describe("send to Retail reads inventory", () => {
  it("is capped at inventory, and sending moves the stock into Retail", async () => {
    const { p, items, farm } = await load(60);
    await confirmArrival(farm.id, items, null);
    const inInventory = await onHand(p.id);

    expect((await sendToRetail([{ productId: p.id, quantity: inInventory + 1 }])).ok).toBe(false);
    expect((await sendToRetail([{ productId: p.id, quantity: 45 }])).ok).toBe(true);
    // It has left packaging: inventory is down by it, and Retail holds it until
    // the shifts take it (whatever is left goes back to inventory at day end).
    expect(await onHand(p.id)).toBeCloseTo(inInventory - 45, 3);
    expect(await inRetail(p.id)).toBeCloseTo(45, 3);

    const line = (await getPoolView()).lines.find((l) => l.productId === p.id)!;
    expect(line.available).toBeCloseTo(inInventory - 45, 3);
    expect(line.acceptedToday).toBeCloseTo(60, 3);

    // The send is recorded as dispatched, for Reconciliation and the ledger.
    const send = await sendOf(p.id);
    const d = await db.inventoryMovement.aggregate({ _sum: { quantity: true }, where: { type: "DISPATCHED", reference: send.id } });
    expect(Number(d._sum.quantity)).toBeCloseTo(45, 3);
  }, 180_000);

  it("cannot send what is not in inventory", async () => {
    const { p } = await load(40); // never accepted
    expect((await sendToRetail([{ productId: p.id, quantity: 1 }])).ok).toBe(false);
  });

  it("refuses nothing-to-send and negative quantities", async () => {
    const { p, items, farm } = await load(10);
    await confirmArrival(farm.id, items, null);
    expect((await sendToRetail([])).ok).toBe(false);
    expect((await sendToRetail([{ productId: p.id, quantity: -1 }])).ok).toBe(false);
  });
});

// A send can be taken back until Retail says the milk arrived. Once they have,
// the correction belongs on their side, where the difference is written off with
// a reason rather than disappearing.
describe("undoing a send to Retail", () => {
  /** Two products accepted at packaging and sent to Retail in one send. */
  async function sentPair(a: number, b: number) {
    const one = await load(a);
    const two = await load(b);
    await confirmArrival(one.farm.id, one.items, null);
    await confirmArrival(two.farm.id, two.items, null);
    expect((await sendToRetail([
      { productId: one.p.id, quantity: a },
      { productId: two.p.id, quantity: b },
    ])).ok).toBe(true);
    return { one: one.p, two: two.p, send: await sendOf(one.p.id) };
  }

  it("takes the whole send back into inventory, and leaves nothing pointing at it", async () => {
    const { one, two, send } = await sentPair(30, 12);
    expect(await inRetail(one.id)).toBeCloseTo(30, 3);

    expect(await deleteRetailSend(send.id)).toEqual({ ok: true });

    expect(await onHand(one.id)).toBeCloseTo(30, 3);   // back where it came from
    expect(await onHand(two.id)).toBeCloseTo(12, 3);
    expect(await inRetail(one.id)).toBeCloseTo(0, 3);
    expect(await db.retailDispatch.count({ where: { id: send.id } })).toBe(0);
    expect(await db.inventoryMovement.count({ where: { reference: send.id } })).toBe(0);
    expect((await getPoolView()).sentToday.some((s) => s.id === send.id)).toBe(false);
  }, 180_000);

  it("removes one product and leaves the rest of the send standing", async () => {
    const { one, two, send } = await sentPair(25, 4.5); // the ghee case

    expect(await deleteRetailSendLine(send.id, two.id)).toEqual({ ok: true });

    expect(await onHand(two.id)).toBeCloseTo(4.5, 3);   // only that one came back
    expect(await inRetail(two.id)).toBeCloseTo(0, 3);
    expect(await inRetail(one.id)).toBeCloseTo(25, 3);  // the rest is still at Retail
    const left = await sendOf(one.id);
    expect(left.items.map((i) => i.productId)).toEqual([one.id]);
    expect(await db.inventoryMovement.count({ where: { reference: send.id, productId: two.id } })).toBe(0);
    expect(await db.inventoryMovement.count({ where: { reference: send.id, productId: one.id } })).toBe(1);
  }, 180_000);

  it("removing the only product takes the send with it", async () => {
    const { p, items, farm } = await load(8);
    await confirmArrival(farm.id, items, null);
    expect((await sendToRetail([{ productId: p.id, quantity: 8 }])).ok).toBe(true);
    const send = await sendOf(p.id);

    expect(await deleteRetailSendLine(send.id, p.id)).toEqual({ ok: true });

    // Not an empty send: Retail would still be shown a card asking them to
    // confirm nothing at all.
    expect(await db.retailDispatch.count({ where: { id: send.id } })).toBe(0);
    expect(await onHand(p.id)).toBeCloseTo(8, 3);
  }, 180_000);

  it("is refused once Retail has confirmed it", async () => {
    const { p, items, farm } = await load(20);
    await confirmArrival(farm.id, items, null);
    expect((await sendToRetail([{ productId: p.id, quantity: 20 }])).ok).toBe(true);
    const send = await sendOf(p.id);
    expect((await confirmRetailArrival(send.id, [{ productId: p.id, productName: p.name, unit: "LITER", quantity: 20 }], null)).ok).toBe(true);

    const res = await deleteRetailSend(send.id);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/already confirmed/i);
    expect(await db.retailDispatch.count({ where: { id: send.id } })).toBe(1);
  }, 180_000);

  it("is refused once the rounds have been loaded from that stock", async () => {
    const { p, items, farm } = await load(100);
    await confirmArrival(farm.id, items, null);
    expect((await sendToRetail([{ productId: p.id, quantity: 100 }])).ok).toBe(true);
    const send = await sendOf(p.id);

    // A shift takes 80 of it off Retail.
    const shift = await db.shift.create({ data: { name: uniq("shift") } });
    const customer = await createCustomer({ shiftId: shift.id });
    const route = await db.route.create({ data: { shiftId: shift.id, date: pktNoonToUTC(todayPKTString()), status: "IN_PROGRESS" } });
    const stop = await db.routeStop.create({ data: { routeId: route.id, customerId: customer.id, stopNumber: 1 } });
    await db.routeStopItem.create({ data: { routeStopId: stop.id, productId: p.id, plannedQty: 80 } });
    cleanups.push(async () => {
      await db.routeStopItem.deleteMany({ where: { routeStop: { routeId: route.id } } });
      await db.routeStop.deleteMany({ where: { routeId: route.id } });
      await db.route.delete({ where: { id: route.id } }).catch(() => {});
      await db.shift.delete({ where: { id: shift.id } }).catch(() => {});
    });

    const res = await deleteRetailSend(send.id);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/still at Retail/i);
    expect(await db.retailDispatch.count({ where: { id: send.id } })).toBe(1);
    expect(await inRetail(p.id)).toBeCloseTo(20, 3); // nothing moved
  }, 180_000);

  it("a product that is not on the send, and a send that is already gone, are refused", async () => {
    const { one, two, send } = await sentPair(5, 5);
    const other = await createProduct({ unit: "LITER" });
    const wrong = await deleteRetailSendLine(send.id, other.id);
    expect(wrong.ok).toBe(false);
    expect(wrong.ok === false && wrong.error).toMatch(/not on this send/i);

    expect(await deleteRetailSend(send.id)).toEqual({ ok: true });
    const again = await deleteRetailSend(send.id);
    expect(again.ok).toBe(false);
    expect(again.ok === false && again.error).toMatch(/no longer here/i);
    expect(await onHand(one.id)).toBeCloseTo(5, 3);
    expect(await onHand(two.id)).toBeCloseTo(5, 3);
  }, 180_000);

  it("packaging staff may undo a send; a rider may not", async () => {
    const { p, items, farm } = await load(6);
    await confirmArrival(farm.id, items, null);
    expect((await sendToRetail([{ productId: p.id, quantity: 6 }])).ok).toBe(true);
    const send = await sendOf(p.id);

    setTestRole("RIDER");
    await expect(deleteRetailSend(send.id)).rejects.toThrow(/permission/i);
    setTestRole("PACKAGING");
    expect(await deleteRetailSend(send.id)).toEqual({ ok: true });
  }, 180_000);
});

describe("Retail only confirms", () => {
  async function sent(qty: number) {
    const l = await load(qty);
    await confirmArrival(l.farm.id, l.items, null);
    expect((await sendToRetail([{ productId: l.p.id, quantity: qty }])).ok).toBe(true);
    return { ...l, after: await onHand(l.p.id), send: await sendOf(l.p.id) };
  }

  it("confirming what was sent changes nothing", async () => {
    const { p, items, after, send } = await sent(40);
    expect((await confirmRetailArrival(send.id, items, null)).ok).toBe(true);
    expect(await onHand(p.id)).toBeCloseTo(after, 3);
  });

  it("receiving less writes the shortfall off Retail, once in the Wastage log", async () => {
    const { p, items, after, send } = await sent(40);
    const retailBefore = await inRetail(p.id);
    expect((await confirmRetailArrival(send.id, [{ ...items[0], quantity: 37 }], "Packet leaked")).ok).toBe(true);
    // The milk was already in Retail, so that is where the loss lands today. From
    // tomorrow it is inventory that is 3 lighter, since only 37 came back to it.
    expect(await onHand(p.id)).toBeCloseTo(after, 3);
    expect(await inRetail(p.id)).toBeCloseTo(retailBefore - 3, 3);
    const rows = (await getWastageData()).entries.filter((e) => e.productName === p.name);
    expect(rows).toHaveLength(1);
    expect(rows[0].loss).toBeCloseTo(3, 3);
    expect(rows[0].stage).toBe("Retail");
  }, 180_000);

  it("cannot receive more than was sent", async () => {
    const { p, items, after, send } = await sent(20);
    expect((await confirmRetailArrival(send.id, [{ ...items[0], quantity: 25 }], null)).ok).toBe(false);
    expect(await onHand(p.id)).toBeCloseTo(after, 3);
  }, 180_000);
});

describe("history is left alone", () => {
  it("a load accepted into inventory takes no share of the day's old-style mixing", async () => {
    const { p, items, farm } = await load(100);
    await confirmArrival(farm.id, items, null);
    await db.inventoryMovement.create({
      data: { date: new Date(), type: "KITCHEN_USE", productId: p.id, quantity: 25, reason: MIX_REASON_PACKAGING },
    });
    const share = (await packagingAttribution(todayRangePKT())).get(farm.id);
    expect(share?.mixUsed[p.id] ?? 0).toBe(0);
  });
});

describe("access", () => {
  it("packaging staff can use it; a checklist user cannot", async () => {
    setTestRole("PACKAGING");
    await expect(getPoolView()).resolves.toBeTruthy();
    setTestRole("CHECKLIST");
    await expect(getPoolView()).rejects.toThrow();
  });
});

describe("buffalo and mix milk work on inventory", () => {
  const find = (term: string) =>
    db.product.findFirst({ where: { active: true, retailOnly: false, name: { contains: term, mode: "insensitive" } } });

  it("mixing takes cow and buffalo out of inventory and puts the mix milk in; standardising moves cow into the buffalo", async () => {
    const [cow, buffalo, mix] = await Promise.all([find("Cow"), find("Buffalo"), db.product.findFirst({ where: { name: "Mix Milk", active: true } })]);
    if (!cow || !buffalo || !mix) return; // products not on this database

    // Accept a real load of cow and buffalo.
    const items = [
      { productId: cow.id, productName: cow.name, unit: "LITER" as const, quantity: 30 },
      { productId: buffalo.id, productName: buffalo.name, unit: "LITER" as const, quantity: 30 },
    ];
    const farm = await db.farmDispatch.create({ data: { declaredItems: items as never, status: "PENDING" } });
    cleanups.push(async () => {
      await db.inventoryMovement.deleteMany({ where: { reference: farm.id } });
      await db.farmDispatch.delete({ where: { id: farm.id } }).catch(() => {});
    });
    expect((await confirmArrival(farm.id, items, null)).ok).toBe(true);

    const c0 = await onHand(cow.id), b0 = await onHand(buffalo.id), m0 = await onHand(mix.id);

    // Mix: 10 cow + 10 buffalo → 20 mix.
    // Staging's inventory also carries today's route reservations and shop
    // placements, so use amounts that fit in what is actually there.
    const x = Math.floor(Math.min(4, c0 / 2, b0));
    if (x < 1) return;

    // Mix: x cow + x buffalo → 2x mix.
    expect((await logMixMilkBatch({ date: todayPKTString(), cowMilk: x, buffaloMilk: x, mixMilkMade: 2 * x })).ok).toBe(true);
    const batch = (await getMixMilkBatches()).entries[0];
    cleanups.push(async () => { await deleteMixMilkBatch(batch.id); });
    expect(await onHand(cow.id)).toBeCloseTo(c0 - x, 3);
    expect(await onHand(buffalo.id)).toBeCloseTo(b0 - x, 3);
    expect(await onHand(mix.id)).toBeGreaterThan(m0); // mix made goes into inventory

    // Standardise: 1 L cow stirred into the buffalo.
    expect((await logBuffaloDilution({ date: todayPKTString(), cowMilk: 1 })).ok).toBe(true);
    const entry = (await getDilutionContext()).entries[0];
    cleanups.push(async () => { await deleteBuffaloDilution(entry.id); });
    expect(await onHand(cow.id)).toBeCloseTo(c0 - x - 1, 3);
    expect(await onHand(buffalo.id)).toBeCloseTo(b0 - x + 1, 3);
  }, 300_000);
});
