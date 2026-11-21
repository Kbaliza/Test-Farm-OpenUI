import { describe, it, expect } from "vitest";
import { db, cleanups } from "../setup";
import { uniq } from "../helpers";
import {
  createStaff,
  deleteStaff,
  getStaffPageData,
  setStaffActive,
  updateStaff,
  type StaffInput,
} from "@/app/(dashboard)/staff/actions";
import { getAttendancePageData } from "@/app/(dashboard)/attendance/actions";
import { getSalariesPageData } from "@/app/(dashboard)/payments/salaries/actions";
import { removeUser } from "@/app/(dashboard)/users/actions";
import { todayPKTString } from "@/lib/pkt";

const TODAY = todayPKTString();
const [Y, M] = TODAY.split("-").map(Number);

const input = (over: Partial<StaffInput> = {}): StaffInput => ({
  name: uniq("staff"), role: "Cleaner", wageType: "daily", wage: 1000, joinedAt: "", userId: null, ...over,
});

/** Removes a staff record and everything recorded against it. */
function cleanEmployee(id: string) {
  cleanups.push(async () => {
    await db.attendance.deleteMany({ where: { employeeId: id } });
    await db.salaryPayment.deleteMany({ where: { employeeId: id } });
    await db.bonus.deleteMany({ where: { employeeId: id } });
    await db.deduction.deleteMany({ where: { employeeId: id } });
    await db.checklistPenalty.deleteMany({ where: { employeeId: id } });
    await db.employee.delete({ where: { id } }).catch(() => {});
  });
}

/** Adds staff through the real action and returns the record. */
async function added(over: Partial<StaffInput> = {}) {
  const data = input(over);
  const res = await createStaff(data);
  if (!res.ok) throw new Error(res.error);
  const e = await db.employee.findFirstOrThrow({ where: { name: data.name } });
  cleanEmployee(e.id);
  return e;
}

async function login(role: "CHECKLIST" | "RIDER" = "CHECKLIST") {
  const u = await db.user.create({ data: { email: uniq("u") + "@t.local", name: uniq("login"), role, active: true, supabaseId: null } });
  cleanups.push(async () => {
    await db.checklistPenalty.deleteMany({ where: { userId: u.id } });
    await db.employee.updateMany({ where: { userId: u.id }, data: { userId: null } });
    await db.rider.deleteMany({ where: { userId: u.id } });
    await db.user.delete({ where: { id: u.id } }).catch(() => {});
  });
  return u;
}

const onAttendance = async (id: string) => (await getAttendancePageData(TODAY)).people.some((p) => p.id === id);
const onSalaries = async (id: string) => (await getSalariesPageData(M, Y)).employees.find((e) => e.id === id);

describe("adding and editing staff", () => {
  it("a new staff member shows on the Staff page, Attendance and Salaries", async () => {
    const e = await added();
    expect((await getStaffPageData()).staff.some((s) => s.id === e.id)).toBe(true);
    expect(await onAttendance(e.id)).toBe(true);
    expect(await onSalaries(e.id)).toBeTruthy();
  });

  it("name, role and pay can all be edited", async () => {
    const e = await added();
    const newName = uniq("renamed");
    const res = await updateStaff(e.id, input({ name: newName, role: "Guard", wageType: "fixed", wage: 25000 }));
    expect(res.ok).toBe(true);
    const after = await db.employee.findUniqueOrThrow({ where: { id: e.id } });
    expect(after.name).toBe(newName);
    expect(after.role).toBe("Guard");
    expect(Number(after.baseSalary)).toBe(25000);
    expect(after.dailyWage).toBeNull();
  });

  it("refuses an empty name and a negative wage", async () => {
    expect((await createStaff(input({ name: "  " }))).ok).toBe(false);
    expect((await createStaff(input({ wage: -1 }))).ok).toBe(false);
  });
});

describe("disable keeps every record; delete only when there are none", () => {
  it("disabling hides them from Attendance and keeps the days they worked; enabling brings them back", async () => {
    const e = await added();
    // Day 1, which is on or before the leaving day whatever day of the month this
    // runs on, so it is not one of the days disabling marks absent.
    const worked = new Date(Y, M - 1, 1, 12);
    await db.attendance.create({ data: { employeeId: e.id, date: worked, status: "PRESENT" } });

    expect((await setStaffActive(e.id, false)).ok).toBe(true);
    expect(await onAttendance(e.id)).toBe(false);
    // Nothing erased. The row count is no longer 1, because disabling now also
    // writes the REST of the month as absent — see staff-leaving-date.test.ts for
    // why. What this guards is that the day they actually worked still says so.
    expect(
      await db.attendance.count({ where: { employeeId: e.id, date: worked, status: "PRESENT" } }),
    ).toBe(1);

    expect((await setStaffActive(e.id, true)).ok).toBe(true);
    expect(await onAttendance(e.id)).toBe(true);
    // And it survives being taken back on, too.
    expect(
      await db.attendance.count({ where: { employeeId: e.id, date: worked, status: "PRESENT" } }),
    ).toBe(1);
  });

  it("delete is refused while they have records, and nothing is removed", async () => {
    const e = await added();
    await db.salaryPayment.create({ data: { employeeId: e.id, month: M, year: Y, amount: 1000, head: "CASH" } });

    const res = await deleteStaff(e.id);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("disable");
    expect(await db.employee.count({ where: { id: e.id } })).toBe(1);
    expect(await db.salaryPayment.count({ where: { employeeId: e.id } })).toBe(1);
  });

  it("someone with no records can be deleted completely", async () => {
    const e = await added();
    expect((await deleteStaff(e.id)).ok).toBe(true);
    expect(await db.employee.count({ where: { id: e.id } })).toBe(0);
  });

  it("Salaries shows a disabled person in the month they left, records or none", async () => {
    // The month someone leaves in is theirs up to the day they left: a wage worker
    // is paid for the days worked and a fixed salary pro rata. Disabling used to
    // drop them from the month entirely unless something was already recorded
    // against it, which is how half a month of work disappeared.
    const paid = await added();
    await db.salaryPayment.create({ data: { employeeId: paid.id, month: M, year: Y, amount: 1000, head: "CASH" } });
    await setStaffActive(paid.id, false);
    const quiet = await added();
    await setStaffActive(quiet.id, false);

    for (const id of [paid.id, quiet.id]) {
      const row = await onSalaries(id);
      expect(row).toBeTruthy();
      expect(row!.active).toBe(false);
      expect(row!.leftAt).toBe(TODAY);
    }
  });

  it("…and drops them from the months after it, unless something is recorded there", async () => {
    const gone = await added();
    await setStaffActive(gone.id, false);
    const next = M === 12 ? { y: Y + 1, m: 1 } : { y: Y, m: M + 1 };

    const after = await getSalariesPageData(next.m, next.y);
    expect(after.employees.find((x) => x.id === gone.id)).toBeUndefined();

    // A payment in that later month puts them back: money handed over is never
    // hidden by a date.
    await db.salaryPayment.create({ data: { employeeId: gone.id, month: next.m, year: next.y, amount: 500, head: "CASH" } });
    const again = await getSalariesPageData(next.m, next.y);
    expect(again.employees.find((x) => x.id === gone.id)).toBeTruthy();
  });
});

describe("riders are managed on the Riders page", () => {
  it("an active rider's record can't be disabled, deleted or renamed here — but pay can be edited", async () => {
    const u = await login("RIDER");
    await db.rider.create({ data: { userId: u.id, active: true } });
    const e = await db.employee.create({ data: { name: u.name, role: "Rider", baseSalary: 0, userId: u.id } });
    cleanEmployee(e.id);

    expect((await setStaffActive(e.id, false)).ok).toBe(false);
    expect((await deleteStaff(e.id)).ok).toBe(false);
    expect((await updateStaff(e.id, input({ name: uniq("other"), userId: u.id }))).ok).toBe(false);
    expect((await updateStaff(e.id, input({ name: u.name, wage: 1800, userId: u.id }))).ok).toBe(true);
    expect(Number((await db.employee.findUniqueOrThrow({ where: { id: e.id } })).dailyWage)).toBe(1800);
  });
});

describe("logins", () => {
  it("linking a login when adding staff brings that login's checklist penalties onto the salary", async () => {
    const u = await login();
    const pen = await db.checklistPenalty.create({
      data: { userId: u.id, employeeId: null, date: new Date(Date.UTC(Y, M - 1, 10)), itemsTotal: 10, itemsDone: 2, amount: 300 },
    });
    const e = await added({ userId: u.id });
    expect((await db.checklistPenalty.findUniqueOrThrow({ where: { id: pen.id } })).employeeId).toBe(e.id);
  });

  it("a login already linked to someone is refused", async () => {
    const u = await login();
    await added({ userId: u.id });
    const res = await createStaff(input({ userId: u.id }));
    expect(res.ok).toBe(false);
  });

  it("deleting a login keeps a staff record that has history (it used to fail)", async () => {
    const u = await login();
    const e = await db.employee.create({ data: { name: uniq("worker"), baseSalary: 0, userId: u.id } });
    cleanEmployee(e.id);
    await db.attendance.create({ data: { employeeId: e.id, date: new Date(Y, M - 1, 6, 12), status: "PRESENT" } });

    const res = await removeUser(u.id);
    expect(res.ok).toBe(true);
    expect(await db.user.count({ where: { id: u.id } })).toBe(0);
    const kept = await db.employee.findUniqueOrThrow({ where: { id: e.id } });
    expect(kept.userId).toBeNull();
    expect(await db.attendance.count({ where: { employeeId: e.id } })).toBe(1);
  });
});

describe("category (Agriculture / Retail / Farm)", () => {
  it("is saved when adding staff, and shows on the Staff page and on Attendance", async () => {
    const e = await added({ category: "FARM" });
    expect((await db.employee.findUniqueOrThrow({ where: { id: e.id } })).category).toBe("FARM");
    expect((await getStaffPageData()).staff.find((s) => s.id === e.id)?.category).toBe("FARM");
    expect((await getAttendancePageData(TODAY)).people.find((p) => p.id === e.id)?.category).toBe("FARM");
  });

  it("existing staff start as not set, and can be given one by editing", async () => {
    const e = await added(); // no category, like everyone added before this existed
    expect((await getStaffPageData()).staff.find((s) => s.id === e.id)?.category).toBeNull();

    expect((await updateStaff(e.id, input({ name: e.name, category: "AGRICULTURE" }))).ok).toBe(true);
    expect((await db.employee.findUniqueOrThrow({ where: { id: e.id } })).category).toBe("AGRICULTURE");
  });

  it("an edit that does not mention the category keeps it; null clears it", async () => {
    const e = await added({ category: "RETAIL" });
    const { category: _omit, ...withoutCategory } = input({ name: e.name, role: "Guard" });
    void _omit;
    expect((await updateStaff(e.id, withoutCategory)).ok).toBe(true);
    expect((await db.employee.findUniqueOrThrow({ where: { id: e.id } })).category).toBe("RETAIL");

    expect((await updateStaff(e.id, input({ name: e.name, category: null }))).ok).toBe(true);
    expect((await db.employee.findUniqueOrThrow({ where: { id: e.id } })).category).toBeNull();
  });

  it("refuses anything but the three categories, and writes nothing", async () => {
    const res = await createStaff(input({ category: "KITCHEN" }));
    expect(res.ok).toBe(false);
    const e = await added({ category: "FARM" });
    expect((await updateStaff(e.id, input({ name: e.name, category: "farm" }))).ok).toBe(false);
    expect((await db.employee.findUniqueOrThrow({ where: { id: e.id } })).category).toBe("FARM");
  });
});
