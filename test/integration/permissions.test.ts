import { describe, it, expect, afterEach } from "vitest";
import { setTestRole, resetTestRole } from "../setup";
import { createCustomer, createProduct, createVendor, addStock } from "../helpers";
import { createOtcSale, deleteOtcSale, getOtcSaleContext, getOtcSaleHistory } from "@/app/(dashboard)/over-the-counter/sale/actions";
import { createOtcPurchase, deleteOtcPurchase, getOtcPurchaseContext, getOtcPurchaseHistory } from "@/app/(dashboard)/over-the-counter/purchase/actions";
import { getFarmSalesContext } from "@/app/(dashboard)/over-the-counter/farm-sales/actions";
import { recordPayment } from "@/app/(dashboard)/billing/payment-receiving/actions";
import { createTransfer } from "@/app/(dashboard)/payments/transfers/actions";
import { addExpense } from "@/app/(dashboard)/payments/expenses/actions";
import {
  createRetailVendor,
  getRetailMarts,
  voidRetailPlacement,
} from "@/app/(dashboard)/retail/actions";

afterEach(() => resetTestRole());

describe("role guards on mutating actions", () => {
  it("a limited role (DOCTOR) is REJECTED from money actions", async () => {
    const c = await createCustomer();
    setTestRole("DOCTOR");
    await expect(recordPayment({ customerId: c.id, amount: 100, head: "CASH", date: "" })).rejects.toThrow(/permission/i);
    await expect(createTransfer({ fromHead: "CASH", toHead: "HBL", amount: 10, date: "" })).rejects.toThrow(/permission/i);
    await expect(addExpense({ date: "", amount: 10, description: "x", categoryId: "x", head: "CASH", chitReceived: false })).rejects.toThrow(/permission/i);
  });

  it("RIDER / PACKAGING / VAN_DRIVER are all rejected", async () => {
    const c = await createCustomer();
    for (const role of ["RIDER", "PACKAGING", "VAN_DRIVER", "INVENTORY", "ACCOUNTANT", "RETAIL_MANAGER"]) {
      setTestRole(role);
      await expect(recordPayment({ customerId: c.id, amount: 100, head: "CASH", date: "" })).rejects.toThrow(/permission/i);
    }
  });

  it("MANAGER (FULL_ACCESS) is allowed", async () => {
    const c = await createCustomer();
    setTestRole("MANAGER");
    const res = await recordPayment({ customerId: c.id, amount: 100, head: "CASH", date: "", notes: "mgr" });
    expect(res.ok).toBe(true);
  });
});

describe("the retail manager", () => {
  it("can run the consignment module", async () => {
    setTestRole("RETAIL_MANAGER");
    const res = await createRetailVendor({
      name: `__TEST_mart_rm_${Date.now()}`, phone: "", address: "", notes: "",
    });
    expect(res.ok).toBe(true);
    // And can read it back, not just write.
    await expect(getRetailMarts()).resolves.toBeTruthy();
  });

  it("still cannot void a drop — that stayed admin-only", async () => {
    setTestRole("RETAIL_MANAGER");
    await expect(voidRetailPlacement("does-not-matter", "x")).rejects.toThrow(/permission/i);
  });

  it("cannot touch money, customers or stock", async () => {
    const c = await createCustomer();
    setTestRole("RETAIL_MANAGER");
    await expect(recordPayment({ customerId: c.id, amount: 100, head: "CASH", date: "" })).rejects.toThrow(/permission/i);
    await expect(createTransfer({ fromHead: "CASH", toHead: "HBL", amount: 10, date: "" })).rejects.toThrow(/permission/i);
    await expect(addExpense({ date: "", amount: 10, description: "x", categoryId: "x", head: "CASH", chitReceived: false })).rejects.toThrow(/permission/i);
  });
});

describe("the roles that could already run retail still can", () => {
  it("MANAGER may create a mart", async () => {
    setTestRole("MANAGER");
    const res = await createRetailVendor({
      name: `__TEST_mart_mgr_${Date.now()}`, phone: "", address: "", notes: "",
    });
    expect(res.ok).toBe(true);
  });

  it("a limited role that never had retail is still refused", async () => {
    for (const role of ["DOCTOR", "PACKAGING", "VAN_DRIVER"]) {
      setTestRole(role);
      await expect(
        createRetailVendor({ name: `__TEST_no_${Date.now()}`, phone: "", address: "", notes: "" })
      ).rejects.toThrow(/permission/i);
      await expect(getRetailMarts()).rejects.toThrow(/permission/i);
    }
  });
});

describe("the counter's sale and purchase pages", () => {
  it("packaging works the counter's sale and purchase pages, and no other limited role does", async () => {
    const p = await createProduct({ defaultRate: 100 });
    await addStock(p.id, 10);
    const v = await createVendor();

    setTestRole("PACKAGING");
    expect((await getOtcSaleContext()).dbReady).toBe(true);
    expect((await getOtcPurchaseContext()).dbReady).toBe(true);
    expect((await getOtcSaleHistory()).dbReady).toBe(true);
    expect((await getOtcPurchaseHistory()).dbReady).toBe(true);
    const sale = await createOtcSale({
      date: "", customerType: "CASH", cashName: "Walk-in", deliveryCharge: 0, paidAmount: 100, paymentHead: "CASH",
      lines: [{ productId: p.id, unit: "LITER", rate: 100, quantity: 1 }],
    });
    expect(sale.ok).toBe(true);
    const bought = await createOtcPurchase({
      date: "", vendorId: v.id, deliveryCharge: 0, paidAmount: 0,
      lines: [{ productId: p.id, unit: "LITER", rate: 100, quantity: 1 }],
    });
    expect(bought.ok).toBe(true);
    if (sale.ok) expect((await deleteOtcSale(sale.id)).ok).toBe(true);
    if (bought.ok) expect((await deleteOtcPurchase(bought.id)).ok).toBe(true);

    // The rest of the counter and the money screens stay shut to packaging.
    await expect(getFarmSalesContext()).rejects.toThrow(/permission/i);
    await expect(createTransfer({ fromHead: "CASH", toHead: "HBL", amount: 10, date: "" })).rejects.toThrow(/permission/i);

    for (const role of ["DOCTOR", "RETAIL_MANAGER", "CHECKLIST", "VAN_DRIVER", "RIDER"]) {
      setTestRole(role);
      await expect(getOtcSaleContext(), role).rejects.toThrow(/permission/i);
      await expect(getOtcPurchaseContext(), role).rejects.toThrow(/permission/i);
    }
  }, 180_000);
});
