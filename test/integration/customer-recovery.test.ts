import { describe, it, expect } from "vitest";
import { db, cleanups, setTestRole, resetTestRole } from "../setup";
import { createCustomer, createProduct, uniq } from "../helpers";
import {
  getRecoveryBoard,
  setRecoveryStatus,
  logRecoveryEntry,
  logRecoveryNoAnswer,
  findCustomersToAdd,
  addToRecovery,
} from "@/app/(dashboard)/customers/recovery/actions";
import { AUTO_DEACTIVATION_REASON } from "@/lib/deactivation-reasons";

// The recovery list, end to end: who is on it, why, for how long, and what each
// action writes.

async function lostCustomer(reason: string | null, lastDeliveryDaysAgo?: number) {
  const c = await createCustomer({ name: uniq("Lost") });
  await db.$executeRaw`UPDATE "Customer" SET status = 'INACTIVE', "deactivationReason" = ${reason} WHERE id = ${c.id}`;
  cleanups.push(async () => { await db.winbackCase.deleteMany({ where: { customerId: c.id } }); });
  if (lastDeliveryDaysAgo != null) {
    const p = await createProduct({ unit: "LITER" });
    await db.deliveryEntry.create({
      data: { customerId: c.id, productId: p.id, quantity: 2, unitRate: 200, date: new Date(Date.now() - lastDeliveryDaysAgo * 86_400_000) } as never,
    });
  }
  return c;
}

const rowOf = async (id: string) => {
  const b = await getRecoveryBoard();
  if (!b.ok) throw new Error(b.error);
  return b.rows.find((r) => r.customerId === id);
};

describe("customer recovery", () => {
  it("lists a lost customer with the recorded reason and days since their last delivery", async () => {
    const auto = await lostCustomer(AUTO_DEACTIVATION_REASON, 40);
    const manual = await lostCustomer("Moving Out of City");
    const a = (await rowOf(auto.id))!;
    expect(a.source).toBe("auto");
    expect(a.potential).toBe("high");
    expect(a.daysInactive).toBe(40);
    expect(a.status).toBe("Not Contacted");
    const m = (await rowOf(manual.id))!;
    expect(m.source).toBe("manual");
    expect(m.potential).toBe("low");
    expect(m.reason).toBe("Moving Out of City");
    expect(m.daysInactive).toBeNull(); // never delivered
  }, 180_000);

  it("records a status change, a call and a note — with who and from what", async () => {
    const c = await lostCustomer("Stopped - Poor Service");
    expect((await setRecoveryStatus(c.id, "Interested")).ok).toBe(true);
    expect((await logRecoveryEntry(c.id, "CALL", "Will restart after Eid")).ok).toBe(true);
    expect((await logRecoveryEntry(c.id, "NOTE", "Prefers mornings")).ok).toBe(true);
    const r = (await rowOf(c.id))!;
    expect(r.status).toBe("Interested");
    expect(r.activity.map((a) => a.type)).toEqual(["NOTE", "CALL", "STATUS"]); // newest first
    const st = r.activity[2];
    expect(st.from).toBe("Not Contacted");
    expect(st.to).toBe("Interested");
    expect(st.by).toBeTruthy();
    // Refused: an unknown status, and an empty note.
    expect((await setRecoveryStatus(c.id, "Whatever")).ok).toBe(false);
    expect((await logRecoveryEntry(c.id, "NOTE", "  ")).ok).toBe(false);
  }, 180_000);

  it("no-answer calls move the case 1st → 2nd → 3rd and log every attempt", async () => {
    const c = await lostCustomer(null);
    for (let i = 0; i < 4; i++) expect((await logRecoveryNoAnswer(c.id)).ok).toBe(true);
    const r = (await rowOf(c.id))!;
    expect(r.status).toBe("No Answer - 3rd Call");
    const calls = r.activity.filter((a) => a.type === "CALL").map((a) => a.text);
    expect(calls).toEqual([
      "No answer (attempt 3 of 3)", "No answer (attempt 3 of 3)", "No answer (attempt 2 of 3)", "No answer (attempt 1 of 3)",
    ]);
    // Three status steps, not four — the 4th call left it at the 3rd.
    expect(r.activity.filter((a) => a.type === "STATUS")).toHaveLength(3);
  }, 180_000);

  it("refuses to open a case for a customer who is neither lost nor added", async () => {
    const active = await createCustomer({ name: uniq("Active") });
    expect((await setRecoveryStatus(active.id, "Interested")).ok).toBe(false);
    expect(await db.winbackCase.count({ where: { customerId: active.id } })).toBe(0);
  }, 120_000);

  it("adds an active customer by hand, and marks them recovered once they are active after being lost", async () => {
    const active = await createCustomer({ name: uniq("Quiet") });
    cleanups.push(async () => { await db.winbackCase.deleteMany({ where: { customerId: active.id } }); });
    const found = await findCustomersToAdd(active.name.slice(0, 12));
    expect(found.some((f) => f.id === active.id)).toBe(true);
    expect((await addToRecovery(active.id, "stopped ordering")).ok).toBe(true);
    expect((await addToRecovery(active.id, "")).ok).toBe(false); // already on the list
    const added = (await rowOf(active.id))!;
    expect(added.source).toBe("added");

    // A lost customer who is worked on and then comes back is recovered on the next read.
    const c = await lostCustomer("Away Temporarily - Return Date Given");
    await setRecoveryStatus(c.id, "Delivery Pending");
    await db.$executeRaw`UPDATE "Customer" SET status = 'ACTIVE', "deactivationReason" = NULL WHERE id = ${c.id}`;
    const r = (await rowOf(c.id))!;
    expect(r.status).toBe("Recovered");
    expect(r.activity[0].by).toBe("System");
    expect(r.activity[0].text).toBe("Customer is active again");
  }, 240_000);

  it("is for managers and admins only", async () => {
    setTestRole("PACKAGING");
    await expect(getRecoveryBoard()).rejects.toThrow(/permission/i);
    resetTestRole();
  }, 60_000);
});
