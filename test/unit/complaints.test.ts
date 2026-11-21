import { describe, it, expect } from "vitest";
import {
  billedRate,
  compensableQty,
  compensationProblem,
  complaintShapeProblem,
  isDateStr,
  refundValue,
  type ComplaintDraft,
  type DayProductFigures,
} from "@/lib/complaints";

const TODAY = "2026-09-11";

const figures = (over: Partial<DayProductFigures> = {}): DayProductFigures => ({
  delivered: 5,
  deliveredValue: 5 * 220,
  riderReturned: 0,
  alreadyCompensated: 0,
  ...over,
});

const draft = (over: Partial<ComplaintDraft> = {}): ComplaintDraft => ({
  customerId: "c1",
  deliveryDate: "2026-09-10",
  date: TODAY,
  category: "Spoiled milk",
  description: "Sour when opened",
  resolution: "REFUND",
  productId: "p1",
  quantity: 2,
  ...over,
});

describe("the cap — what can still be refunded or replaced", () => {
  it("is the whole delivery when nothing has come back", () => {
    expect(compensableQty(figures())).toBe(5);
  });

  it("leaves out what the rider already brought back, which is credited on its own", () => {
    expect(compensableQty(figures({ riderReturned: 1 }))).toBe(4);
  });

  it("leaves out what earlier complaints about the same day already took", () => {
    expect(compensableQty(figures({ riderReturned: 1, alreadyCompensated: 3 }))).toBe(1);
  });

  it("never goes negative", () => {
    expect(compensableQty(figures({ riderReturned: 4, alreadyCompensated: 4 }))).toBe(0);
  });

  it("does not drift on fractions", () => {
    expect(compensableQty(figures({ delivered: 1.5, riderReturned: 0.1, alreadyCompensated: 0.2 }))).toBe(1.2);
  });
});

describe("the refund is at the rate that was billed", () => {
  it("uses that day's rate, not the current price list", () => {
    expect(billedRate(figures())).toBe(220);
  });

  it("weights two rates on one day by quantity", () => {
    // 3 L at 200 + 1 L at 240 = 840 over 4 L = 210
    expect(billedRate(figures({ delivered: 4, deliveredValue: 3 * 200 + 1 * 240 }))).toBe(210);
  });

  it("is zero when nothing was delivered, rather than dividing by zero", () => {
    expect(billedRate(figures({ delivered: 0, deliveredValue: 0 }))).toBe(0);
  });

  it("refund value is quantity × rate, to the paisa", () => {
    expect(refundValue(2, 220)).toBe(440);
    expect(refundValue(1.5, 213.33)).toBe(320);
    expect(refundValue(-1, 220)).toBe(0);
  });
});

describe("compensationProblem — the server's final word", () => {
  it("allows up to exactly what is open", () => {
    expect(compensationProblem("REFUND", 5, figures(), "Milk")).toBeNull();
    expect(compensationProblem("REPLACEMENT", 5, figures(), "Milk")).toBeNull();
  });

  it("refuses a hair more than is open, naming the limit", () => {
    const msg = compensationProblem("REFUND", 4.01, figures({ riderReturned: 1 }), "Milk");
    expect(msg).toContain("Only 4");
  });

  it("refuses a product that was not delivered that day", () => {
    expect(compensationProblem("REFUND", 1, undefined, "Yoghurt")).toContain("No Yoghurt was delivered");
  });

  it("refuses once the whole day is used up", () => {
    expect(compensationProblem("REFUND", 1, figures({ alreadyCompensated: 5 }), "Milk")).toContain("already");
  });

  it("refuses a refund of something delivered free, but still allows a replacement", () => {
    const free = figures({ deliveredValue: 0 });
    expect(compensationProblem("REFUND", 1, free, "Milk")).toContain("nothing to refund");
    expect(compensationProblem("REPLACEMENT", 1, free, "Milk")).toBeNull();
  });

  it("asks nothing of a complaint with no compensation", () => {
    expect(compensationProblem("NONE", 999, undefined, "Milk")).toBeNull();
  });
});

describe("complaintShapeProblem — the form", () => {
  it("accepts a complete refund", () => {
    expect(complaintShapeProblem(draft(), TODAY)).toBeNull();
  });

  it("needs a customer, a category and what was said", () => {
    expect(complaintShapeProblem(draft({ customerId: "" }), TODAY)).not.toBeNull();
    expect(complaintShapeProblem(draft({ category: "Made up" }), TODAY)).not.toBeNull();
    expect(complaintShapeProblem(draft({ description: "   " }), TODAY)).not.toBeNull();
    expect(complaintShapeProblem(draft({ description: "x".repeat(501) }), TODAY)).not.toBeNull();
  });

  it("refuses dates in the future, and a complaint received before its delivery", () => {
    expect(complaintShapeProblem(draft({ deliveryDate: "2026-09-12", date: "2026-09-12" }), TODAY)).not.toBeNull();
    expect(complaintShapeProblem(draft({ date: "2026-09-12" }), TODAY)).not.toBeNull();
    expect(complaintShapeProblem(draft({ deliveryDate: TODAY, date: "2026-09-10" }), TODAY)).toContain("before the delivery");
  });

  it("refuses an unknown resolution", () => {
    expect(complaintShapeProblem(draft({ resolution: "CASHBACK" }), TODAY)).not.toBeNull();
  });

  it("a refund or replacement needs a product and a real quantity", () => {
    expect(complaintShapeProblem(draft({ productId: null }), TODAY)).not.toBeNull();
    expect(complaintShapeProblem(draft({ quantity: 0 }), TODAY)).not.toBeNull();
    expect(complaintShapeProblem(draft({ quantity: -2 }), TODAY)).not.toBeNull();
    expect(complaintShapeProblem(draft({ quantity: NaN }), TODAY)).not.toBeNull();
    expect(complaintShapeProblem(draft({ quantity: 1.005 }), TODAY)).not.toBeNull();
  });

  it("no compensation needs neither", () => {
    expect(complaintShapeProblem(draft({ resolution: "NONE", productId: null, quantity: null }), TODAY)).toBeNull();
  });
});

describe("isDateStr", () => {
  it("accepts real calendar days only", () => {
    expect(isDateStr("2026-09-11")).toBe(true);
    expect(isDateStr("2028-02-29")).toBe(true);
    expect(isDateStr("2026-02-29")).toBe(false);
    expect(isDateStr("2026-02-31")).toBe(false);
    expect(isDateStr("11-09-2026")).toBe(false);
    expect(isDateStr("")).toBe(false);
  });
});
