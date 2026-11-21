import "server-only";
import { db } from "@/lib/db";
import { HEAD_LABELS } from "@/lib/head-balances";
import {
  FARM_SALE_WALKIN, categoryLabel, describeDetails,
} from "@/lib/farm-sale-catalog";
import type { LedgerResult, LedgerRow } from "./actions";

// What one buyer has bought from the farm that is not milk.
//
// There is no running BALANCE here, and that is deliberate rather than an omission:
// every farm sale is paid in full, so a debit/credit statement would net to zero on
// every line and tell you nothing. The running column is a cumulative total of
// business done with this buyer instead — "they have taken Rs 486,500 off us so
// far" — which is the question this page actually answers.

function rs(n: number) {
  const v = Math.round(n);
  return (v < 0 ? "−Rs " : "Rs ") + Math.abs(v).toLocaleString("en-PK");
}

function ini(name: string) {
  return name.split(" ").map((w) => w[0] ?? "").join("").slice(0, 2).toUpperCase();
}

function fmtDay(d: Date) {
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

export async function farmSaleLedger(
  entityId: string,
  dr?: { gte?: Date; lte?: Date }
): Promise<LedgerResult> {
  const isWalkIn = entityId === FARM_SALE_WALKIN;

  // A walk-in is not a party, so it has no row to look up — every CASH sale is
  // gathered under the one sentinel rather than being unreachable.
  const who = isWalkIn ? { vendorId: null, buyerType: "CASH" } : { vendorId: entityId };

  const [vendor, sales] = await Promise.all([
    isWalkIn ? Promise.resolve(null) : db.vendor.findUnique({ where: { id: entityId } }),
    db.farmSale.findMany({
      where: { ...who, ...(dr ? { date: dr } : {}) },
      include: { lines: true },
      orderBy: { date: "asc" },
    }),
  ]);
  if (!isWalkIn && !vendor) return { ok: false, error: "Buyer not found." };

  // Everything before the window, so a filtered view still shows the true total
  // taken to date rather than restarting from zero.
  let opening = 0;
  if (dr?.gte) {
    const before = await db.farmSale.aggregate({
      _sum: { totalAmount: true },
      where: { ...who, date: { lt: dr.gte } },
    });
    opening = Number(before._sum.totalAmount ?? 0);
  }

  let running = opening;
  const rows: LedgerRow[] = [];
  if (dr?.gte && Math.abs(opening) > 0.005) {
    rows.push({
      id: "opening", date: dr.gte.toISOString(),
      description: "Opening — bought before this period",
      debit: 0, credit: 0, balance: opening, reference: "—",
    });
  }

  for (const s of sales) {
    // One row per LINE, because "what did they buy" is the point of this statement —
    // but the running total advances only once per sale, on its last line, so the
    // closing figure is the sum of sale totals and not of lines plus transport.
    s.lines.forEach((l, i) => {
      const last = i === s.lines.length - 1;
      const amount = Number(l.amount);
      if (last) running += Number(s.totalAmount);
      const details = describeDetails(l.category, l.details as Record<string, string> | null);
      rows.push({
        id: l.id,
        date: s.date.toISOString(),
        description: l.item + (l.animalTag ? ` · tag ${l.animalTag}` : ""),
        debit: amount,
        credit: 0,
        balance: running,
        qty: `${Number(l.quantity)} ${l.unit}`,
        rate: rs(Number(l.rate)),
        reference: `${s.invoiceNo} · ${categoryLabel(l.category)}`,
        note: [details, s.gatePassNo ? `Gate pass ${s.gatePassNo}` : "", s.narration ?? ""]
          .filter(Boolean).join(" · ") || undefined,
        head: HEAD_LABELS[s.paymentHead] ?? s.paymentHead,
      });
    });

    if (Number(s.transportCharge) > 0.005) {
      rows.push({
        id: s.id + "-transport",
        date: s.date.toISOString(),
        description: "Transport charge",
        debit: Number(s.transportCharge),
        credit: 0,
        balance: running,
        reference: s.invoiceNo,
        head: HEAD_LABELS[s.paymentHead] ?? s.paymentHead,
      });
    }
  }

  // Live and all-time, like every other ledger's cards, so they match the Farm
  // Sales page rather than the date filter above them.
  const allTime = await db.farmSale.aggregate({
    _sum: { totalAmount: true },
    _max: { totalAmount: true, date: true },
    _count: true,
    where: who,
  });

  const name = isWalkIn ? "Cash walk-ins" : vendor!.name;
  const totalEver = Number(allTime._sum.totalAmount ?? 0);
  const inWindow = sales.reduce((a, s) => a + Number(s.totalAmount), 0);
  const lastDate = allTime._max.date;

  return {
    ok: true,
    data: {
      type: "farmsale",
      entityInfo: {
        name,
        initials: isWalkIn ? "WI" : ini(name),
        avatarBg: "#EDE4FB",
        avatarTc: "#6B21A8",
        meta: isWalkIn
          ? "Every counter sale with no account · farm goods"
          : `${vendor!.phone ?? "No contact"} · buys farm goods`,
        badges: [
          { label: `Bought: ${rs(totalEver)}`, cls: "purple" },
          { label: `${allTime._count} sale${allTime._count === 1 ? "" : "s"}`, cls: "gray" },
          { label: "Always paid in full", cls: "green" },
        ],
      },
      summary: [
        { label: "Total bought", value: rs(totalEver), sub: "all time (live)", color: "#6B21A8" },
        { label: "In this period", value: rs(inWindow), sub: `${sales.length} sales`, color: "#185FA5" },
        { label: "Largest sale", value: rs(Number(allTime._max.totalAmount ?? 0)), sub: "all time", color: "#3B6D11" },
        { label: "Last purchase", value: lastDate ? fmtDay(lastDate) : "—", sub: "most recent", color: "#854F0B" },
      ],
      rows,
    },
  };
}
