import { describe, it, expect, afterEach } from "vitest";
import { db, cleanups, setTestRole, resetTestRole } from "../setup";
import { createProduct, addStock, onHand } from "../helpers";
import {
  createPackagingWasteEntry,
  createWasteEntry,
  getPackagingWasteContext,
  getPackagingWasteLog,
  getWasteEntryContext,
} from "@/app/(dashboard)/inventory/waste-entry/actions";
import { getWastageData } from "@/app/(dashboard)/inventory/wastage/actions";

afterEach(() => resetTestRole());

const DATE = "2026-08-03T10:00"; // datetime-local (PKT)

describe("waste entry — deduction from in-storage", () => {
  it("deducts the exact quantity from on-hand", async () => {
    const p = await createProduct({ unit: "LITER" });
    await addStock(p.id, 100);
    expect(await onHand(p.id)).toBeCloseTo(100, 3);

    const res = await createWasteEntry({ productId: p.id, quantity: 30, stage: "Retail", reason: "Spoiled", date: DATE });
    expect(res.ok).toBe(true);
    expect(await onHand(p.id)).toBeCloseTo(70, 3);
  });

  it("a production-stage wastage row (stage=null) does NOT change on-hand", async () => {
    const p = await createProduct({ unit: "LITER" });
    await addStock(p.id, 100);
    // Same shape as logProductionWastage — no stage, reason "Production wastage".
    await db.inventoryMovement.create({ data: { type: "WASTAGE" as never, productId: p.id, quantity: 25, reason: "Production wastage" } });
    expect(await onHand(p.id)).toBeCloseTo(100, 3); // unchanged — only manual (stage-set) entries deduct
  });
});

describe("waste entry — cannot exceed current stock (no loophole)", () => {
  it("rejects a quantity greater than on-hand and writes nothing", async () => {
    const p = await createProduct({ unit: "LITER" });
    await addStock(p.id, 40);

    const res = await createWasteEntry({ productId: p.id, quantity: 45, stage: "Production", reason: "Chiller Failure", date: DATE });
    expect(res.ok).toBe(false);
    expect(await onHand(p.id)).toBeCloseTo(40, 3); // stock untouched
    expect(await db.inventoryMovement.count({ where: { productId: p.id, type: "WASTAGE", stage: { not: null } } })).toBe(0);
  });

  it("rejects a zero/negative quantity", async () => {
    const p = await createProduct({ unit: "LITER" });
    await addStock(p.id, 40);
    expect((await createWasteEntry({ productId: p.id, quantity: 0, stage: "Production", reason: "Spoiled", date: DATE })).ok).toBe(false);
    expect((await createWasteEntry({ productId: p.id, quantity: -5, stage: "Production", reason: "Spoiled", date: DATE })).ok).toBe(false);
  });
});

describe("waste entry — reflected in the Wastage log", () => {
  it("surfaces the entry with the entered qty, chosen stage/reason and the logging user's name", async () => {
    const p = await createProduct({ unit: "KG" });
    await addStock(p.id, 50);
    const res = await createWasteEntry({ productId: p.id, quantity: 12, stage: "Yoghurt", reason: "Human Error", date: DATE });
    expect(res.ok).toBe(true);

    const { entries } = await getWastageData();
    const row = entries.find((e) => e.productName === p.name && Math.abs(e.loss - 12) < 1e-6);
    expect(row).toBeTruthy();
    expect(row!.stage).toBe("Yoghurt");
    expect(row!.reason).toBe("Human Error"); // shown verbatim (not nulled)
    expect(row!.loggedBy).toBe("Vitest Admin"); // the signed-in user
  });

  it("a Riders entry is saved, deducts from storage and shows under Riders", async () => {
    const p = await createProduct({ unit: "LITER" });
    await addStock(p.id, 20);
    const res = await createWasteEntry({ productId: p.id, quantity: 3, stage: "Riders", reason: "Spilled", date: DATE });
    expect(res.ok).toBe(true);
    expect(await onHand(p.id)).toBeCloseTo(17, 3);

    const { entries } = await getWastageData();
    const row = entries.find((e) => e.productName === p.name);
    expect(row?.stage).toBe("Riders");
    expect(row?.loss).toBeCloseTo(3, 3);
  });
});

describe("waste entry — permissions & context", () => {
  it("createWasteEntry and getWasteEntryContext require FULL_ACCESS", async () => {
    setTestRole("DOCTOR");
    await expect(getWasteEntryContext()).rejects.toThrow(/permission/i);
    await expect(createWasteEntry({ productId: "x", quantity: 1, stage: "Production", reason: "Spoiled", date: DATE })).rejects.toThrow(/permission/i);
  });

  it("context reasons include the standard list and stages list the pipeline stages", async () => {
    const ctx = await getWasteEntryContext();
    expect(ctx.dbReady).toBe(true);
    expect(ctx.stages).toEqual(["Production", "Packaging", "Retail", "Yoghurt", "Riders"]); // Van stage removed

    expect(ctx.reasons).toContain("Spoiled");
    expect(ctx.reasons).toContain("Chiller Failure");
    expect(ctx.reasons[ctx.reasons.length - 1]).toBe("Other"); // "Other" kept last
  });
});

describe("packaging page wastage", () => {
  // Now, as a PKT datetime-local value, so the entry falls inside the 30-day log.
  const NOW = new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 16);

  it("is always saved as Packaging, comes off storage, and shows in its log and the Wastage log", async () => {
    const p = await createProduct({ unit: "LITER" });
    await addStock(p.id, 30);
    // Even if a stale browser sent another stage, the packaging action forces Packaging.
    const res = await createPackagingWasteEntry({ productId: p.id, quantity: 4, stage: "Production", reason: "Packet leaked", date: NOW });
    expect(res.ok).toBe(true);
    expect(await onHand(p.id)).toBeCloseTo(26, 3);

    const row = (await getPackagingWasteLog()).find((r) => r.productName === p.name);
    expect(row?.quantity).toBeCloseTo(4, 3);
    expect(row?.reason).toBe("Packet leaked");
    expect(row?.loggedBy).toBe("Vitest Admin");

    const logged = (await getWastageData()).entries.find((e) => e.productName === p.name);
    expect(logged?.stage).toBe("Packaging");
  });

  it("cannot waste more than is in storage", async () => {
    const p = await createProduct({ unit: "LITER" });
    await addStock(p.id, 2);
    expect((await createPackagingWasteEntry({ productId: p.id, quantity: 3, stage: "Packaging", reason: "Spoiled", date: NOW })).ok).toBe(false);
  });

  it("packaging staff can use it, and the Waste entry page", async () => {
    const p = await createProduct({ unit: "LITER" });
    await addStock(p.id, 10);
    setTestRole("PACKAGING");
    expect((await getPackagingWasteContext()).stages).toEqual(["Packaging"]);
    expect((await createPackagingWasteEntry({ productId: p.id, quantity: 1, stage: "Packaging", reason: "Spoiled", date: NOW })).ok).toBe(true);
    expect((await createWasteEntry({ productId: p.id, quantity: 1, stage: "Riders", reason: "Spoiled", date: NOW })).ok).toBe(true);
    expect((await getWastageData()).entries.filter((e) => e.productName === p.name)).toHaveLength(2);
  });

  it("other roles are refused", async () => {
    setTestRole("CHECKLIST");
    await expect(getPackagingWasteLog()).rejects.toThrow();
  });
});
