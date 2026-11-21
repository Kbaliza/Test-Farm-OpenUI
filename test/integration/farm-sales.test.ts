import { describe, it, expect } from "vitest";
import { db, cleanups } from "../setup";
import { createVendor, snapshotHeads, headBal, fundHead, uniq } from "../helpers";
import {
  createFarmSale, deleteFarmSale, getFarmSalesHistory,
} from "@/app/(dashboard)/over-the-counter/farm-sales/actions";
import { getLedgerData } from "@/app/(dashboard)/ledgers/actions";
import { getDashboardData } from "@/app/(dashboard)/dashboard-data";
import { getHeadBalances } from "@/lib/head-balances";
import { FARM_SALE_WALKIN } from "@/lib/farm-sale-catalog";
import { todayPKTString } from "@/lib/pkt";

// Selling what the farm produces that is not milk. Two rules carry the whole
// feature: the money is real and must reach the head, and it is an asset disposal
// so it must NOT reach Profit.

const today = () => todayPKTString();

async function sell(over: Partial<Parameters<typeof createFarmSale>[0]> = {}) {
  const narration = uniq("fs");
  const res = await createFarmSale({
    date: today(),
    buyerType: "CASH",
    cashName: "Walk-in",
    paymentHead: "CASH",
    narration,
    lines: [{ category: "other", item: uniq("item"), unit: "unit", rate: 500, quantity: 2 }],
    ...over,
  });
  cleanups.push(async () => {
    const rows = await db.farmSale.findMany({ where: { narration }, select: { id: true, paymentId: true } });
    for (const r of rows) {
      await db.farmSale.delete({ where: { id: r.id } }).catch(() => {});
      if (r.paymentId) await db.payment.deleteMany({ where: { id: r.paymentId } }).catch(() => {});
    }
  });
  return { res, narration };
}

describe("the money reaches the account it was received into", () => {
  it("credits the chosen head by exactly the total", async () => {
    const delta = await snapshotHeads(["CASH", "HBL", "RIDER_CASH"]);
    const { res } = await sell({ paymentHead: "HBL" });
    expect(res.ok).toBe(true);

    expect(await delta("HBL")).toBeCloseTo(1000, 2);
    expect(await delta("CASH")).toBeCloseTo(0, 2);
    // Never the riders' box — money must not appear there from a desk screen.
    expect(await delta("RIDER_CASH")).toBeCloseTo(0, 2);
  }, 180000);

  it("adds the transport charge to the total", async () => {
    const delta = await snapshotHeads(["CASH"]);
    const { res } = await sell({ transportCharge: 1500 });
    expect(res.ok).toBe(true);
    expect(await delta("CASH")).toBeCloseTo(1000 + 1500, 2);
  }, 180000);

  it("refuses Rider Cash as the receiving account", async () => {
    const res = await createFarmSale({
      date: today(), buyerType: "CASH", paymentHead: "RIDER_CASH", narration: uniq("fs"),
      lines: [{ category: "other", item: "Scrap", unit: "unit", rate: 100, quantity: 1 }],
    });
    expect(res.ok).toBe(false);
  }, 180000);
});

describe("who it was sold to", () => {
  it("a vendor sale records the vendor", async () => {
    const v = await createVendor();
    const { res, narration } = await sell({ buyerType: "VENDOR", vendorId: v.id });
    expect(res.ok).toBe(true);

    const row = await db.farmSale.findFirstOrThrow({ where: { narration } });
    expect(row.vendorId).toBe(v.id);
    expect(row.cashName).toBeNull();
  }, 180000);

  it("refuses a vendor sale with no vendor chosen", async () => {
    const res = await createFarmSale({
      date: today(), buyerType: "VENDOR", paymentHead: "CASH", narration: uniq("fs"),
      lines: [{ category: "other", item: "Scrap", unit: "unit", rate: 100, quantity: 1 }],
    });
    expect(res.ok).toBe(false);
  }, 180000);

  it("a walk-in needs no buyer at all", async () => {
    const { res } = await sell({ buyerType: "CASH", cashName: "" });
    expect(res.ok).toBe(true);
  }, 180000);

  it("refuses an unknown buyer type", async () => {
    const res = await createFarmSale({
      date: today(), buyerType: "SOMEONE", paymentHead: "CASH",
      lines: [{ category: "other", item: "Scrap", unit: "unit", rate: 100, quantity: 1 }],
    });
    expect(res.ok).toBe(false);
  }, 180000);
});

describe("the numbers are the server's, not the browser's", () => {
  it("refuses a unit that does not belong to the category", async () => {
    const res = await createFarmSale({
      date: today(), buyerType: "CASH", paymentHead: "CASH",
      lines: [{ category: "feed", item: "Silage", unit: "head", rate: 100, quantity: 1 }],
    });
    expect(res.ok).toBe(false);
  }, 180000);

  it("refuses NaN, a negative rate and a zero quantity before anything is written", async () => {
    const delta = await snapshotHeads(["CASH"]);
    for (const line of [
      { category: "other", item: "X", unit: "unit", rate: NaN, quantity: 1 },
      { category: "other", item: "X", unit: "unit", rate: -5, quantity: 1 },
      { category: "other", item: "X", unit: "unit", rate: 100, quantity: 0 },
      { category: "other", item: "X", unit: "unit", rate: 100, quantity: NaN },
    ]) {
      const res = await createFarmSale({
        date: today(), buyerType: "CASH", paymentHead: "CASH", lines: [line],
      });
      expect(res.ok, JSON.stringify(line)).toBe(false);
    }
    // Nothing was written, so no head moved.
    expect(await delta("CASH")).toBeCloseTo(0, 2);
  }, 180000);

  it("refuses a sale with no items", async () => {
    const res = await createFarmSale({
      date: today(), buyerType: "CASH", paymentHead: "CASH", lines: [],
    });
    expect(res.ok).toBe(false);
  }, 180000);
});

describe("invoice numbers", () => {
  it("run in sequence, and two at once do not collide", async () => {
    const [a, b] = await Promise.all([sell(), sell()]);
    expect(a.res.ok).toBe(true);
    expect(b.res.ok).toBe(true);
    if (!a.res.ok || !b.res.ok) return;
    expect(a.res.invoiceNo).not.toBe(b.res.invoiceNo);
    for (const n of [a.res.invoiceNo, b.res.invoiceNo]) expect(n).toMatch(/^FSAL-\d{4}$/);
  }, 180000);
});

describe("animal details", () => {
  it("stores the tag in its own column and the rest as details", async () => {
    const { res, narration } = await sell({
      lines: [{
        category: "animal", item: "Buffalo (Nili-Ravi)", unit: "head", rate: 265000, quantity: 1,
        animalTag: "447", details: { weight: "520", status: "In milk" },
      }],
    });
    expect(res.ok).toBe(true);

    const sale = await db.farmSale.findFirstOrThrow({ where: { narration }, include: { lines: true } });
    expect(sale.lines[0].animalTag).toBe("447");
    expect(sale.lines[0].details).toMatchObject({ weight: "520", status: "In milk" });
  }, 180000);

  it("drops a tag typed against a category that has none", async () => {
    const { res, narration } = await sell({
      lines: [{ category: "feed", item: "Silage", unit: "ton", rate: 10000, quantity: 2, animalTag: "999" }],
    });
    expect(res.ok).toBe(true);
    const sale = await db.farmSale.findFirstOrThrow({ where: { narration }, include: { lines: true } });
    expect(sale.lines[0].animalTag).toBeNull();
  }, 180000);
});

describe("it is money in the bank but NOT profit", () => {
  it("head balances count it, the dashboard's Collected and Profit do not", async () => {
    const month = today().slice(0, 7);
    const before = await getDashboardData(month);
    const headsBefore = (await getHeadBalances()).reduce((s, h) => s + h.balance, 0);

    const { res } = await sell({ lines: [{ category: "animal", item: "Buffalo", unit: "head", rate: 265000, quantity: 1 }] });
    expect(res.ok).toBe(true);

    // The money genuinely arrived — hiding it here would break the overdraft guard.
    const headsAfter = (await getHeadBalances()).reduce((s, h) => s + h.balance, 0);
    expect(headsAfter - headsBefore).toBeCloseTo(265000, 2);

    // …but selling an asset is not earning it.
    const after = await getDashboardData(month);
    expect(after.kpis.collected).toBeCloseTo(before.kpis.collected, 2);
    expect(after.kpis.profit).toBeCloseTo(before.kpis.profit, 2);
    expect(after.kpis.monthlySales).toBeCloseTo(before.kpis.monthlySales, 2);

    // It shows up as its own figure instead.
    expect(after.kpis.farmSales - before.kpis.farmSales).toBeCloseTo(265000, 2);
  }, 180000);
});

describe("deleting a mis-keyed sale", () => {
  it("takes the money back out of the head", async () => {
    const { res, narration } = await sell();
    expect(res.ok).toBe(true);
    const sale = await db.farmSale.findFirstOrThrow({ where: { narration } });

    const delta = await snapshotHeads(["CASH"]);
    expect((await deleteFarmSale(sale.id)).ok).toBe(true);
    expect(await delta("CASH")).toBeCloseTo(-1000, 2);

    // The cash row goes with it — no orphan Payment left inflating the head.
    expect(await db.payment.count({ where: { id: sale.paymentId ?? "" } })).toBe(0);
    expect(await db.farmSaleLine.count({ where: { saleId: sale.id } })).toBe(0);
  }, 180000);

  it("is refused once that money has been spent, rather than driving the head negative", async () => {
    const { res, narration } = await sell({ paymentHead: "EASYPAISA" });
    expect(res.ok).toBe(true);
    const sale = await db.farmSale.findFirstOrThrow({ where: { narration } });

    // Spend the head down past what the sale put in.
    const box = await headBal("EASYPAISA");
    const note = uniq("x");
    const spent = await (await import("@/app/(dashboard)/payments/transfers/actions"))
      .createTransfer({ fromHead: "EASYPAISA", toHead: "CASH", amount: box, date: "", notes: note });
    cleanups.push(async () => { await db.headTransfer.deleteMany({ where: { notes: note } }).catch(() => {}); });
    expect(spent.ok).toBe(true);

    expect((await deleteFarmSale(sale.id)).ok).toBe(false);
    expect(await headBal("EASYPAISA")).toBeGreaterThanOrEqual(-0.005);
  }, 180000);
});

describe("the ledgers", () => {
  it("the buyer's farm-sale ledger lists it with a running total", async () => {
    const v = await createVendor();
    await fundHead("CASH", 1); // keeps the head non-empty for the delete guard elsewhere
    const { res, narration } = await sell({ buyerType: "VENDOR", vendorId: v.id });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const led = await getLedgerData("farmsale", v.id);
    if (!led.ok) throw new Error(led.error);
    expect(led.data.rows.length).toBeGreaterThan(0);
    expect(led.data.rows.some((r) => r.reference?.includes(res.invoiceNo))).toBe(true);
    // Nothing is ever owed, so the running column is a cumulative total.
    expect(led.data.rows[led.data.rows.length - 1].balance).toBeCloseTo(1000, 2);
    void narration;
  }, 180000);

  it("a cash walk-in is reachable under its own entity", async () => {
    const { res } = await sell({ buyerType: "CASH", cashName: "Beopari" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const led = await getLedgerData("farmsale", FARM_SALE_WALKIN);
    if (!led.ok) throw new Error(led.error);
    expect(led.data.entityInfo.name).toBe("Cash walk-ins");
    expect(led.data.rows.some((r) => r.reference?.includes(res.invoiceNo))).toBe(true);
  }, 180000);

  it("an unknown buyer is an error, not an empty statement", async () => {
    const led = await getLedgerData("farmsale", "nobody");
    expect(led.ok).toBe(false);
  }, 180000);

  it("shows on the vendor's own ledger without moving what we owe them", async () => {
    const v = await createVendor();
    const beforeLed = await getLedgerData("vendor", v.id);
    if (!beforeLed.ok) throw new Error(beforeLed.error);
    const beforeBal = beforeLed.data.rows.length ? beforeLed.data.rows[beforeLed.data.rows.length - 1].balance : 0;

    const { res } = await sell({ buyerType: "VENDOR", vendorId: v.id });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const led = await getLedgerData("vendor", v.id);
    if (!led.ok) throw new Error(led.error);
    const row = led.data.rows.find((r) => r.reference === res.invoiceNo);
    expect(row).toBeTruthy();
    // Context only: a paid sale must not change the payable balance.
    expect(row!.debit).toBeCloseTo(0, 2);
    expect(row!.credit).toBeCloseTo(0, 2);
    const afterBal = led.data.rows[led.data.rows.length - 1].balance;
    expect(afterBal).toBeCloseTo(beforeBal, 2);
  }, 180000);

  it("the head ledger shows the cash, so the account still reconciles", async () => {
    const { res } = await sell({ paymentHead: "JAZZCASH" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const led = await getLedgerData("head", "JAZZCASH");
    if (!led.ok) throw new Error(led.error);
    expect(led.data.rows.some((r) => r.note?.includes(res.invoiceNo))).toBe(true);
    expect(led.data.rows[led.data.rows.length - 1].balance).toBeCloseTo(await headBal("JAZZCASH"), 2);
  }, 180000);
});

describe("the history the page reads", () => {
  it("returns the sale with its lines and buyer name", async () => {
    const { res } = await sell({ buyerType: "CASH", cashName: "Ch. Nadeem" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const h = await getFarmSalesHistory();
    expect(h.dbReady).toBe(true);
    const row = h.sales.find((s) => s.invoiceNo === res.invoiceNo);
    expect(row).toBeTruthy();
    expect(row!.buyerName).toBe("Ch. Nadeem");
    expect(row!.lines).toHaveLength(1);
    expect(row!.totalAmount).toBeCloseTo(1000, 2);
  }, 180000);
});
