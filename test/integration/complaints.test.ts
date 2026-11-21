import { describe, it, expect } from "vitest";
import { db, cleanups, setTestRole, resetTestRole } from "../setup";
import { createProduct, createCustomer, addStock, onHand, uniq } from "../helpers";
import {
  createComplaint,
  updateComplaint,
  deleteComplaint,
  getComplaintDayProducts,
} from "@/app/(dashboard)/complaints/actions";
import { getRiderShiftReport, saveRiderEdits } from "@/app/(dashboard)/customers/rider-report/actions";
import { generateInvoice, getInvoiceDetail } from "@/app/(dashboard)/billing/invoices/actions";
import { computeCustomerOutstanding } from "@/lib/customer-balance";
import { COMPLAINT_REPLACEMENT_REASON, type ComplaintDraft } from "@/lib/complaints";
import { addDaysToDateStr, pktNoonToUTC, toDateStrPKT, todayPKTString } from "@/lib/pkt";

const TODAY = todayPKTString();
const T = pktNoonToUTC(TODAY);
const YDAY = addDaysToDateStr(TODAY, -1);
const [Y, M] = TODAY.split("-").map(Number);
const HALF = Number(TODAY.slice(8)) <= 15 ? 1 : 2;

async function balance(customerId: string) {
  return (await computeCustomerOutstanding([customerId])).get(customerId) ?? 0;
}

/** A customer who was delivered `qty` of a fresh product on `day` at `rate`. */
async function delivered(opts: { qty: number; rate: number; day?: string; shiftId?: string | null; stock?: number }) {
  const p = await createProduct({ unit: "LITER", defaultRate: 100 });
  if (opts.stock) await addStock(p.id, opts.stock);
  const c = await createCustomer({ shiftId: opts.shiftId ?? null });
  // Pushed last, so it runs first: complaints hold a foreign key to the customer.
  cleanups.push(async () => {
    await db.inventoryMovement.deleteMany({ where: { productId: p.id, reason: COMPLAINT_REPLACEMENT_REASON } });
    await db.customerComplaint.deleteMany({ where: { customerId: c.id } }); // cascades their entries
  });
  await db.deliveryEntry.create({
    data: { customerId: c.id, productId: p.id, quantity: opts.qty, unitRate: opts.rate, date: pktNoonToUTC(opts.day ?? TODAY) },
  });
  return { p, c };
}

function draft(customerId: string, productId: string, over: Partial<ComplaintDraft> = {}): ComplaintDraft {
  return {
    customerId,
    deliveryDate: TODAY,
    date: TODAY,
    category: "Spoiled milk",
    description: "Sour when opened",
    resolution: "REFUND",
    productId,
    quantity: 2,
    ...over,
  };
}

async function makeShift() {
  const user = await db.user.create({
    data: { email: uniq("rd") + "@t.local", name: "Test Rider", role: "RIDER", active: true, supabaseId: uniq("sb") },
  });
  const rider = await db.rider.create({ data: { userId: user.id } });
  const s = await db.shift.create({ data: { name: uniq("shift"), riderId: rider.id } });
  cleanups.push(async () => {
    await db.route.deleteMany({ where: { shiftId: s.id } }).catch(() => {});
    await db.shift.delete({ where: { id: s.id } }).catch(() => {});
    await db.rider.delete({ where: { id: rider.id } }).catch(() => {});
    await db.user.delete({ where: { id: user.id } }).catch(() => {});
  });
  return s;
}

describe("refund — deducted from the bill", () => {
  it("comes off the balance at the rate billed that day, and records who entered it", async () => {
    const { p, c } = await delivered({ qty: 5, rate: 120, day: YDAY });
    const before = await balance(c.id);

    const r = await createComplaint(draft(c.id, p.id, { deliveryDate: YDAY, quantity: 2 }));
    expect(r.ok).toBe(true);
    expect(before - (await balance(c.id))).toBeCloseTo(240, 2); // 2 × 120, not the 100 list price

    const row = await db.customerComplaint.findFirstOrThrow({ where: { customerId: c.id }, include: { deliveryEntry: true } });
    expect(Number(row.amount)).toBeCloseTo(240, 2);
    expect(Number(row.rate)).toBe(120);
    expect(row.enteredByName).toBe("Vitest Admin");
    expect(row.enteredById).toBeTruthy();
    expect(row.deliveryEntry?.isReturn).toBe(true);
    expect(row.deliveryEntry?.riderId).toBeNull(); // out of reach of the rider app's delete policy
    expect(toDateStrPKT(row.deliveryEntry!.date)).toBe(TODAY); // lands on the bill being prepared
  });

  it("puts no milk back into stock — the return trigger skips complaint rows", async () => {
    const { p, c } = await delivered({ qty: 5, rate: 100, stock: 20 });
    const stockBefore = await onHand(p.id);

    expect((await createComplaint(draft(c.id, p.id, { quantity: 3 }))).ok).toBe(true);
    expect(await onHand(p.id)).toBeCloseTo(stockBefore, 3);
    const entry = await db.deliveryEntry.findFirstOrThrow({ where: { customerId: c.id, complaintId: { not: null } } });
    expect(await db.inventoryMovement.count({ where: { reference: entry.id } })).toBe(0);

    // Control: a genuine rider return IS mirrored, so the trigger is live and the 0 above means something.
    const ret = await db.deliveryEntry.create({
      data: { customerId: c.id, productId: p.id, quantity: 1, unitRate: 100, isReturn: true, date: T },
    });
    expect(await db.inventoryMovement.count({ where: { reference: ret.id, type: "RETURNED" } })).toBe(1);
  });

  it("shows on the customer's bill", async () => {
    const { p, c } = await delivered({ qty: 5, rate: 100 });
    cleanups.push(async () => {
      await db.invoiceLine.deleteMany({ where: { invoice: { customerId: c.id } } }).catch(() => {});
      await db.invoice.deleteMany({ where: { customerId: c.id } }).catch(() => {});
    });

    expect((await createComplaint(draft(c.id, p.id, { quantity: 2 }))).ok).toBe(true);
    expect((await generateInvoice(c.id, Y, M, HALF)).ok).toBe(true);
    const inv = (await db.invoice.findFirst({ where: { customerId: c.id, year: Y, month: M, half: HALF } }))!;
    const detail = await getInvoiceDetail(inv.id);
    expect(detail!.returnsAmt).toBeCloseTo(200, 2);
    expect(detail!.deliveriesAmt - detail!.returnsAmt).toBeCloseTo(300, 2);
  });
});

describe("the cap — no refunding milk that isn't there", () => {
  it("allows only what was delivered, less rider returns and earlier complaints", async () => {
    const { p, c } = await delivered({ qty: 5, rate: 100 });
    await db.deliveryEntry.create({ data: { customerId: c.id, productId: p.id, quantity: 1, unitRate: 100, isReturn: true, date: T } });

    expect((await createComplaint(draft(c.id, p.id, { quantity: 4.01 }))).ok).toBe(false);
    expect((await createComplaint(draft(c.id, p.id, { quantity: 3 }))).ok).toBe(true);
    // The refund just written is dated today, the same day as the delivery. It must
    // be counted once (as a complaint), not a second time as a rider return — if it
    // were, this last litre would be refused.
    expect((await createComplaint(draft(c.id, p.id, { quantity: 1.01 }))).ok).toBe(false);
    expect((await createComplaint(draft(c.id, p.id, { quantity: 1 }))).ok).toBe(true);

    const [day] = await getComplaintDayProducts(c.id, TODAY);
    expect(day.compensable).toBe(0);
    expect(await balance(c.id)).toBeCloseTo(500 - 100 - 300 - 100, 2);
  });

  it("a replacement uses up the same allowance as a refund", async () => {
    const { p, c } = await delivered({ qty: 2, rate: 100, stock: 10 });
    expect((await createComplaint(draft(c.id, p.id, { resolution: "REPLACEMENT", quantity: 2 }))).ok).toBe(true);
    expect((await createComplaint(draft(c.id, p.id, { quantity: 0.5 }))).ok).toBe(false);
  });

  it("refuses a day the product wasn't delivered", async () => {
    const { p, c } = await delivered({ qty: 5, rate: 100, day: YDAY });
    const r = await createComplaint(draft(c.id, p.id, { deliveryDate: TODAY }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("was delivered");
  });

  it("two people saving at the same moment can't both refund the same milk", async () => {
    const { p, c } = await delivered({ qty: 5, rate: 100 });
    const results = await Promise.all([
      createComplaint(draft(c.id, p.id, { quantity: 3 })),
      createComplaint(draft(c.id, p.id, { quantity: 3 })),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await balance(c.id)).toBeCloseTo(200, 2); // 500 − one 300 refund
  });
});

describe("replacement — free, and out of stock", () => {
  it("costs the customer nothing, takes the stock, and is refused beyond it", async () => {
    const { p, c } = await delivered({ qty: 5, rate: 100, stock: 4 });
    const bal = await balance(c.id);
    const stock = await onHand(p.id);

    expect((await createComplaint(draft(c.id, p.id, { resolution: "REPLACEMENT", quantity: stock + 1 }))).ok).toBe(false);
    expect((await createComplaint(draft(c.id, p.id, { resolution: "REPLACEMENT", quantity: 3 }))).ok).toBe(true);
    expect(await onHand(p.id)).toBeCloseTo(stock - 3, 3);
    expect(await balance(c.id)).toBeCloseTo(bal, 2);
  }, 180_000);
});

describe("deleting a complaint undoes it everywhere", () => {
  it("a refund goes back on the bill", async () => {
    const { p, c } = await delivered({ qty: 5, rate: 100 });
    const bal = await balance(c.id);
    await createComplaint(draft(c.id, p.id, { quantity: 2 }));
    const row = await db.customerComplaint.findFirstOrThrow({ where: { customerId: c.id } });

    expect((await deleteComplaint(row.id)).ok).toBe(true);
    expect(await balance(c.id)).toBeCloseTo(bal, 2);
    expect(await db.deliveryEntry.count({ where: { complaintId: row.id } })).toBe(0);
    expect((await deleteComplaint(row.id)).ok).toBe(false); // twice is harmless
  });

  it("a replacement's stock comes back", async () => {
    const { p, c } = await delivered({ qty: 5, rate: 100, stock: 10 });
    const stock = await onHand(p.id);
    await createComplaint(draft(c.id, p.id, { resolution: "REPLACEMENT", quantity: 2 }));
    const row = await db.customerComplaint.findFirstOrThrow({ where: { customerId: c.id } });

    expect((await deleteComplaint(row.id)).ok).toBe(true);
    expect(await onHand(p.id)).toBeCloseTo(stock, 3);
  });
});

// A complaint is not a record on its own: the refund IS a delivery return and the
// replacement IS a stock movement. Editing one has to rewrite those, or the bill
// would go on crediting the old figure while the page showed the new one.
describe("editing a complaint rewrites what it gave", () => {
  async function refundOf(qty: number) {
    const { p, c } = await delivered({ qty: 5, rate: 100 });
    const clean = await balance(c.id);
    expect((await createComplaint(draft(c.id, p.id, { quantity: qty }))).ok).toBe(true);
    const row = await db.customerComplaint.findFirstOrThrow({ where: { customerId: c.id } });
    return { p, c, row, clean };
  }

  it("a larger refund credits more, and only once", async () => {
    const { p, c, row, clean } = await refundOf(2);
    expect(await balance(c.id)).toBeCloseTo(clean - 200, 2);

    expect((await updateComplaint(row.id, draft(c.id, p.id, { quantity: 4 }))).ok).toBe(true);
    expect(await balance(c.id)).toBeCloseTo(clean - 400, 2);
    // One credit row, not the old one plus a new one.
    expect(await db.deliveryEntry.count({ where: { complaintId: row.id } })).toBe(1);
    const fresh = await db.customerComplaint.findUniqueOrThrow({ where: { id: row.id } });
    expect(Number(fresh.amount)).toBeCloseTo(400, 2);
  }, 180_000);

  it("saving it unchanged is allowed — it must not count against its own cap", async () => {
    const { p, c, row, clean } = await refundOf(5); // the whole day
    expect((await updateComplaint(row.id, draft(c.id, p.id, { quantity: 5 }))).ok).toBe(true);
    expect(await balance(c.id)).toBeCloseTo(clean - 500, 2);
  }, 180_000);

  it("still refuses more than was delivered that day", async () => {
    const { p, c, row } = await refundOf(2);
    const res = await updateComplaint(row.id, draft(c.id, p.id, { quantity: 9 }));
    expect(res.ok).toBe(false);
    // …and the complaint is left exactly as it was.
    const fresh = await db.customerComplaint.findUniqueOrThrow({ where: { id: row.id } });
    expect(Number(fresh.quantity)).toBeCloseTo(2, 3);
    expect(await db.deliveryEntry.count({ where: { complaintId: row.id } })).toBe(1);
  }, 180_000);

  it("turned into no compensation, the credit comes off the bill", async () => {
    const { p, c, row, clean } = await refundOf(2);
    expect((await updateComplaint(row.id, draft(c.id, p.id, { resolution: "NONE", quantity: null, productId: null }))).ok).toBe(true);
    expect(await balance(c.id)).toBeCloseTo(clean, 2);
    expect(await db.deliveryEntry.count({ where: { complaintId: row.id } })).toBe(0);
  }, 180_000);

  it("a replacement's stock follows the new quantity, without double-counting the old", async () => {
    const { p, c } = await delivered({ qty: 5, rate: 100, stock: 10 });
    const stock = await onHand(p.id);
    expect((await createComplaint(draft(c.id, p.id, { resolution: "REPLACEMENT", quantity: 2 }))).ok).toBe(true);
    const row = await db.customerComplaint.findFirstOrThrow({ where: { customerId: c.id } });
    expect(await onHand(p.id)).toBeCloseTo(stock - 2, 3);

    expect((await updateComplaint(row.id, draft(c.id, p.id, { resolution: "REPLACEMENT", quantity: 4 }))).ok).toBe(true);
    expect(await onHand(p.id)).toBeCloseTo(stock - 4, 3);
    // One movement, not two.
    expect(await db.inventoryMovement.count({ where: { reference: row.id, reason: COMPLAINT_REPLACEMENT_REASON } })).toBe(1);
  }, 180_000);

  it("a refund changed to a replacement takes the stock and puts the money back", async () => {
    const { p, c } = await delivered({ qty: 5, rate: 100, stock: 10 });
    const clean = await balance(c.id);
    const stock = await onHand(p.id);
    expect((await createComplaint(draft(c.id, p.id, { quantity: 3 }))).ok).toBe(true);
    const row = await db.customerComplaint.findFirstOrThrow({ where: { customerId: c.id } });
    expect(await balance(c.id)).toBeCloseTo(clean - 300, 2);

    expect((await updateComplaint(row.id, draft(c.id, p.id, { resolution: "REPLACEMENT", quantity: 3 }))).ok).toBe(true);
    // A replacement is free, so the bill goes back to where it was…
    expect(await balance(c.id)).toBeCloseTo(clean, 2);
    // …and the goods really leave.
    expect(await onHand(p.id)).toBeCloseTo(stock - 3, 3);
  }, 180_000);

  it("a refused replacement leaves the stock and the credit untouched", async () => {
    const { p, c } = await delivered({ qty: 5, rate: 100, stock: 4 });
    const clean = await balance(c.id);
    expect((await createComplaint(draft(c.id, p.id, { quantity: 3 }))).ok).toBe(true);
    const row = await db.customerComplaint.findFirstOrThrow({ where: { customerId: c.id } });
    const stock = await onHand(p.id);
    expect(await balance(c.id)).toBeCloseTo(clean - 300, 2);

    // More of it than exists: the edit is refused, and because the old refund is
    // undone before the new figures are checked, the whole thing has to roll back.
    const res = await updateComplaint(row.id, draft(c.id, p.id, { resolution: "REPLACEMENT", quantity: 99 }));
    expect(res.ok).toBe(false);

    expect(await balance(c.id)).toBeCloseTo(clean - 300, 2);   // credit still there
    expect(await onHand(p.id)).toBeCloseTo(stock, 3);          // stock untouched
    expect(await db.deliveryEntry.count({ where: { complaintId: row.id, isReturn: true } })).toBe(1);
  }, 180_000);

  it("refuses an edit on a complaint that is already gone", async () => {
    const { p, c, row } = await refundOf(2);
    expect((await deleteComplaint(row.id)).ok).toBe(true);
    const res = await updateComplaint(row.id, draft(c.id, p.id, { quantity: 1 }));
    expect(res.ok).toBe(false);
  }, 180_000);
});

describe("rider screens are untouched by a complaint", () => {
  it("the refund is not a rider return, and a manager's save can't turn it into a second credit", async () => {
    const shift = await makeShift();
    const { p, c } = await delivered({ qty: 5, rate: 100, shiftId: shift.id });
    await createComplaint(draft(c.id, p.id, { quantity: 2 }));

    const rep = await getRiderShiftReport(shift.id, TODAY);
    const row = rep.rows.find((r) => r.customerId === c.id)!;
    expect(row.deliveredTotal).toBeCloseTo(5, 3);
    expect(row.returnedTotal).toBe(0);

    // The manager saves exactly what the report shows.
    await saveRiderEdits({
      customerId: c.id, shiftId: shift.id, date: TODAY, cash: 0,
      lines: [{ productId: p.id, delivered: 5, returned: row.returnedTotal }],
    });
    expect(await db.deliveryEntry.count({ where: { customerId: c.id, complaintId: { not: null } } })).toBe(1);
    expect(await balance(c.id)).toBeCloseTo(300, 2); // 500 − 200, credited once
  });
});

describe("who can, and what is refused", () => {
  it("no compensation records the complaint and moves nothing", async () => {
    const { p, c } = await delivered({ qty: 5, rate: 100, stock: 5 });
    const bal = await balance(c.id);
    const stock = await onHand(p.id);
    const r = await createComplaint(draft(c.id, p.id, { category: "Late delivery", resolution: "NONE", productId: null, quantity: null }));
    expect(r.ok).toBe(true);
    expect(await balance(c.id)).toBeCloseTo(bal, 2);
    expect(await onHand(p.id)).toBeCloseTo(stock, 3);
    expect(await db.deliveryEntry.count({ where: { customerId: c.id, complaintId: { not: null } } })).toBe(0);
  });

  it("refuses a future delivery date", async () => {
    const { p, c } = await delivered({ qty: 5, rate: 100 });
    const tomorrow = addDaysToDateStr(TODAY, 1);
    expect((await createComplaint(draft(c.id, p.id, { deliveryDate: tomorrow, date: tomorrow }))).ok).toBe(false);
  });

  it("a manager can record one; a doctor cannot", async () => {
    const { p, c } = await delivered({ qty: 5, rate: 100 });
    try {
      setTestRole("MANAGER");
      expect((await createComplaint(draft(c.id, p.id, { quantity: 1 }))).ok).toBe(true);
      setTestRole("DOCTOR");
      await expect(createComplaint(draft(c.id, p.id, { quantity: 1 }))).rejects.toThrow();
    } finally {
      resetTestRole();
    }
  });
});
