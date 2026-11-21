import { describe, it, expect } from "vitest";
import {
  canAccess,
  landingFor,
  DASHBOARD_ROLES,
  ASSIGNABLE_ROLES,
  ROLE_LABELS,
  USER_ADMIN_ROLES,
} from "@/lib/access";

describe("the retail manager reaches the retail end of the chain and nothing else", () => {
  it("opens Retail Marts", () => {
    expect(canAccess("RETAIL_MANAGER", "/retail")).toBe(true);
  });

  it("lands there after signing in — adding a route must not move this", () => {
    // landingFor() returns index 1 of the role's route list, so a new route has
    // to be appended, never inserted.
    expect(landingFor("RETAIL_MANAGER")).toBe("/retail");
  });

  it("gets the inventory summary and its own checklist, like every other limited role", () => {
    expect(canAccess("RETAIL_MANAGER", "/inventory")).toBe(true);
    expect(canAccess("RETAIL_MANAGER", "/checklists")).toBe(true);
  });

  it("is kept out of everything that writes elsewhere", () => {
    for (const route of [
      "/",
      "/users",
      "/payments/expenses",
      "/payments/transfers",
      "/billing/payment-receiving",
      "/customers",
      "/customers/pre-delivery",
      "/inventory/production",
      "/inventory/products",
      "/inventory/waste-entry",
      "/inventory/wastage",
      "/inventory/farm-arrival",
      "/over-the-counter/sale",
      "/over-the-counter/purchase",
      "/reports",
      "/reports/summary",
    ]) {
      expect(canAccess("RETAIL_MANAGER", route), route).toBe(false);
    }
  });

  it("receives what packaging sends across, and reviews what the riders brought back", () => {
    expect(canAccess("RETAIL_MANAGER", "/inventory/retail")).toBe(true);
    expect(canAccess("RETAIL_MANAGER", "/inventory/rider-returns")).toBe(true);
  });

  it("cannot reach a sub-route by prefix", () => {
    expect(canAccess("RETAIL_MANAGER", "/retail/anything")).toBe(false);
    // Only the one sub-route that was granted explicitly.
    expect(canAccess("RETAIL_MANAGER", "/retail/inventory")).toBe(true);
    expect(canAccess("RETAIL_MANAGER", "/retail/inventory/anything")).toBe(false);
    expect(canAccess("RETAIL_MANAGER", "/inventory/reconciliation")).toBe(false);
  });

  it("is allowed into the dashboard and can be handed out on the Users page", () => {
    expect(DASHBOARD_ROLES).toContain("RETAIL_MANAGER");
    expect(ASSIGNABLE_ROLES).toContain("RETAIL_MANAGER");
    expect(ROLE_LABELS.RETAIL_MANAGER).toBe("Retail Manager");
  });

  it("cannot administer users", () => {
    expect(USER_ADMIN_ROLES).not.toContain("RETAIL_MANAGER");
  });
});

describe("the roles that already existed are untouched", () => {
  it("admin and manager still reach everything, retail included", () => {
    for (const role of ["ADMIN", "MANAGER"]) {
      expect(canAccess(role, "/retail"), role).toBe(true);
      expect(canAccess(role, "/inventory/retail"), role).toBe(true);
      expect(canAccess(role, "/payments/expenses"), role).toBe(true);
      expect(landingFor(role)).toBe("/");
    }
  });

  it("each limited role still lands where it did", () => {
    expect(landingFor("DOCTOR")).toBe("/inventory/reconciliation");
    expect(landingFor("PACKAGING")).toBe("/inventory/farm-arrival");
    expect(landingFor("VAN_DRIVER")).toBe("/inventory/retail");
  });

  it("no other role gained the consignment module", () => {
    for (const role of ["DOCTOR", "PACKAGING", "VAN_DRIVER", "RIDER", "INVENTORY", "ACCOUNTANT"]) {
      expect(canAccess(role, "/retail"), role).toBe(false);
    }
  });

  it("packaging staff reach their inventory pages, and nothing else new", () => {
    for (const path of ["/inventory/farm-arrival", "/inventory/wastage", "/inventory/waste-entry", "/inventory/rider-returns", "/inventory/yoghurt", "/over-the-counter/sale", "/over-the-counter/purchase"]) {
      expect(canAccess("PACKAGING", path), path).toBe(true);
    }
    for (const path of ["/inventory/production", "/inventory/reconciliation", "/inventory/rider-extras", "/payments/salaries", "/over-the-counter/farm-sales", "/"]) {
      expect(canAccess("PACKAGING", path), path).toBe(false);
    }
  });

  it("riders are still shut out of the dashboard entirely", () => {
    expect(DASHBOARD_ROLES).not.toContain("RIDER");
    expect(canAccess("RIDER", "/retail")).toBe(false);
    expect(canAccess("RIDER", "/inventory")).toBe(false);
  });
});

describe("the checklist-only role reaches its checklist and nothing else", () => {
  it("opens Checklists", () => {
    expect(canAccess("CHECKLIST", "/checklists")).toBe(true);
  });

  it("lands there after signing in", () => {
    // Its route list has ONE entry, so landingFor()'s index-1 lookup falls through
    // to index 0. Adding a second route would silently make THAT the landing page.
    expect(landingFor("CHECKLIST")).toBe("/checklists");
  });

  it("does not even get the inventory summary every other limited role has", () => {
    expect(canAccess("CHECKLIST", "/inventory")).toBe(false);
  });

  it("is shut out of everything else, including the dashboard home", () => {
    for (const route of [
      "/",
      "/users",
      "/payments/expenses",
      "/payments/transfers",
      "/payments/rider-cash",
      "/billing/payment-receiving",
      "/customers",
      "/customers/pre-delivery",
      "/inventory/production",
      "/inventory/products",
      "/inventory/farm-arrival",
      "/inventory/retail",
      "/over-the-counter/sale",
      "/over-the-counter/purchase",
      "/retail",
      "/retail/inventory",
      "/reports",
      "/reports/summary",
      "/ledgers",
    ]) {
      expect(canAccess("CHECKLIST", route), route).toBe(false);
    }
  });

  it("cannot reach a sub-route by prefix", () => {
    expect(canAccess("CHECKLIST", "/checklists/anything")).toBe(false);
  });

  it("is allowed into the dashboard and can be handed out on the Users page", () => {
    expect(DASHBOARD_ROLES).toContain("CHECKLIST");
    expect(ASSIGNABLE_ROLES).toContain("CHECKLIST");
    expect(ROLE_LABELS.CHECKLIST).toBe("Checklist Only");
  });

  it("cannot administer users", () => {
    expect(USER_ADMIN_ROLES).not.toContain("CHECKLIST");
  });

  it("adding it did not move where any existing role lands", () => {
    expect(landingFor("ADMIN")).toBe("/");
    expect(landingFor("MANAGER")).toBe("/");
    expect(landingFor("DOCTOR")).toBe("/inventory/reconciliation");
    expect(landingFor("PACKAGING")).toBe("/inventory/farm-arrival");
    expect(landingFor("RETAIL_MANAGER")).toBe("/retail");
    expect(landingFor("VAN_DRIVER")).toBe("/inventory/retail");
  });
});
