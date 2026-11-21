import { describe, it, expect } from "vitest";
import { db } from "../setup";
import { onHand } from "../helpers";
import { getMilkInStorage } from "@/app/(dashboard)/inventory/yoghurt/actions";

// The Yogurt form shows what is in storage for each milk. It used to work that out
// on its own — arrivals minus yoghurt use minus EVERY route ever planned — which
// went below zero and showed 0 L while the farm held thousands of litres. It must
// read the same stock figure as the rest of the app.
const milkProduct = (term: string) =>
  db.product.findFirst({ where: { active: true, retailOnly: false, name: { contains: term, mode: "insensitive" } } });

describe("the Yogurt page reads real inventory", () => {
  it("shows each milk's actual stock, the same number every other screen shows", async () => {
    const stock = await getMilkInStorage();
    expect(stock.fetchError).toBeUndefined();

    for (const [term, shown] of [["Buffalo", stock.buffalo], ["Cow", stock.cow], ["Mix", stock.mix]] as const) {
      const p = await milkProduct(term);
      if (!p) continue; // no such product on this database
      expect(shown, p.name).toBeCloseTo(await onHand(p.id), 3);
    }
  }, 120_000);

  it("stock delivered long ago does not count against it", async () => {
    // The old sum subtracted all-time planned route quantities, so any farm with a
    // delivery history read 0. A farm with milk in storage must not.
    const cow = await milkProduct("Cow");
    if (!cow) return;
    const real = await onHand(cow.id);
    if (real <= 0) return; // nothing in storage today — nothing to assert
    expect((await getMilkInStorage()).cow).toBeGreaterThan(0);
  }, 120_000);
});
