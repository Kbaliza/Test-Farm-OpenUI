"use server";

import { requireRole, FULL_ACCESS } from "@/lib/auth";
import { db } from "@/lib/db";
import { dateStrRangePKT } from "@/lib/pkt";

export type SaleSummaryProduct = { id: string; name: string; unit: string };
export type SaleSummaryRow = {
  shiftId: string;
  shiftName: string;
  riderId: string | null;
  riderName: string | null;
  byProduct: Record<string, number>; // productId -> delivered qty
  sale: number;          // Σ delivered × rate (non-return, non-replacement)
  cash: number;          // Σ RIDER_CASH payments
  returns: number;       // Σ returned/refunded value (isReturn × rate)
  netReceivings: number; // cash − returns
};
export type RiderSaleSummary = {
  ok: boolean;
  date: string;
  products: SaleSummaryProduct[];
  rows: SaleSummaryRow[];
  totals: { byProduct: Record<string, number>; sale: number; cash: number; returns: number; netReceivings: number };
};

const EMPTY: RiderSaleSummary = {
  ok: false, date: "", products: [], rows: [],
  totals: { byProduct: {}, sale: 0, cash: 0, returns: 0, netReceivings: 0 },
};

// One shift-wise roll-up for a single date: delivered quantity per product, sale
// value, rider cash, returns and net receivings. Same primitives the Rider Report
// and billing use (DeliveryEntry value, RIDER_CASH payments, isReturn credits).
export async function getRiderSaleSummary(date: string): Promise<RiderSaleSummary> {
  await requireRole(FULL_ACCESS);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ...EMPTY, date };

  try {
    const range = dateStrRangePKT(date);
    const [products, shifts, deliveries, cashRows] = await Promise.all([
      db.product.findMany({ where: { active: true }, select: { id: true, name: true, unit: true, retailOnly: true }, orderBy: { name: "asc" } }),
      db.shift.findMany({ select: { id: true, name: true, riderId: true, rider: { select: { user: { select: { name: true } } } } }, orderBy: { name: "asc" } }),
      db.deliveryEntry.findMany({
        where: { date: range },
        select: {
          productId: true, quantity: true, unitRate: true, isReturn: true, isReplacement: true, complaintId: true,
          customer: { select: { shiftId: true } },
          rider: { select: { id: true, user: { select: { name: true } } } },
        },
      }),
      db.payment.findMany({
        where: { head: "RIDER_CASH", date: range },
        select: { amount: true, customer: { select: { shiftId: true } } },
      }),
    ]);

    type Agg = { byProduct: Record<string, number>; sale: number; cash: number; returns: number; deliverers: Map<string, string> };
    const byShift = new Map<string, Agg>();
    const ensure = (sid: string) => {
      let a = byShift.get(sid);
      if (!a) { a = { byProduct: {}, sale: 0, cash: 0, returns: 0, deliverers: new Map() }; byShift.set(sid, a); }
      return a;
    };

    for (const d of deliveries) {
      const sid = d.customer?.shiftId;
      if (!sid) continue; // a customer with no shift can't appear in a shift row
      const a = ensure(sid);
      const qty = Number(d.quantity);
      const value = qty * Number(d.unitRate);
      if (d.complaintId) continue;            // a complaint credit is office work, not the rider's
      if (d.isReplacement) continue;          // free replacement — no sale, not a delivered qty
      if (d.isReturn) { a.returns += value; continue; }
      a.byProduct[d.productId] = (a.byProduct[d.productId] ?? 0) + qty;
      a.sale += value;
      // Who actually made the delivery — the app stamps every entry with the
      // rider. The shift's usual rider is only a name on the roster: on
      // 8 October Nazar Ali ran one of Wajid Khan's rounds, and this page still
      // put the 80 L under Wajid while the returns board and the reconciliation
      // put it under Nazar.
      if (d.rider?.user?.name) a.deliverers.set(d.rider.id, d.rider.user.name);
    }
    for (const p of cashRows) {
      const sid = p.customer?.shiftId;
      if (!sid) continue;
      ensure(sid).cash += Number(p.amount);
    }

    const shiftName = new Map(shifts.map((s) => [s.id, s.name]));
    const shiftRider = new Map(shifts.map((s) => [s.id, { id: s.riderId, name: s.rider?.user.name ?? null }]));

    const rows: SaleSummaryRow[] = [...byShift.entries()]
      .map(([shiftId, a]) => {
        const usual = shiftRider.get(shiftId) ?? { id: null, name: null };
        const who = [...a.deliverers.entries()];
        // One rider delivered the whole round: name him, and say if he was covering.
        // More than one: name them all. None stamped (office entries only): the roster.
        const riderId = who.length === 1 ? who[0][0] : usual.id;
        const riderName =
          who.length === 0 ? usual.name
          : who.length === 1 ? (who[0][0] === usual.id || !usual.name ? who[0][1] : `${who[0][1]} (covering for ${usual.name})`)
          : who.map(([, n]) => n).join(" + ");
        return {
        shiftId,
        shiftName: shiftName.get(shiftId) ?? "Shift",
        riderId,
        riderName,
        byProduct: a.byProduct,
        sale: a.sale,
        cash: a.cash,
        returns: a.returns,
        netReceivings: a.cash - a.returns,
        };
      })
      .sort((x, y) => x.shiftName.localeCompare(y.shiftName));

    const totals = { byProduct: {} as Record<string, number>, sale: 0, cash: 0, returns: 0, netReceivings: 0 };
    for (const r of rows) {
      for (const [pid, q] of Object.entries(r.byProduct)) totals.byProduct[pid] = (totals.byProduct[pid] ?? 0) + q;
      totals.sale += r.sale; totals.cash += r.cash; totals.returns += r.returns; totals.netReceivings += r.netReceivings;
    }

    return { ok: true, date, products, rows, totals };
  } catch {
    return { ...EMPTY, date };
  }
}
