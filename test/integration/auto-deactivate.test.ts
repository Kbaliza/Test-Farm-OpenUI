import { describe, it, expect } from "vitest";
import { db } from "../setup";
import { createProduct, createCustomer } from "../helpers";
import { reconcileAutoDeactivations, reactivateCustomer } from "@/app/(dashboard)/customers/actions";
import { AUTO_DEACTIVATION_REASON, AUTO_DEACTIVATE_DAYS } from "@/lib/deactivation-reasons";

const DAY = 86_400_000;

// updatedAt is @updatedAt-managed, so backdate it with raw SQL to simulate a
// customer who has sat untouched (not recently reactivated/edited).
async function backdateUpdatedAt(id: string, daysAgo: number) {
  await db.$executeRaw`UPDATE "Customer" SET "updatedAt" = ${new Date(Date.now() - daysAgo * DAY)} WHERE id = ${id}`;
}

async function statusOf(id: string) {
  const rows = await db.$queryRaw<{ status: string; deactivationReason: string | null }[]>`
    SELECT status::text AS status, "deactivationReason" FROM "Customer" WHERE id = ${id}
  `;
  return rows[0];
}

describe("auto-deactivation — 20 days without a delivery", () => {
  it("deactivates once-active customers, but leaves recent + never-delivered active", async () => {
    const p = await createProduct({ unit: "LITER" });

    // (a) Once active, last delivery well past the window → should deactivate.
    const stale = await createCustomer();
    await db.deliveryEntry.create({
      data: { customerId: stale.id, productId: p.id, quantity: 5, unitRate: 100,
        date: new Date(Date.now() - (AUTO_DEACTIVATE_DAYS + 5) * DAY) },
    });
    await backdateUpdatedAt(stale.id, AUTO_DEACTIVATE_DAYS + 5);

    // (b) Delivered recently (inside the window) → should stay active.
    const recent = await createCustomer();
    await db.deliveryEntry.create({
      data: { customerId: recent.id, productId: p.id, quantity: 5, unitRate: 100,
        date: new Date(Date.now() - 3 * DAY) },
    });

    // (c) Never delivered anything → should stay active (not "once active").
    const fresh = await createCustomer();

    // (d) Only a return in the window, no actual delivery → treated as stale.
    const returnedOnly = await createCustomer();
    await db.deliveryEntry.create({
      data: { customerId: returnedOnly.id, productId: p.id, quantity: 2, unitRate: 100, isReturn: true,
        date: new Date(Date.now() - 2 * DAY) },
    });
    await db.deliveryEntry.create({
      data: { customerId: returnedOnly.id, productId: p.id, quantity: 5, unitRate: 100,
        date: new Date(Date.now() - (AUTO_DEACTIVATE_DAYS + 10) * DAY) },
    });
    await backdateUpdatedAt(returnedOnly.id, AUTO_DEACTIVATE_DAYS + 10);

    const n = await reconcileAutoDeactivations(true);
    expect(n).toBeGreaterThanOrEqual(2); // at least our two stale customers

    const s = await statusOf(stale.id);
    expect(s.status).toBe("INACTIVE");
    expect(s.deactivationReason).toBe(AUTO_DEACTIVATION_REASON);

    expect((await statusOf(recent.id)).status).toBe("ACTIVE");
    expect((await statusOf(fresh.id)).status).toBe("ACTIVE");

    // A return doesn't count as "delivered a product": last real delivery is old.
    expect((await statusOf(returnedOnly.id)).status).toBe("INACTIVE");

    // Reactivating clears the reason and, crucially, survives the next reconcile:
    // updatedAt is bumped to now, so the 20-day clock restarts even though the
    // customer's last delivery is still old.
    const react = await reactivateCustomer(stale.id);
    expect(react.ok).toBe(true);
    let s2 = await statusOf(stale.id);
    expect(s2.status).toBe("ACTIVE");
    expect(s2.deactivationReason).toBeNull();

    await reconcileAutoDeactivations(true);
    s2 = await statusOf(stale.id);
    expect(s2.status).toBe("ACTIVE"); // not bounced straight back to Lost
  });
});
