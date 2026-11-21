import { describe, it, expect } from "vitest";
import { db, cleanups } from "../setup";
import { createProduct, uniq } from "../helpers";
import {
  createSample, getSamplesPageData, resendSample, markSampleDelivered, markSampleNotDelivered,
} from "@/app/(dashboard)/samples/actions";
import { getShiftCustomers } from "@/app/(dashboard)/customers/pre-delivery/actions";
import { getRiderShiftReport } from "@/app/(dashboard)/customers/rider-report/actions";
import { todayPKTString, pktNoonToUTC } from "@/lib/pkt";

const TODAY = todayPKTString();

/** A shift, and a sample on it for 2 × 120. */
async function sampleOnShift() {
  const shift = await db.shift.create({ data: { name: uniq("shift") } });
  const p = await createProduct({ defaultRate: 120 });
  const name = uniq("lead");
  expect((await createSample({
    name, phone: "03001234567", shiftId: shift.id,
    items: [{ productId: p.id, quantity: 2, ratePerUnit: 120 }],
  })).ok).toBe(true);
  const s = await db.sampleLead.findFirstOrThrow({ where: { name } });
  cleanups.push(async () => {
    await db.payment.deleteMany({ where: { sampleId: s.id } });
    await db.sampleLead.delete({ where: { id: s.id } }).catch(() => {});
    await db.route.deleteMany({ where: { shiftId: shift.id } });
    await db.shift.delete({ where: { id: shift.id } }).catch(() => {});
  });
  return { shift, sample: s, product: p };
}

/** The rider completes a run of the shift at `at`. */
async function completedRun(shiftId: string, at: Date, daysAhead = 0) {
  // One route per shift per day — a later run goes on a later day.
  const date = new Date(pktNoonToUTC(TODAY).getTime() + daysAhead * 86_400_000);
  return db.route.create({
    data: { shiftId, date, status: "COMPLETED", completedAt: at },
  });
}

const status = async (id: string) => (await db.sampleLead.findUniqueOrThrow({ where: { id } })).status;
const onEditor = async (shiftId: string, id: string) =>
  (await getShiftCustomers(shiftId, TODAY, true)).stops.some((s) => s.customerId === `sample:${id}`);

describe("resend puts a sample back on the NEXT run", () => {
  it("each round is charged on its own tick, and shows in the shift editor between them", async () => {
    const { shift, sample } = await sampleOnShift();
    const tick = () => db.sampleLead.update({
      where: { id: sample.id },
      data: { riderOutcome: "DELIVERED", paymentMethod: "CASH", riderOutcomeAt: new Date() },
    });

    await tick();
    await getSamplesPageData(); // reconcile
    expect(await status(sample.id)).toBe("DELIVERED");

    expect((await resendSample(sample.id, [{ productId: (await db.sampleItem.findFirstOrThrow({ where: { sampleId: sample.id } })).productId, quantity: 1, ratePerUnit: 120 }])).ok).toBe(true);
    // The resend clears the tick, so nothing settles it until he answers again —
    // and a finished round must not do it for him.
    await completedRun(shift.id, new Date(Date.now() + 1000), 1);
    await getSamplesPageData();
    expect(await status(sample.id)).toBe("ASSIGNED");
    expect(await onEditor(shift.id, sample.id)).toBe(true);
    expect(await db.payment.count({ where: { sampleId: sample.id } })).toBe(1);

    // His tick on the new round settles it, and charges the new basket separately.
    await tick();
    await getSamplesPageData();
    expect(await status(sample.id)).toBe("DELIVERED");
    const pays = await db.payment.findMany({ where: { sampleId: sample.id }, orderBy: { sampleRound: "asc" } });
    expect(pays.map((p) => p.sampleRound)).toEqual([0, 1]);
    expect(Number(pays[1].amount)).toBeCloseTo(120, 2); // the resent basket: 1 × 120

    // Loading the page again books nothing more.
    await getSamplesPageData();
    expect(await db.payment.count({ where: { sampleId: sample.id } })).toBe(2);
  }, 240_000);
});

describe("the rider's own tick settles it, with no finished run needed", () => {
  it("rider ticks delivered → delivered at the time he said, and charged", async () => {
    const { sample } = await sampleOnShift();
    const at = new Date(Date.now() - 60_000);
    await db.sampleLead.update({
      where: { id: sample.id },
      data: { riderOutcome: "DELIVERED", paymentMethod: "CASH", riderOutcomeAt: at },
    });

    // No route is ever completed — the rider's report is the whole story.
    await getSamplesPageData();
    const row = await db.sampleLead.findUniqueOrThrow({ where: { id: sample.id } });
    expect(row.status).toBe("DELIVERED");
    expect(row.deliveredAt?.getTime()).toBe(at.getTime());
    const pays = await db.payment.findMany({ where: { sampleId: sample.id } });
    expect(pays.map((p) => p.head)).toEqual(["RIDER_CASH"]);
    expect(Number(pays[0].amount)).toBeCloseTo(240, 2);

    // And loading the page again charges nothing more.
    await getSamplesPageData();
    expect(await db.payment.count({ where: { sampleId: sample.id } })).toBe(1);
  }, 240_000);

  it("rider ticks not delivered → Not delivered, nothing charged, no run needed", async () => {
    const { sample } = await sampleOnShift();
    await db.sampleLead.update({
      where: { id: sample.id },
      data: { riderOutcome: "NOT_DELIVERED", notDeliveredReason: "Not home", riderOutcomeAt: new Date() },
    });
    await getSamplesPageData();
    expect(await status(sample.id)).toBe("NOT_DELIVERED");
    expect(await db.payment.count({ where: { sampleId: sample.id } })).toBe(0);
  }, 240_000);

  it("a resent sample is not settled again by the tick from its last round", async () => {
    const { shift, sample } = await sampleOnShift();
    await db.sampleLead.update({
      where: { id: sample.id },
      data: { riderOutcome: "DELIVERED", paymentMethod: "CASH", riderOutcomeAt: new Date() },
    });
    await getSamplesPageData();
    expect(await status(sample.id)).toBe("DELIVERED");

    const item = await db.sampleItem.findFirstOrThrow({ where: { sampleId: sample.id } });
    expect((await resendSample(sample.id, [{ productId: item.productId, quantity: 1, ratePerUnit: 120 }])).ok).toBe(true);

    // The old tick is gone with the resend, so it waits for the new round.
    await getSamplesPageData();
    expect(await status(sample.id)).toBe("ASSIGNED");
    expect(await db.payment.count({ where: { sampleId: sample.id } })).toBe(1);
    expect(await onEditor(shift.id, sample.id)).toBe(true);
  }, 240_000);
});

describe("what the rider reports", () => {
  it("NOT_DELIVERED from the rider → Not delivered when the run completes, nothing charged", async () => {
    const { shift, sample } = await sampleOnShift();
    await db.sampleLead.update({ where: { id: sample.id }, data: { riderOutcome: "NOT_DELIVERED", notDeliveredReason: "Not home", riderOutcomeAt: new Date() } });
    await completedRun(shift.id, new Date(Date.now() + 1000));
    await getSamplesPageData();
    expect(await status(sample.id)).toBe("NOT_DELIVERED");
    expect(await db.payment.count({ where: { sampleId: sample.id } })).toBe(0);
  }, 240_000);

  it("paid by HBL → booked into HBL, not rider cash", async () => {
    const { shift, sample } = await sampleOnShift();
    await db.sampleLead.update({ where: { id: sample.id }, data: { riderOutcome: "DELIVERED", paymentMethod: "HBL", riderOutcomeAt: new Date() } });
    await completedRun(shift.id, new Date(Date.now() + 1000));
    await getSamplesPageData();
    expect(await status(sample.id)).toBe("DELIVERED");
    const pays = await db.payment.findMany({ where: { sampleId: sample.id } });
    expect(pays).toHaveLength(1);
    expect(pays[0].head).toBe("HBL");
    expect(Number(pays[0].amount)).toBeCloseTo(240, 2);
  }, 240_000);

  it("nothing reported → stays assigned and is NOT charged, however many rounds finish", async () => {
    // The bug this replaces: a finished round delivered the sample by itself and
    // booked the rider cash, for samples the rider had never answered for. Twelve
    // samples and PKR 5,420 in one week.
    const { shift, sample } = await sampleOnShift();
    await completedRun(shift.id, new Date(Date.now() + 1000));
    await getSamplesPageData();
    expect(await status(sample.id)).toBe("ASSIGNED");
    expect(await db.payment.count({ where: { sampleId: sample.id } })).toBe(0);

    // A second finished round does not change its mind either.
    await completedRun(shift.id, new Date(Date.now() + 2000), 1);
    await getSamplesPageData();
    expect(await status(sample.id)).toBe("ASSIGNED");
    expect(await db.payment.count({ where: { sampleId: sample.id } })).toBe(0);

    // It is still on the shift editor, waiting to be answered for.
    expect(await onEditor(shift.id, sample.id)).toBe(true);
  }, 240_000);

  it("DELIVERED reported without a timestamp still settles, on the finished round", async () => {
    // The app should always send the time, but a report missing it is a real
    // delivery and must not be dropped.
    const { shift, sample } = await sampleOnShift();
    await db.sampleLead.update({
      where: { id: sample.id },
      data: { riderOutcome: "DELIVERED", paymentMethod: "CASH", riderOutcomeAt: null },
    });
    const run = await completedRun(shift.id, new Date(Date.now() + 1000));
    await getSamplesPageData();
    expect(await status(sample.id)).toBe("DELIVERED");
    const got = await db.sampleLead.findUniqueOrThrow({ where: { id: sample.id }, select: { deliveredAt: true } });
    expect(got.deliveredAt?.toISOString()).toBe(run.completedAt?.toISOString());
    expect(await db.payment.count({ where: { sampleId: sample.id } })).toBe(1);
  }, 240_000);
});

describe("the office can record it too", () => {
  it("not delivered needs a reason, and counts in the Not delivered card", async () => {
    const { sample } = await sampleOnShift();
    const before = (await getSamplesPageData()).pipeline.notDelivered;
    expect((await markSampleNotDelivered(sample.id, "  ")).ok).toBe(false);
    expect((await markSampleNotDelivered(sample.id, "Wrong address")).ok).toBe(true);
    expect(await status(sample.id)).toBe("NOT_DELIVERED");
    expect((await getSamplesPageData()).pipeline.notDelivered).toBe(before + 1);
  }, 240_000);

  it("delivered by hand books the chosen account", async () => {
    const { sample } = await sampleOnShift();
    expect((await markSampleDelivered(sample.id, "JAZZCASH")).ok).toBe(true);
    const pays = await db.payment.findMany({ where: { sampleId: sample.id } });
    expect(pays.map((p) => p.head)).toEqual(["JAZZCASH"]);
    expect((await markSampleDelivered(sample.id, "BITCOIN")).ok).toBe(false);
  }, 240_000);
});

describe("rider reports list the samples", () => {
  it("a sample the rider ticked delivered shows in that day's rider report", async () => {
    const { shift, sample } = await sampleOnShift();
    await db.sampleLead.update({
      where: { id: sample.id },
      data: { riderOutcome: "DELIVERED", paymentMethod: "CASH", riderOutcomeAt: new Date() },
    });
    await getSamplesPageData();
    const report = await getRiderShiftReport(shift.id, TODAY);
    const row = report.samples.find((s) => s.id === sample.id);
    expect(row?.status).toBe("delivered");
    expect(row?.amount).toBeCloseTo(240, 2);
  }, 240_000);
});
