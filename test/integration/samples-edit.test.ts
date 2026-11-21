import { describe, it, expect } from "vitest";
import { db, cleanups } from "../setup";
import { createProduct, createCustomer, uniq } from "../helpers";
import {
  createSample, updateSample, setSampleStatus, markSampleConverted,
  getSamplesPageData, deleteSample,
} from "@/app/(dashboard)/samples/actions";
import { getRiderCashData } from "@/app/(dashboard)/payments/rider-cash/actions";

// Editing a sample is bounded by what has already been booked against it, not by
// taste: a delivered sample has rider cash recorded for Σ(qty × rate), and a
// converted one has handed its identity to a real Customer.

async function makeSample(status?: "DELIVERED" | "FOLLOWUP" | "DECLINED") {
  const p = await createProduct({ defaultRate: 120 });
  const name = uniq("lead");
  const res = await createSample({
    name, phone: "03001234567", address: "Street 1, Phase 8",
    items: [{ productId: p.id, quantity: 2, ratePerUnit: 120 }],
  });
  expect(res.ok).toBe(true);
  const row = await db.sampleLead.findFirstOrThrow({ where: { name } });
  cleanups.push(async () => { await db.sampleLead.delete({ where: { id: row.id } }).catch(() => {}); });
  if (status) await setSampleStatus(row.id, status);
  return { id: row.id, name, productId: p.id };
}

const fresh = (id: string) =>
  db.sampleLead.findFirstOrThrow({ where: { id }, include: { items: true } });

describe("deleting a sample that has cash booked", () => {
  it("takes its rider cash with it, so no nameless row is left on the cash page", async () => {
    const { id, name } = await makeSample();
    await db.payment.create({
      data: { sampleId: id, sampleRound: 0, head: "RIDER_CASH", amount: 240, handedOverAt: new Date(), notes: `Sample delivery · ${name}` },
    });

    expect((await deleteSample(id)).ok).toBe(true);
    expect(await db.payment.count({ where: { notes: `Sample delivery · ${name}` } })).toBe(0);
  }, 180_000);

  it("refuses while that cash is confirmed received — the books already have it", async () => {
    const { id, name } = await makeSample();
    const pay = await db.payment.create({
      data: { sampleId: id, sampleRound: 0, head: "RIDER_CASH", amount: 240, handedOverAt: new Date(), receivedAt: new Date(), notes: `Sample delivery · ${name}` },
    });
    cleanups.push(async () => { await db.payment.delete({ where: { id: pay.id } }).catch(() => {}); });

    const res = await deleteSample(id);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/confirmed received/i);
    expect(await db.sampleLead.count({ where: { id } })).toBe(1);
  }, 180_000);

  it("a row already stranded is still named, from the note it was written with", async () => {
    const who = uniq("Stranded Lead");
    const pay = await db.payment.create({
      data: { head: "RIDER_CASH", amount: 260, date: new Date(), handedOverAt: new Date(), notes: `Sample delivery · ${who}` },
    });
    cleanups.push(async () => { await db.payment.delete({ where: { id: pay.id } }).catch(() => {}); });

    const row = (await getRiderCashData()).rows.find((r) => r.id === pay.id)!;
    expect(row.customer).toBe(`Sample · ${who}`);
    expect(row.area).toBe("lead deleted");
  }, 180_000);
});

describe("editing the details", () => {
  it("saves the contact fields and the address", async () => {
    const { id } = await makeSample();
    const res = await updateSample({
      id, name: "Ismail Polyclinic", phone: "03487365523",
      address: "Polyclinic hostel, G6/2", notes: "prefers evening",
    });
    expect(res.ok).toBe(true);

    const s = await fresh(id);
    expect(s.name).toBe("Ismail Polyclinic");
    expect(s.phone).toBe("03487365523");
    expect(s.address).toBe("Polyclinic hostel, G6/2");
    expect(s.notes).toBe("prefers evening");
  }, 180000);

  it("blanks become NULL, not empty strings", async () => {
    const { id, name } = await makeSample();
    expect((await updateSample({ id, name, phone: "03001234567", address: "   ", email: "" })).ok).toBe(true);
    const s = await fresh(id);
    expect(s.address).toBeNull();
    expect(s.email).toBeNull();
  }, 180000);

  it("refuses an empty name or phone", async () => {
    const { id, name } = await makeSample();
    expect((await updateSample({ id, name: "  ", phone: "03001234567" })).ok).toBe(false);
    expect((await updateSample({ id, name, phone: " " })).ok).toBe(false);
  }, 180000);

  it("never moves status, resendCount or createdAt", async () => {
    // createdAt is load-bearing: route matching keys off it, so an edit that moved
    // it would make the sample jump runs.
    const { id, name } = await makeSample();
    const before = await fresh(id);
    expect((await updateSample({ id, name, phone: "03009999999" })).ok).toBe(true);
    const after = await fresh(id);
    expect(after.status).toBe(before.status);
    expect(after.resendCount).toBe(before.resendCount);
    expect(after.createdAt.getTime()).toBe(before.createdAt.getTime());
    expect(after.deliveredAt).toEqual(before.deliveredAt);
  }, 180000);
});

describe("editing the items", () => {
  it("rewrites them while the sample is still assigned", async () => {
    const { id, name } = await makeSample();
    const other = await createProduct({ defaultRate: 90 });
    const res = await updateSample({
      id, name, phone: "03001234567",
      items: [{ productId: other.id, quantity: 5, ratePerUnit: 90 }],
    });
    expect(res.ok).toBe(true);

    const s = await fresh(id);
    expect(s.items).toHaveLength(1);
    expect(s.items[0].productId).toBe(other.id);
    expect(Number(s.items[0].quantity)).toBeCloseTo(5, 3);
    // The rate must survive the round trip, or a delivery would book zero cash.
    expect(Number(s.items[0].ratePerUnit)).toBeCloseTo(90, 2);
  }, 180000);

  it("leaves them alone when the caller sends none", async () => {
    const { id, name, productId } = await makeSample();
    expect((await updateSample({ id, name, phone: "03001234567" })).ok).toBe(true);
    const s = await fresh(id);
    expect(s.items).toHaveLength(1);
    expect(s.items[0].productId).toBe(productId);
  }, 180000);

  it("refuses an empty item list when items ARE being rewritten", async () => {
    const { id, name } = await makeSample();
    expect((await updateSample({ id, name, phone: "03001234567", items: [] })).ok).toBe(false);
  }, 180000);

  it("ignores an item edit once the sample has been delivered", async () => {
    // Delivery booked rider cash for these exact items and nothing re-books it.
    const { id, name, productId } = await makeSample("DELIVERED");
    const other = await createProduct({ defaultRate: 50 });
    const res = await updateSample({
      id, name: name + " edited", phone: "03001234567",
      items: [{ productId: other.id, quantity: 9, ratePerUnit: 50 }],
    });
    expect(res.ok).toBe(true);

    const s = await fresh(id);
    expect(s.name).toBe(name + " edited");     // details did change
    expect(s.items).toHaveLength(1);
    expect(s.items[0].productId).toBe(productId); // items did not
  }, 180000);
});

describe("a converted lead is read-only", () => {
  it("is refused outright", async () => {
    const { id, name } = await makeSample();
    const c = await createCustomer();
    expect((await markSampleConverted(id, c.id)).ok).toBe(true);

    const res = await updateSample({ id, name: "Something else", phone: "03001234567" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/converted/i);

    const s = await fresh(id);
    expect(s.name).toBe(name);
  }, 180000);
});

describe("the page still reads", () => {
  it("returns the rate on each item so an edit can send it back", async () => {
    const { id } = await makeSample();
    const data = await getSamplesPageData();
    const row = data.samples.find((s) => s.id === id);
    expect(row).toBeTruthy();
    expect(row!.items[0].ratePerUnit).toBeCloseTo(120, 2);
    expect(row!.address).toBe("Street 1, Phase 8");
  }, 180000);

  it("an unknown id is an error, not a crash", async () => {
    expect((await updateSample({ id: "nope", name: "x", phone: "03001234567" })).ok).toBe(false);
  }, 180000);
});
