import { describe, it, expect } from "vitest";
import { db, cleanups, setTestRole, resetTestRole } from "../setup";
import { createProduct, createCustomer, uniq } from "../helpers";
import { getReconciliationSummary } from "@/app/(dashboard)/inventory/reconciliation/actions";
import { getReturnsBoard } from "@/app/(dashboard)/inventory/rider-returns/actions";
import { ACCEPTED_AT_PACKAGING, EGGS_COLLECTED, SENT_TO_RETAIL } from "@/lib/packaging-stock";
import { END_OF_SHIFT_RETURN_REASON, CUSTOMER_RETURN_REASON } from "@/lib/rider-stock";
import { MIX_REASON_PACKAGING } from "@/lib/mix-milk-source";
import { todayPKTString, pktNoonToUTC } from "@/lib/pkt";

// One made-up day, every stage of it, checked figure by figure: the farm's
// production, what the farm used, what packaging accepted and sent, what the
// rider took, delivered, spilled and brought back — and what is missing.

const TODAY = todayPKTString();

async function scenario() {
  const milk = await createProduct({ unit: "LITER" });
  const eggs = await createProduct({ unit: "PIECE", name: uniq("egg") });

  const user = await db.user.create({ data: { email: uniq("rd") + "@t.local", name: uniq("Rider"), role: "RIDER", active: true, supabaseId: uniq("sb") } });
  const rider = await db.rider.create({ data: { userId: user.id } });
  const shift = await db.shift.create({ data: { name: uniq("shift"), riderId: rider.id } });
  const customer = await createCustomer({ shiftId: shift.id });
  cleanups.push(async () => {
    await db.riderExtraItem.deleteMany({ where: { shiftId: shift.id } });
    await db.routeStopItem.deleteMany({ where: { routeStop: { route: { shiftId: shift.id } } } });
    await db.routeStop.deleteMany({ where: { route: { shiftId: shift.id } } });
    await db.route.deleteMany({ where: { shiftId: shift.id } });
    await db.shift.delete({ where: { id: shift.id } }).catch(() => {});
    await db.rider.delete({ where: { id: rider.id } }).catch(() => {});
    await db.user.delete({ where: { id: user.id } }).catch(() => {});
  });

  const move = (data: { type: string; productId: string; quantity: number; reason?: string; reference?: string; stage?: string; riderId?: string }) =>
    db.inventoryMovement.create({ data: { date: new Date(), ...data } as never });

  // The farm: 100 L given, and 20 L of mix milk MADE at packaging from milk that
  // was already produced — which must not read as more production.
  await move({ type: "PRODUCED", productId: milk.id, quantity: 100 });
  await move({ type: "PRODUCED", productId: milk.id, quantity: 20, reason: MIX_REASON_PACKAGING });
  // What the farm used: calfs 5, kitchen 3, skim 2, yoghurt 10 → net 80.
  await move({ type: "CALF_USE", productId: milk.id, quantity: 5 });
  await move({ type: "KITCHEN_USE", productId: milk.id, quantity: 3 });
  await move({ type: "KITCHEN_USE", productId: milk.id, quantity: 2, reason: "Skim milk processing" });
  await move({ type: "KITCHEN_USE", productId: milk.id, quantity: 10, reason: "Yoghurt processing" });

  // Packaging accepts 80 L, and collects 100 eggs.
  await move({ type: "ARRIVED", productId: milk.id, quantity: 80, reason: ACCEPTED_AT_PACKAGING });
  await move({ type: "ARRIVED", productId: eggs.id, quantity: 100, reason: EGGS_COLLECTED });

  // Sends 60 L to Retail; Retail confirms 58 — 2 L short on the way.
  const load = await db.retailDispatch.create({
    data: {
      date: new Date(),
      status: "CONFIRMED",
      declaredItems: [{ productId: milk.id, productName: milk.name, unit: "LITER", quantity: 60 }] as never,
      receivedItems: [{ productId: milk.id, productName: milk.name, unit: "LITER", quantity: 58 }] as never,
    },
  });
  await move({ type: "DISPATCHED", productId: milk.id, quantity: 60, reason: SENT_TO_RETAIL, reference: load.id });
  cleanups.push(async () => {
    await db.inventoryMovement.deleteMany({ where: { reference: load.id } });
    await db.retailDispatch.delete({ where: { id: load.id } }).catch(() => {});
  });

  // The shift: 40 L and 20 eggs on the round, plus 5 L of extras, 1 L of it back.
  const route = await db.route.create({ data: { shiftId: shift.id, date: pktNoonToUTC(TODAY) } });
  const stop = await db.routeStop.create({ data: { routeId: route.id, customerId: customer.id, stopNumber: 1 } });
  await db.routeStopItem.create({ data: { routeStopId: stop.id, productId: milk.id, plannedQty: 40 } });
  await db.routeStopItem.create({ data: { routeStopId: stop.id, productId: eggs.id, plannedQty: 20 } });
  await db.riderExtraItem.create({
    data: { date: pktNoonToUTC(TODAY), shiftId: shift.id, riderId: rider.id, productId: milk.id, givenQty: 5, returnedQty: 1, status: "RETURNED" },
  });

  // Delivered 30 L and 12 eggs; a customer handed 2 L back; a free replacement
  // and a complaint entry are neither a sale nor a return.
  const entry = (data: Record<string, unknown>) =>
    db.deliveryEntry.create({ data: { date: new Date(), customerId: customer.id, unitRate: 100, riderId: rider.id, ...data } as never });
  await entry({ productId: milk.id, quantity: 30 });
  await entry({ productId: eggs.id, quantity: 12 });
  await entry({ productId: milk.id, quantity: 2, isReturn: true });
  await entry({ productId: milk.id, quantity: 4, isReplacement: true });

  // 1.5 L spilled on the road, and the leftovers handed in: 10 L, 5 eggs.
  await move({ type: "WASTAGE", productId: milk.id, quantity: 1.5, riderId: rider.id });
  await move({ type: "RETURNED", productId: milk.id, quantity: 10, reason: END_OF_SHIFT_RETURN_REASON, riderId: rider.id });
  await move({ type: "RETURNED", productId: eggs.id, quantity: 5, reason: END_OF_SHIFT_RETURN_REASON, riderId: rider.id });
  // The trigger's mirror of the customer's 2 L return. It is the same milk, so it
  // must NOT be added to what the rider brought back.
  await move({ type: "RETURNED", productId: milk.id, quantity: 2, reason: CUSTOMER_RETURN_REASON, riderId: rider.id });

  return { milk, eggs, rider, shift };
}

describe("production reconciliation — the whole chain for a day", () => {
  it("reports every stage from the farm to the customer, per product", async () => {
    const { milk, eggs } = await scenario();
    const s = await getReconciliationSummary(TODAY, TODAY);
    expect(s.dbReady).toBe(true);
    const at = (m: Record<string, number>, id: string) => Math.round((m[id] ?? 0) * 1000) / 1000;

    // The farm's own figures. The 20 L of mix milk made at packaging is kept out
    // of production and shown as "made here" instead.
    expect(at(s.stages.produced, milk.id)).toBeCloseTo(100, 3);
    expect(at(s.stages.madeHere, milk.id)).toBeCloseTo(20, 3);
    expect(at(s.stages.calfUse, milk.id)).toBeCloseTo(5, 3);
    expect(at(s.stages.kitchenUse, milk.id)).toBeCloseTo(3, 3);
    expect(at(s.stages.skimUse, milk.id)).toBeCloseTo(2, 3);
    expect(at(s.stages.yoghurtUse, milk.id)).toBeCloseTo(10, 3);

    // Packaging and Retail.
    expect(at(s.stages.acceptedAtPackaging, milk.id)).toBeCloseTo(80, 3);
    expect(at(s.stages.toRetail, milk.id)).toBeCloseTo(60, 3);
    expect(at(s.stages.retailReceived, milk.id)).toBeCloseTo(58, 3);
    expect(at(s.stages.retailShort, milk.id)).toBeCloseTo(2, 3);

    // The round: 40 on the route + 5 extras.
    expect(at(s.stages.riderLoad, milk.id)).toBeCloseTo(45, 3);
    expect(at(s.stages.delivered, milk.id)).toBeCloseTo(30, 3);
    expect(at(s.stages.customerReturns, milk.id)).toBeCloseTo(2, 3);
    expect(at(s.stages.riderWasted, milk.id)).toBeCloseTo(1.5, 3);
    // 10 handed in at the end of the shift + 1 extra received back. The trigger's
    // mirror of the customer's 2 L is not added again.
    expect(at(s.stages.returnedToFarm, milk.id)).toBeCloseTo(11, 3);

    // Eggs go down the same chain, counted in pieces.
    expect(at(s.stages.acceptedAtPackaging, eggs.id)).toBeCloseTo(100, 3);
    expect(at(s.stages.riderLoad, eggs.id)).toBeCloseTo(20, 3);
    expect(at(s.stages.delivered, eggs.id)).toBeCloseTo(12, 3);
    expect(at(s.stages.returnedToFarm, eggs.id)).toBeCloseTo(5, 3);
  }, 180_000);

  it("adds the rider's day up: what should have come back, and what is missing", async () => {
    const { rider } = await scenario();
    const s = await getReconciliationSummary(TODAY, TODAY);
    const r = s.riders.find((x) => x.riderId === rider.id)!;
    expect(r).toBeTruthy();

    // Milk: took 45, delivered 30, a customer gave 2 back → 17 should come back.
    expect(r.milk.got).toBeCloseTo(45, 3);
    expect(r.milk.delivered).toBeCloseTo(30, 3);
    expect(r.milk.customerReturns).toBeCloseTo(2, 3);
    expect(r.milk.wasted).toBeCloseTo(1.5, 3);
    expect(r.milk.expected).toBeCloseTo(17, 3);
    expect(r.milk.returned).toBeCloseTo(11, 3);   // 10 handed in + 1 extra back
    // 17 due back, 11 handed in, and the rider himself reported 1.5 spilled — so 4.5
    // is what nobody has accounted for.
    //
    // This used to read 6, with the 1.5 counted as missing as well. The rider reports
    // handing back and wasting as two SEPARATE things, and only the first was being
    // credited to him, so a rider who declared his loss honestly still showed short by
    // exactly what he had declared. On production Nazar Ali showed 4 L missing on
    // 4 October against 4 L of wastage sitting in the app the whole time.
    expect(r.milk.missing).toBeCloseTo(4.5, 3);

    // Eggs: took 20, delivered 12 → 8 due back, 5 came back, 3 missing.
    expect(r.eggs.got).toBeCloseTo(20, 3);
    expect(r.eggs.delivered).toBeCloseTo(12, 3);
    expect(r.eggs.expected).toBeCloseTo(8, 3);
    expect(r.eggs.returned).toBeCloseTo(5, 3);
    expect(r.eggs.missing).toBeCloseTo(3, 3);
  }, 180_000);

  it("reads purchases, the farm's loads and every wastage stage from their own records", async () => {
    const milk = await createProduct({ unit: "LITER" });
    const move = (data: Record<string, unknown>) =>
      db.inventoryMovement.create({ data: { date: new Date(), productId: milk.id, ...data } as never });

    // Bought in over the counter — and an opening-stock seed, which is not a purchase.
    await move({ type: "COUNTER_PURCHASE", quantity: 10, reason: "OTC Purchase PUR-TEST" });
    await move({ type: "COUNTER_PURCHASE", quantity: 7, reason: "Opening stock after stock count" });
    await move({ type: "COUNTER_SALE", quantity: 3, reason: "OTC Sale SAL-TEST" });

    // The farm sent 50, packaging accepted 48. Another 12 went out and was never accepted.
    const item = (q: number) => [{ productId: milk.id, productName: milk.name, unit: "LITER", quantity: q }];
    const accepted = await db.farmDispatch.create({
      data: { date: new Date(), status: "DISPUTED", acceptedAt: new Date(), declaredItems: item(50) as never, receivedItems: item(48) as never },
    });
    const pending = await db.farmDispatch.create({ data: { date: new Date(), status: "PENDING", declaredItems: item(12) as never } });
    cleanups.push(async () => {
      await db.farmDispatch.deleteMany({ where: { id: { in: [accepted.id, pending.id] } } });
    });
    await move({ type: "ARRIVED", quantity: 48, reason: ACCEPTED_AT_PACKAGING, reference: accepted.id });

    // One write-off at each stage, each with its reason.
    const user = await db.user.create({ data: { email: uniq("rw") + "@t.local", name: uniq("Rider"), role: "RIDER", active: true, supabaseId: uniq("sb") } });
    const rider = await db.rider.create({ data: { userId: user.id } });
    cleanups.push(async () => {
      await db.inventoryMovement.deleteMany({ where: { riderId: rider.id } });
      await db.rider.delete({ where: { id: rider.id } }).catch(() => {});
      await db.user.delete({ where: { id: user.id } }).catch(() => {});
    });
    await move({ type: "WASTAGE", quantity: 0.5, stage: "Production", reason: "Spilled at the farm" });
    await move({ type: "WASTAGE", quantity: 2, stage: "Packaging", reason: "Packet leaked" });
    await move({ type: "WASTAGE", quantity: 1, stage: "Retail", reason: "Short on arrival" });
    await move({ type: "WASTAGE", quantity: 1.5, riderId: rider.id, reason: "Spillage" });
    await move({ type: "WASTAGE", quantity: 0.7, stage: "Rider return", reason: "Sour / spoiled" });
    await move({ type: "WASTAGE", quantity: 0.3, stage: "Yoghurt", reason: "Burnt" });

    const s = await getReconciliationSummary(TODAY, TODAY);
    const at = (m: Record<string, number>) => Math.round((m[milk.id] ?? 0) * 1000) / 1000;
    expect(at(s.stages.purchased)).toBe(10);          // the seed is not counted
    expect(at(s.stages.counterSale)).toBe(3);
    expect(at(s.stages.acceptedAtPackaging)).toBe(48);
    expect(at(s.stages.farmDeclared)).toBe(50);       // matched to the load it accepted
    expect(at(s.stages.farmPending)).toBe(12);
    expect(at(s.stages.farmWaste)).toBe(0.5);
    expect(at(s.stages.packWaste)).toBe(2);
    expect(at(s.stages.retailWaste)).toBe(1);
    expect(at(s.stages.riderWasted)).toBe(1.5);
    expect(at(s.stages.riderReturnWaste)).toBe(0.7);
    expect(at(s.stages.otherWaste)).toBe(0.3);        // an unknown stage is kept, never dropped

    // Every reason is the one on the entry, filed under where it happened.
    const reasons = (b: keyof typeof s.wasteReasons) => s.wasteReasons[b].map((r) => r.reason);
    expect(reasons("packaging")).toContain("Packet leaked");
    expect(reasons("road")).toContain("Spillage");
    expect(reasons("retail")).toContain("Short on arrival");
    expect(reasons("riderReturn")).toContain("Sour / spoiled");
    expect(reasons("other")).toContain("Yoghurt: Burnt");
  }, 180_000);

  it("counts a route's load once, whoever confirmed it, and gives the deliveries to the rider who made them", async () => {
    // Rider A's route, loaded and delivered by rider B covering for him. A's plan
    // must not be added on top of what B confirmed for the same route.
    const milk = await createProduct({ unit: "LITER" });
    const mkRider = async () => {
      const u = await db.user.create({ data: { email: uniq("rc") + "@t.local", name: uniq("Rider"), role: "RIDER", active: true, supabaseId: uniq("sb") } });
      const r = await db.rider.create({ data: { userId: u.id } });
      return { u, r };
    };
    const a = await mkRider();
    const b = await mkRider();
    const shift = await db.shift.create({ data: { name: uniq("shift"), riderId: a.r.id } });
    const customer = await createCustomer({ shiftId: shift.id });
    cleanups.push(async () => {
      await db.routeStopItem.deleteMany({ where: { routeStop: { route: { shiftId: shift.id } } } });
      await db.routeStop.deleteMany({ where: { route: { shiftId: shift.id } } });
      await db.route.deleteMany({ where: { shiftId: shift.id } });
      await db.shift.delete({ where: { id: shift.id } }).catch(() => {});
      for (const x of [a, b]) {
        await db.rider.delete({ where: { id: x.r.id } }).catch(() => {});
        await db.user.delete({ where: { id: x.u.id } }).catch(() => {});
      }
    });
    const route = await db.route.create({ data: { shiftId: shift.id, date: pktNoonToUTC(TODAY), status: "COMPLETED" } });
    const stop = await db.routeStop.create({ data: { routeId: route.id, customerId: customer.id, stopNumber: 1 } });
    await db.routeStopItem.create({ data: { routeStopId: stop.id, productId: milk.id, plannedQty: 40 } });
    await db.inventoryMovement.create({
      data: { date: new Date(), type: "HANDED_OVER", productId: milk.id, quantity: 41, riderId: b.r.id, reason: "Load confirmed", reference: route.id } as never,
    });
    await db.deliveryEntry.create({
      data: { date: new Date(), customerId: customer.id, productId: milk.id, quantity: 30, unitRate: 100, riderId: b.r.id } as never,
    });

    const s = await getReconciliationSummary(TODAY, TODAY);
    expect(s.stages.riderLoad[milk.id]).toBeCloseTo(41, 3);     // not 81
    const legB = s.riders.find((r) => r.riderId === b.r.id)!;
    expect(legB.riderName).toBe(b.u.name);                       // named, though he holds no shift
    expect(legB.milk.got).toBeCloseTo(41, 3);
    expect(legB.milk.delivered).toBeCloseTo(30, 3);
    expect(s.riders.find((r) => r.riderId === a.r.id)?.milk.got ?? 0).toBe(0);

    // Rider Item Returns reads the same rounds the same way.
    const board = await getReturnsBoard(TODAY, TODAY);
    const rowB = board.rows.find((r) => r.riderId === b.r.id)!;
    expect(rowB.got[milk.id]).toBeCloseTo(41, 3);
    expect(rowB.delivered[milk.id]).toBeCloseTo(30, 3);
    expect(board.rows.find((r) => r.riderId === a.r.id)?.got[milk.id] ?? 0).toBe(0);
  }, 180_000);

  it("counts a day with nothing in it as nothing, and refuses a bad range", async () => {
    const empty = await getReconciliationSummary("2019-01-02", "2019-01-02");
    expect(empty.milk.produced).toBe(0);
    expect(empty.riders).toEqual([]);
    expect(empty.days).toBe(1);

    const bad = await getReconciliationSummary("not-a-date", TODAY);
    expect(bad.error).toBeTruthy();

    // Back-to-front dates are read the way they were meant, not refused.
    const swapped = await getReconciliationSummary(TODAY, "2019-01-02");
    expect(swapped.from).toBe("2019-01-02");
    expect(swapped.to).toBe(TODAY);
  }, 120_000);

  it("is open to managers and the doctor, and refused to everyone else", async () => {
    setTestRole("DOCTOR");
    await expect(getReconciliationSummary(TODAY, TODAY)).resolves.toBeTruthy();
    setTestRole("PACKAGING");
    await expect(getReconciliationSummary(TODAY, TODAY)).rejects.toThrow(/permission/i);
    resetTestRole();
  }, 120_000);
});
