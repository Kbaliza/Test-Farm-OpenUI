import { describe, it, expect } from "vitest";
import { db, cleanups } from "../setup";
import { fundHead, uniq } from "../helpers";
import {
  getSalariesPageData,
  recordSalaryPayment,
  updateEmployee,
} from "@/app/(dashboard)/payments/salaries/actions";
import { applyCarry } from "@/lib/salary-advance";
import { todayPKTString } from "@/lib/pkt";

const TODAY = todayPKTString();
const [Y, M] = TODAY.split("-").map(Number);
const PREV = M === 1 ? { y: Y - 1, m: 12 } : { y: Y, m: M - 1 };
/** A day inside the selected month, for penalty rows. */
const IN_MONTH = new Date(Date.UTC(Y, M - 1, 10));

/** A salary record, with everything it leaves behind cleaned up. */
async function employee(opts: { base?: number; daily?: number | null; userId?: string | null } = {}) {
  const e = await db.employee.create({
    data: {
      name: uniq("emp"),
      role: "Helper",
      baseSalary: opts.base ?? 0,
      dailyWage: opts.daily ?? null,
      active: true,
      userId: opts.userId ?? null,
    },
  });
  cleanups.push(async () => {
    await db.salaryPayment.deleteMany({ where: { employeeId: e.id } });
    await db.attendance.deleteMany({ where: { employeeId: e.id } });
    await db.bonus.deleteMany({ where: { employeeId: e.id } });
    await db.deduction.deleteMany({ where: { employeeId: e.id } });
    await db.checklistPenalty.deleteMany({ where: { employeeId: e.id } });
    await db.employee.delete({ where: { id: e.id } }).catch(() => {});
  });
  return e;
}

/** A login that owns checklist penalties. */
async function login() {
  const u = await db.user.create({
    data: { email: uniq("u") + "@t.local", name: uniq("login"), role: "CHECKLIST", active: true, supabaseId: uniq("sb") },
  });
  cleanups.push(async () => {
    await db.checklistPenalty.deleteMany({ where: { userId: u.id } });
    await db.employee.updateMany({ where: { userId: u.id }, data: { userId: null } });
    await db.user.delete({ where: { id: u.id } }).catch(() => {});
  });
  return u;
}

async function rowFor(employeeId: string) {
  const data = await getSalariesPageData(M, Y);
  return data.employees.find((x) => x.id === employeeId)!;
}

const config = (userId: string | null) => ({ role: "Helper", wageType: "fixed" as const, wage: 30000, joinedAt: "", userId });

describe("last month's balance carries into this month", () => {
  it("OWED carries forward and is added to what is owed now", async () => {
    const e = await employee({ base: 30000 });
    await db.salaryPayment.create({ data: { employeeId: e.id, month: PREV.m, year: PREV.y, amount: 10000, head: "CASH", notes: "part" } });

    const row = await rowFor(e.id);
    expect(row.carryIn).toBeCloseTo(20000, 2);
    expect(applyCarry(30000, 0, row.carryIn).balance).toBeCloseTo(50000, 2);
  });

  it("EXTRA carries forward and comes off what is owed now", async () => {
    const e = await employee({ base: 30000 });
    await db.salaryPayment.create({ data: { employeeId: e.id, month: PREV.m, year: PREV.y, amount: 35000, head: "CASH", notes: "extra" } });

    const row = await rowFor(e.id);
    expect(row.carryIn).toBeCloseTo(-5000, 2);
    expect(applyCarry(30000, 0, row.carryIn).balance).toBeCloseTo(25000, 2);
  });

  it("an exactly-paid month carries nothing", async () => {
    const e = await employee({ base: 30000 });
    await db.salaryPayment.create({ data: { employeeId: e.id, month: PREV.m, year: PREV.y, amount: 30000, head: "CASH", notes: "full" } });
    expect((await rowFor(e.id)).carryIn).toBe(0);
  });

  it("a month with only a bonus — no attendance, no payment — is not valued (the Kamran case)", async () => {
    const e = await employee({ daily: 1000 });
    await db.bonus.create({ data: { employeeId: e.id, month: PREV.m, year: PREV.y, amount: 500 } });
    // Counting every unmarked day as worked would have carried a whole month as owed.
    expect((await rowFor(e.id)).carryIn).toBe(0);
  });

  it("paying extra THIS month shows as extra", async () => {
    const e = await employee({ base: 30000 });
    await fundHead("CASH", 60000);
    const res = await recordSalaryPayment({ employeeId: e.id, month: M, year: Y, amount: 32000, head: "CASH", notes: "overpaid" });
    if (!res.ok) throw new Error(res.error);

    const row = await rowFor(e.id);
    const paid = row.payments.reduce((s, p) => s + p.amount, 0);
    const out = applyCarry(30000, paid, row.carryIn);
    expect(out.balance).toBe(0);
    expect(out.extraLeft).toBeCloseTo(2000, 2);
  });
});

describe("linking a salary record to a login", () => {
  it("brings that login's earlier checklist penalties onto the salary", async () => {
    const u = await login();
    const e = await employee({ base: 30000 });
    // Scored before any salary record was linked, so it carries no employee.
    await db.checklistPenalty.create({
      data: { userId: u.id, employeeId: null, date: IN_MONTH, itemsTotal: 10, itemsDone: 2, amount: 300 },
    });

    const res = await updateEmployee(e.id, config(u.id));
    expect(res.ok).toBe(true);

    expect((await db.employee.findUnique({ where: { id: e.id } }))!.userId).toBe(u.id);
    expect(await db.checklistPenalty.count({ where: { userId: u.id, employeeId: e.id } })).toBe(1);
    expect((await rowFor(e.id)).penalties).toHaveLength(1);
  });

  it("moving the link takes the old login's penalties back off", async () => {
    const oldLogin = await login();
    const newLogin = await login();
    const e = await employee({ base: 30000, userId: oldLogin.id });
    await db.checklistPenalty.create({
      data: { userId: oldLogin.id, employeeId: e.id, date: IN_MONTH, itemsTotal: 10, itemsDone: 2, amount: 300 },
    });

    expect((await updateEmployee(e.id, config(newLogin.id))).ok).toBe(true);

    expect(await db.checklistPenalty.count({ where: { userId: oldLogin.id, employeeId: e.id } })).toBe(0);
    expect(await db.checklistPenalty.count({ where: { userId: oldLogin.id, employeeId: null } })).toBe(1);
  });

  it("refuses a login that is already linked to another salary record", async () => {
    const u = await login();
    await employee({ base: 30000, userId: u.id });
    const other = await employee({ base: 30000 });

    const res = await updateEmployee(other.id, config(u.id));
    expect(res.ok).toBe(false);
    expect((await db.employee.findUnique({ where: { id: other.id } }))!.userId).toBeNull();
  });

  it("leaves the link alone when the form does not send one", async () => {
    const u = await login();
    const e = await employee({ base: 30000, userId: u.id });
    const res = await updateEmployee(e.id, { role: "Helper", wageType: "fixed", wage: 31000, joinedAt: "" });
    expect(res.ok).toBe(true);
    expect((await db.employee.findUnique({ where: { id: e.id } }))!.userId).toBe(u.id);
  });
});
