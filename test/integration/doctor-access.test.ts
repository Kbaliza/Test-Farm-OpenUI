import { describe, it, expect, afterEach } from "vitest";
import { setTestRole, resetTestRole } from "../setup";
import {
  getProductionContext, getRecentProduction, getNetForDispatch,
} from "@/app/(dashboard)/inventory/production/actions";
import {
  getSkimMilkBatches, getTodayMilkAvailability,
} from "@/app/(dashboard)/inventory/skim-milk/actions";
import { getYoghurtBatches, getMilkInStorage } from "@/app/(dashboard)/inventory/yoghurt/actions";
import {
  getReconciliationData, getReconciliationDayEdit,
} from "@/app/(dashboard)/inventory/reconciliation/actions";
import { todayPKTString } from "@/lib/pkt";

afterEach(() => resetTestRole());

describe("DOCTOR can open every page their role grants", () => {
  it("Production / Milk Entry renders — including the embedded Skim Milk section", async () => {
    setTestRole("DOCTOR");
    // These are exactly what production/page.tsx awaits while rendering. Any one of
    // them throwing takes the whole page down (the doctor saw a 404).
    await expect(getProductionContext()).resolves.toBeTruthy();
    await expect(getRecentProduction()).resolves.toBeTruthy();
    await expect(getSkimMilkBatches()).resolves.toBeTruthy();
    await expect(getTodayMilkAvailability()).resolves.toBeTruthy();
    await expect(getNetForDispatch()).resolves.toBeTruthy();
  }, 240_000);

  it("Yoghurt and Reconciliation render", async () => {
    setTestRole("DOCTOR");
    await expect(getYoghurtBatches()).resolves.toBeTruthy();
    await expect(getMilkInStorage()).resolves.toBeTruthy();
    await expect(getReconciliationData(7)).resolves.toBeTruthy();
  }, 240_000);

  it("but the admin-only reconciliation edit stays closed to them", async () => {
    setTestRole("DOCTOR");
    await expect(getReconciliationDayEdit(todayPKTString())).rejects.toThrow();
  }, 120_000);
});
