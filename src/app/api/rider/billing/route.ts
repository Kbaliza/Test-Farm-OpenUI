import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { db } from "@/lib/db";
import { computeCustomerOutstanding } from "@/lib/customer-balance";
import {
  billedIn, billedPieces, currentHalf, halfBounds, halfLabel, previousHalf,
  type Charged, type MonthPieces,
} from "@/lib/billing-period";

// Billing figures for one shift, for the MOBILE app.
//
//   GET /api/rider/billing?shiftId=<id>
//
// Auth: the rider's Supabase access token in `Authorization: Bearer <token>`, the same
// as /api/rider/checklists, and the shift must belong to that rider. proxy.ts excludes
// /api/, so this handler does its own auth.
//
// Every figure is DERIVED, never read from a saved Invoice row. That is the whole point
// of the endpoint: a saved bill is a snapshot from the moment it was generated, and it
// only refreshes when somebody opens that customer's bill on the web. Jamshed Khan's
// 16-30 September bill sat at Rs 4,799 from the 16th until it was opened on 2 October,
// when it became Rs 5,399 — and riders were reading the stale figure all morning. Here
// the numbers are worked out when they are asked for, so they cannot go stale.
//
// It is the same arithmetic the web uses: src/lib/billing-period.ts for what a half
// billed, and computeCustomerOutstanding for what is still owed. One rule, three
// callers.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Auth = { riderId: string } | { error: string; status: number };

async function authRider(request: Request): Promise<Auth> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!token) return { error: "Missing bearer token.", status: 401 };

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) return { error: "Invalid or expired token.", status: 401 };

  const user = await db.user.findUnique({
    where: { supabaseId: data.user.id },
    select: { id: true, role: true, active: true, rider: { select: { id: true } } },
  });
  if (!user || !user.active) return { error: "No active account.", status: 401 };
  if (user.role !== "RIDER") return { error: "Not a rider account.", status: 403 };
  if (!user.rider) return { error: "No rider record for this account.", status: 403 };
  return { riderId: user.rider.id };
}

/** PAID once nothing is owed; PARTIAL when something was paid but not all of it. */
function statusOf(outstanding: number, paid: number): "PAID" | "PARTIAL" | "PENDING" {
  if (outstanding <= 0.005) return "PAID";
  return paid > 0.005 ? "PARTIAL" : "PENDING";
}

/** One half's figures for one customer. */
function figuresFor(
  pieces: MonthPieces,
  half: number,
  c: Charged,
  paid: number,
  outstanding: number,
  paidLater = 0,
) {
  const billed = billedIn(pieces, c, half === 1 ? 0 : 1);
  return {
    billed: round2(billed),
    paid: round2(paid),
    /** Paid after this half closed, towards what was owed then (previous half only). */
    paidLater: round2(paidLater),
    outstanding: round2(outstanding),
    status: statusOf(outstanding, paid + paidLater),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function GET(request: Request) {
  try {
    const auth = await authRider(request);
    if ("error" in auth) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });

    const shiftId = new URL(request.url).searchParams.get("shiftId")?.trim() ?? "";
    if (!shiftId) return NextResponse.json({ ok: false, error: "shiftId is required." }, { status: 400 });

    // The shift has to be this rider's. Otherwise one rider's token would read any
    // other rider's customers and their balances.
    const shift = await db.shift.findUnique({ where: { id: shiftId }, select: { id: true, riderId: true } });
    if (!shift) return NextResponse.json({ ok: false, error: "No such shift." }, { status: 404 });
    if (shift.riderId !== auth.riderId) {
      return NextResponse.json({ ok: false, error: "That shift belongs to another rider." }, { status: 403 });
    }

    const customers = await db.customer.findMany({
      where: { shiftId, status: { not: "DISABLED" } },
      select: {
        id: true, customerCode: true, name: true,
        deliveryCharge: true, area: { select: { defaultDeliveryCharge: true } },
      },
      orderBy: { name: "asc" },
    });
    const ids = customers.map((c) => c.id);

    const cur = currentHalf();
    const prev = previousHalf(cur.year, cur.month, cur.half);
    const curEnd = halfBounds(cur.year, cur.month, cur.half).end;
    const prevEnd = halfBounds(prev.year, prev.month, prev.half).end;

    const [curPieces, prevPieces, curOut, prevOut, payments] = await Promise.all([
      billedPieces(cur.year, cur.month, ids),
      // The same month when the previous half is the first of this one, so this is
      // deliberately not merged with the call above.
      billedPieces(prev.year, prev.month, ids),
      computeCustomerOutstanding(ids, { year: cur.year, month: cur.month, asOfDate: curEnd }),
      computeCustomerOutstanding(ids, { year: prev.year, month: prev.month, asOfDate: prevEnd }),
      ids.length
        ? db.payment.findMany({
            where: { customerId: { in: ids }, date: { gte: halfBounds(prev.year, prev.month, prev.half).start, lte: curEnd } },
            select: { customerId: true, amount: true, date: true },
          })
        : Promise.resolve([] as { customerId: string | null; amount: unknown; date: Date }[]),
    ]);

    // Payments split by which half they landed in. Payment carries no link to a bill,
    // so the date is what decides it — the same thing the web does.
    const curStart = halfBounds(cur.year, cur.month, cur.half).start;
    const paidCur = new Map<string, number>();
    const paidPrev = new Map<string, number>();
    for (const p of payments) {
      if (!p.customerId) continue; // rider-cash against a sample belongs to no bill
      const amt = Number(p.amount);
      const bucket = p.date >= curStart ? paidCur : paidPrev;
      bucket.set(p.customerId, (bucket.get(p.customerId) ?? 0) + amt);
    }

    // The previous half, as it stands TODAY. Its bill is made on its last day and
    // paid in the first days of this one, so a payment now clears it first: owed
    // when it closed, less what has been paid since, never below nothing. A credit
    // stands only as far as the customer is still in credit. (Fatima Askari 14 owed
    // 14,229 on 30 Sep, paid 14,230 on 1 Oct, and still read as pending here.)
    const previousNow = (id: string) => {
      const owed = prevOut.get(id) ?? 0;
      const since = paidCur.get(id) ?? 0;
      if (owed > 0.005) return { outstanding: Math.max(0, owed - since), paidLater: Math.min(owed, since) };
      if (owed < -0.005) return { outstanding: Math.min(0, Math.max(owed, curOut.get(id) ?? 0)), paidLater: 0 };
      return { outstanding: 0, paidLater: 0 };
    };

    const rows = customers.map((c) => {
      const charged: Charged = { id: c.id, deliveryCharge: c.deliveryCharge, area: c.area };
      const before = previousNow(c.id);
      return {
        customerId: c.id,
        customerCode: c.customerCode,
        name: c.name,
        current: figuresFor(curPieces, cur.half, charged, paidCur.get(c.id) ?? 0, curOut.get(c.id) ?? 0),
        previous: figuresFor(prevPieces, prev.half, charged, paidPrev.get(c.id) ?? 0, before.outstanding, before.paidLater),
      };
    });

    const total = (pick: (r: (typeof rows)[number]) => { billed: number; paid: number; outstanding: number }) => ({
      billed: round2(rows.reduce((s, r) => s + pick(r).billed, 0)),
      collected: round2(rows.reduce((s, r) => s + pick(r).paid, 0)),
      outstanding: round2(rows.reduce((s, r) => s + pick(r).outstanding, 0)),
    });

    return NextResponse.json({
      ok: true,
      shiftId,
      current: { label: halfLabel(cur.year, cur.month, cur.half), ...total((r) => r.current) },
      previous: { label: halfLabel(prev.year, prev.month, prev.half), ...total((r) => r.previous) },
      customers: rows,
    });
  } catch (e) {
    console.error("[api/rider/billing]", e);
    return NextResponse.json({ ok: false, error: "Could not read the billing figures." }, { status: 500 });
  }
}
