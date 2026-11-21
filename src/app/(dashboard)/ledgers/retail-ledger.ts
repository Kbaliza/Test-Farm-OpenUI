import "server-only";
import { db } from "@/lib/db";
import { HEAD_LABELS } from "@/lib/head-balances";
import { martBalance, openQty, round2 } from "@/lib/retail-math";
import type { LedgerResult, LedgerRow } from "./actions";

// A consignment shop's statement.
//
// The running balance is what THEY owe US, so a sale they reported is a debit and
// a payment is a credit. A drop itself moves no money — the product is still ours
// until they say it sold — so it shows as a zero-value row for context, the same
// way the vendor ledger shows over-the-counter sales.

function rs(n: number) {
  const v = Math.round(n);
  return (v < 0 ? "−Rs " : "Rs ") + Math.abs(v).toLocaleString("en-PK");
}

function ini(name: string) {
  return name.split(" ").map((w) => w[0] ?? "").join("").slice(0, 2).toUpperCase();
}

export async function retailMartLedger(
  martId: string,
  dr?: { gte?: Date; lte?: Date }
): Promise<LedgerResult> {
  const [mart, placements, resolutions, payments, otcSales, receivables] = await Promise.all([
    db.retailVendor.findUnique({ where: { id: martId } }),
    db.retailPlacement.findMany({
      where: { retailVendorId: martId, ...(dr ? { date: dr } : {}) },
      include: { lines: { include: { product: { select: { name: true } } } } },
      orderBy: { date: "asc" },
    }),
    db.retailResolution.findMany({
      where: { retailVendorId: martId, ...(dr ? { date: dr } : {}) },
      include: {
        lines: { include: { placementLine: { select: { product: { select: { name: true } } } } } },
        placement: { select: { placementNo: true } },
      },
      orderBy: { date: "asc" },
    }),
    db.retailPayment.findMany({
      where: { retailVendorId: martId, ...(dr ? { date: dr } : {}) },
      orderBy: { date: "asc" },
    }),
    db.otcSale.findMany({
      where: { retailVendorId: martId, ...(dr ? { date: dr } : {}) },
      select: {
        id: true, date: true, invoiceNo: true, totalAmount: true, paidAmount: true,
        lines: { select: { quantity: true, unit: true, product: { select: { name: true } } } },
      },
      orderBy: { date: "asc" },
    }),
    // LIVE, all-time — the balance card must match the Retail page whatever the
    // row list is filtered to, exactly as the vendor ledger does.
    db.retailReceivable.findMany({ where: { retailVendorId: martId }, select: { amount: true, received: true } }),
  ]);

  if (!mart) return { ok: false, error: "Shop not found." };

  type Entry = Omit<LedgerRow, "balance"> & { _d: Date };
  const entries: Entry[] = [];

  for (const p of placements) {
    entries.push({
      _d: p.date,
      id: `drop:${p.id}`,
      date: p.date.toISOString(),
      description: p.voidedAt ? `Drop voided — ${p.placementNo}` : `Product left at shop — ${p.placementNo}`,
      debit: 0,
      credit: 0,
      reference: p.placementNo,
      products: p.lines.map((l) => `${Number(l.quantity)} ${l.unit} ${l.product.name}`).join(", "),
      note: p.voidedAt ? (p.voidReason ?? "Voided") : "Still ours until they report it sold",
    });
  }

  for (const r of resolutions) {
    const sold = r.lines
      .filter((l) => Number(l.soldQty) > 0)
      .map((l) => `${Number(l.soldQty)} ${l.placementLine.product.name}`)
      .join(", ");
    const wasted = r.lines
      .filter((l) => Number(l.wastedQty) > 0)
      .map((l) => `${Number(l.wastedQty)} ${l.placementLine.product.name}`)
      .join(", ");
    entries.push({
      _d: r.date,
      id: `res:${r.id}`,
      date: r.date.toISOString(),
      description: `Reported sold — ${r.placement.placementNo}`,
      debit: Number(r.soldAmount),
      credit: 0,
      reference: r.resolutionNo,
      products: sold || undefined,
      note: wasted ? `Expired: ${wasted} (our loss ${rs(Number(r.wastedValue))})` : undefined,
    });
  }

  for (const p of payments) {
    entries.push({
      _d: p.date,
      id: `pay:${p.id}`,
      date: p.date.toISOString(),
      description: "Payment received",
      debit: 0,
      credit: Number(p.amount),
      reference: HEAD_LABELS[p.head] ?? p.head,
      head: p.head,
    });
  }

  for (const s of otcSales) {
    entries.push({
      _d: s.date,
      id: `otc:${s.id}`,
      date: s.date.toISOString(),
      description: `Counter sale — ${s.invoiceNo}`,
      debit: Number(s.totalAmount),
      credit: Number(s.paidAmount),
      reference: s.invoiceNo,
      products: s.lines.map((l) => `${Number(l.quantity)} ${l.unit} ${l.product.name}`).join(", "),
      mode: Number(s.paidAmount) >= Number(s.totalAmount) - 0.005 ? "cash" : "credit",
    });
  }

  entries.sort((a, b) => a._d.getTime() - b._d.getTime());

  // Opening balance when the view is date-filtered, so the running column starts
  // from reality rather than zero.
  let opening = 0;
  if (dr?.gte) {
    const [priorRes, priorPay, priorOtc] = await Promise.all([
      db.retailResolution.aggregate({
        where: { retailVendorId: martId, date: { lt: dr.gte } },
        _sum: { soldAmount: true },
      }),
      db.retailPayment.aggregate({
        where: { retailVendorId: martId, date: { lt: dr.gte } },
        _sum: { amount: true },
      }),
      db.otcSale.aggregate({
        where: { retailVendorId: martId, date: { lt: dr.gte } },
        _sum: { totalAmount: true, paidAmount: true },
      }),
      ]);
    opening = round2(
      Number(priorRes._sum.soldAmount ?? 0) -
        Number(priorPay._sum.amount ?? 0) +
        Number(priorOtc._sum.totalAmount ?? 0) -
        Number(priorOtc._sum.paidAmount ?? 0)
    );
  }

  let bal = opening;
  const rows: LedgerRow[] = [];
  if (dr?.gte && Math.abs(opening) > 0.005) {
    rows.push({
      id: "opening",
      date: dr.gte.toISOString(),
      description: "Opening balance (they owe)",
      debit: 0,
      credit: 0,
      balance: opening,
      reference: "—",
    });
  }
  for (const { _d, ...r } of entries) {
    bal = round2(bal + r.debit - r.credit);
    rows.push({ ...r, balance: bal });
  }

  const owed = martBalance(receivables.map((r) => ({ amount: Number(r.amount), received: Number(r.received) })));
  const soldInWindow = resolutions.reduce((s, r) => s + Number(r.soldAmount), 0);
  const wastedInWindow = resolutions.reduce((s, r) => s + Number(r.wastedValue), 0);
  const collectedInWindow = payments.reduce((s, p) => s + Number(p.amount), 0);

  // What is still physically on their shelf — all-time, like the balance card.
  const openRows = await db.retailPlacement.findMany({
    where: { retailVendorId: martId, voidedAt: null },
    select: { lines: { select: { quantity: true, soldQty: true, wastedQty: true, rate: true } } },
  });
  const stockOut = round2(
    openRows.reduce(
      (s, p) =>
        s +
        p.lines.reduce(
          (t, l) =>
            t +
            openQty({
              quantity: Number(l.quantity),
              soldQty: Number(l.soldQty),
              wastedQty: Number(l.wastedQty),
            }) *
              Number(l.rate),
          0
        ),
      0
    )
  );

  return {
    ok: true,
    data: {
      type: "retail",
      entityInfo: {
        name: mart.name,
        initials: ini(mart.name),
        avatarBg: "#DDEBFB",
        avatarTc: "#185FA5",
        meta: `${[mart.areaName, mart.city].filter(Boolean).join(", ") || "No area"} · Retail mart`,
        badges: [
          { label: `They owe: ${rs(owed)}`, cls: "red" },
          { label: `Stock out: ${rs(stockOut)}`, cls: "blue" },
          { label: mart.phone ?? "—", cls: "gray" },
        ],
      },
      summary: [
        { label: "Balance owed", value: rs(owed), sub: "unpaid sales (live)", color: "#A32D2D" },
        { label: "Stock at shop", value: rs(stockOut), sub: "not yet reported (live)", color: "#8A5A00" },
        { label: "Reported sold", value: rs(soldInWindow), sub: "in this period", color: "#185FA5" },
        { label: "Collected", value: rs(collectedInWindow), sub: "in this period", color: "#3B6D11" },
        { label: "Expired", value: rs(wastedInWindow), sub: "our loss, this period", color: "#A32D2D" },
      ],
      rows,
    },
  };
}
