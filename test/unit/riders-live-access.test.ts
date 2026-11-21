import { describe, it, expect } from "vitest";
import { canAccess } from "@/lib/access";

// Where every rider is right now is for the office only.
describe("/customers/riders-live access", () => {
  it("lets admins and managers in and nobody else", () => {
    expect(canAccess("ADMIN", "/customers/riders-live")).toBe(true);
    expect(canAccess("MANAGER", "/customers/riders-live")).toBe(true);
    for (const role of ["RIDER", "RETAIL_MANAGER", "PACKAGING", "DOCTOR", "ACCOUNTANT", "nobody"]) {
      expect(canAccess(role, "/customers/riders-live")).toBe(false);
    }
  });
});
