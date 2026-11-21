import { describe, it, expect } from "vitest";
import { db, cleanups } from "../setup";
import { fundHead, snapshotHeads } from "../helpers";
import { createTransfer, deleteTransfer } from "@/app/(dashboard)/payments/transfers/actions";
import { getHeadBalance } from "@/lib/head-balances";

describe("createTransfer / deleteTransfer", () => {
  it("moves money between heads and reverses on delete", async () => {
    await fundHead("CASH", 5000);
    const delta = await snapshotHeads(["CASH", "HBL"]);

    const res = await createTransfer({ fromHead: "CASH", toHead: "HBL", amount: 2000, date: "", notes: "t-xfer" });
    expect(res.ok).toBe(true);
    expect(await delta("CASH")).toBeCloseTo(-2000, 2);
    expect(await delta("HBL")).toBeCloseTo(2000, 2);

    const xfer = await (await import("../setup")).db.headTransfer.findFirst({ where: { notes: "t-xfer" }, orderBy: { createdAt: "desc" } });
    const del = await deleteTransfer(xfer!.id);
    expect(del.ok).toBe(true);
    expect(await delta("CASH")).toBeCloseTo(0, 2); // fully reversed
    expect(await delta("HBL")).toBeCloseTo(0, 2);
  });

  it("refuses to move more than the source head holds", async () => {
    const before = await getHeadBalance("EASYPAISA");
    const res = await createTransfer({ fromHead: "EASYPAISA", toHead: "CASH", amount: before + 1_000_000, date: "" });
    expect(res.ok).toBe(false);
  });

  it("rejects same-head and non-positive transfers", async () => {
    expect((await createTransfer({ fromHead: "CASH", toHead: "CASH", amount: 100, date: "" })).ok).toBe(false);
    expect((await createTransfer({ fromHead: "CASH", toHead: "HBL", amount: 0, date: "" })).ok).toBe(false);
  });
});

describe("overdraft guard under concurrency (guardHeadFundsTx)", () => {
  it("two concurrent outflows that each need the FULL balance: only ONE succeeds", async () => {
    // Fund JAZZCASH to a guaranteed-positive balance regardless of any leftover state.
    const cur = await getHeadBalance("JAZZCASH");
    await fundHead("JAZZCASH", Math.max(0, 3000 - cur) + 3000);
    const start = await getHeadBalance("JAZZCASH");
    expect(start).toBeGreaterThan(0);

    // Two transfers, each moving the entire balance out. Only ONE can win — the
    // per-head advisory lock serialises them and the loser sees 0 available.
    const results = await Promise.all([
      createTransfer({ fromHead: "JAZZCASH", toHead: "CASH", amount: start, date: "", notes: "race-a" }),
      createTransfer({ fromHead: "JAZZCASH", toHead: "CASH", amount: start, date: "", notes: "race-b" }),
    ]);
    // Clean up whichever transfer won so JAZZCASH isn't left drained for later runs.
    cleanups.push(async () => { await db.headTransfer.deleteMany({ where: { notes: { in: ["race-a", "race-b"] } } }).catch(() => {}); });

    const wins = results.filter((r) => r.ok).length;
    expect(wins).toBe(1);
    expect(await getHeadBalance("JAZZCASH")).toBeGreaterThanOrEqual(-0.01); // never driven negative
  });
});
