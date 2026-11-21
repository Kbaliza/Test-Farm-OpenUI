import { describe, it, expect } from "vitest";
import { db, cleanups } from "../setup";
import { uniq } from "../helpers";

// The client carries a `query` extension that puts the audit actor on the wire
// (src/lib/db.ts). That extension makes `db.model.create(...)` run IMMEDIATELY and
// return an ordinary promise rather than a lazy PrismaPromise, which quietly broke
// the batched `db.$transaction([ ... ])` form:
//
//   - every statement was sent before $transaction was even called, each in a
//     one-statement transaction of its own, so the batch was NOT atomic; and
//   - Prisma's batch API was handed plain promises it cannot orchestrate, so the
//     returned promise never settled.
//
// The visible symptom was Save Production writing the rows and then hanging for
// ever on "Saving...", with the entry only appearing after a hard refresh. Ten
// call sites used that form, including the money paths (expenses, recovery).
//
// They are all interactive now, and the batched form is refused outright so this
// can never again present as a hang.

describe("the batched $transaction form", () => {
  it("is refused outright rather than left to hang", async () => {
    const name = uniq("__TXFORM_refused");
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (db.$transaction as any)([
        db.product.create({ data: { name, unit: "LITER", defaultRate: 1 } }),
      ]),
    ).rejects.toThrow(/not supported on this client/);

    // Whatever the extension did with the operation, nothing may be left behind
    // under a name no caller ever saw committed.
    cleanups.push(async () => { await db.product.deleteMany({ where: { name } }); });
  }, 180_000);

  it("names the interactive form in the refusal, so the fix is obvious", async () => {
    let message = "";
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (db.$transaction as any)([]);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toMatch(/db\.\$transaction\(async \(tx\)/);
    expect(message).toMatch(/`tx`/);
  }, 180_000);
});

describe("the interactive $transaction form", () => {
  it("still commits every statement, and settles", async () => {
    const a = uniq("__TXFORM_a");
    const b = uniq("__TXFORM_b");
    cleanups.push(async () => { await db.product.deleteMany({ where: { name: { in: [a, b] } } }); });

    await db.$transaction(async (tx) => {
      await tx.product.create({ data: { name: a, unit: "LITER", defaultRate: 1 } });
      await tx.product.create({ data: { name: b, unit: "LITER", defaultRate: 2 } });
    });

    const made = await db.product.findMany({ where: { name: { in: [a, b] } }, select: { name: true } });
    expect(made.map((p) => p.name).sort()).toEqual([a, b].sort());
  }, 180_000);

  it("rolls the whole thing back when one statement throws", async () => {
    const a = uniq("__TXFORM_rollback");
    cleanups.push(async () => { await db.product.deleteMany({ where: { name: a } }); });

    await expect(
      db.$transaction(async (tx) => {
        await tx.product.create({ data: { name: a, unit: "LITER", defaultRate: 1 } });
        throw new Error("deliberate");
      }),
    ).rejects.toThrow("deliberate");

    // This is what the batched form could not promise: the first write is gone.
    expect(await db.product.count({ where: { name: a } })).toBe(0);
  }, 180_000);
});
