import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { db } from "@/lib/db";
import { bottleCustomers, bottleDay } from "@/lib/bottles";
import { dateStrRangePKT, toDateStrPKT, todayPKTString } from "@/lib/pkt";

// Glass bottles, for the MOBILE app.
//
//   GET  /api/rider/bottles?shiftId=<id>[&date=YYYY-MM-DD]
//        -> whether the shift uses bottles, and for each customer on it: how many
//           bottles they hold going into that day, and what has been recorded as
//           returned on that day so far.
//   POST /api/rider/bottles  { shiftId, customerId, returned, date?, routeId? }
//        -> record the empties taken back from that customer on that day (one
//           figure per customer per day; sending again replaces it). Returns the
//           customer's new count.
//
// Auth: the rider's Supabase access token in `Authorization: Bearer <token>`, as
// on /api/rider/billing, and the shift must be this rider's — or a shift whose
// route that day this rider confirmed loading, since riders cover each other.
//
// Bottles given are what the app records on each delivery row (DeliveryEntry
// .bottles; NULL or 0 = packets), never the litres. "Holds" is worked out from
// those rows (src/lib/bottles.ts), so the figure the rider sees at the door is
// the same one the office sees on the Bottles page.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Auth = { riderId: string } | { error: string; status: number };

async function authRider(request: Request): Promise<Auth> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!token) return { error: "Missing bearer token.", status: 401 };
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) return { error: "Invalid or expired token.", status: 401 };
  const user = await db.user.findUnique({ where: { supabaseId: data.user.id }, select: { role: true, active: true, rider: { select: { id: true } } } });
  if (!user || !user.active) return { error: "No active account.", status: 401 };
  if (user.role !== "RIDER" || !user.rider) return { error: "Not a rider account.", status: 403 };
  return { riderId: user.rider.id };
}

/** The shift is the rider's own, or he confirmed loading its round that day. */
async function mayWork(riderId: string, shiftId: string, date: string): Promise<{ ok: true; usesBottles: boolean; since: string | null } | { ok: false; error: string; status: number }> {
  const shift = await db.shift.findUnique({ where: { id: shiftId }, select: { riderId: true, bottlesSince: true } });
  if (!shift) return { ok: false, error: "No such shift.", status: 404 };
  if (shift.riderId !== riderId) {
    const covered = await db.inventoryMovement.count({
      where: { type: "HANDED_OVER", riderId, reference: { in: (await db.route.findMany({ where: { shiftId, date: dateStrRangePKT(date) }, select: { id: true } })).map((r) => r.id) } },
    });
    if (!covered) return { ok: false, error: "That shift belongs to another rider.", status: 403 };
  }
  return { ok: true, usesBottles: !!shift.bottlesSince, since: shift.bottlesSince ? toDateStrPKT(shift.bottlesSince) : null };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request) {
  try {
    const auth = await authRider(request);
    if ("error" in auth) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
    const url = new URL(request.url);
    const shiftId = url.searchParams.get("shiftId")?.trim() ?? "";
    const date = url.searchParams.get("date")?.trim() || todayPKTString();
    if (!shiftId) return NextResponse.json({ ok: false, error: "shiftId is required." }, { status: 400 });
    if (!DAY.test(date)) return NextResponse.json({ ok: false, error: "date must be YYYY-MM-DD." }, { status: 400 });

    const access = await mayWork(auth.riderId, shiftId, date);
    if (!access.ok) return NextResponse.json({ ok: false, error: access.error }, { status: access.status });
    if (!access.usesBottles) return NextResponse.json({ ok: true, usesBottles: false, since: null, date, customers: [] });

    // Held going INTO the day: everything up to the day before. Today's own
    // delivery and return are shown beside it, so the app can say "holds 5,
    // taking 3 today, give back 5".
    const [all, today, todayReturns] = await Promise.all([
      bottleCustomers(date, date),
      db.deliveryEntry.groupBy({
        by: ["customerId", "isReturn"],
        where: { date: dateStrRangePKT(date), isReplacement: false, complaintId: null, bottles: { gt: 0 }, customer: { shiftId } },
        _sum: { bottles: true },
      }),
      db.bottleReturn.findMany({ where: { date: bottleDay(date), customer: { shiftId } }, select: { customerId: true, returned: true } }),
    ]);
    const held = new Map(all.filter((c) => c.shiftId === shiftId).map((c) => [c.customerId, c]));
    // Bottles out today, and bottles that came back full on a milk return today.
    const deliveredToday = new Map(today.filter((t) => !t.isReturn).map((t) => [t.customerId, t._sum.bottles ?? 0]));
    const fullBackToday = new Map(today.filter((t) => t.isReturn).map((t) => [t.customerId, t._sum.bottles ?? 0]));
    const returnedToday = new Map(todayReturns.map((r) => [r.customerId, r.returned]));

    const customers = [...held.values()].map((c) => {
      const given = deliveredToday.get(c.customerId) ?? 0;
      const back = returnedToday.get(c.customerId) ?? 0;
      const fullBack = fullBackToday.get(c.customerId) ?? 0;
      return {
        customerId: c.customerId,
        customerCode: c.customerCode,
        name: c.name,
        /** Bottles held before today's visit — what to ask for at the door. */
        heldBefore: c.held - given + back + fullBack,
        /** Bottles given today (DeliveryEntry.bottles), as recorded so far. */
        givenToday: given,
        /** Empties recorded as returned today, or null if nothing recorded yet. */
        returnedToday: returnedToday.has(c.customerId) ? back : null,
        /** What they hold after today, as things stand. */
        heldNow: c.held,
      };
    });
    return NextResponse.json({ ok: true, usesBottles: true, since: access.since, date, customers });
  } catch (e) {
    console.error("[api/rider/bottles GET]", e);
    return NextResponse.json({ ok: false, error: "Server error." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const auth = await authRider(request);
    if ("error" in auth) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
    const body = (await request.json().catch(() => null)) as { shiftId?: string; customerId?: string; returned?: unknown; date?: string; routeId?: string } | null;
    const shiftId = body?.shiftId?.trim() ?? "";
    const customerId = body?.customerId?.trim() ?? "";
    const date = body?.date?.trim() || todayPKTString();
    const returned = Math.round(Number(body?.returned));
    if (!shiftId || !customerId) return NextResponse.json({ ok: false, error: "shiftId and customerId are required." }, { status: 400 });
    if (!DAY.test(date) || date > todayPKTString()) return NextResponse.json({ ok: false, error: "date must be today or earlier." }, { status: 400 });
    if (!Number.isFinite(returned) || returned < 0 || returned > 500) return NextResponse.json({ ok: false, error: "returned must be a whole number from 0 to 500." }, { status: 400 });

    const access = await mayWork(auth.riderId, shiftId, date);
    if (!access.ok) return NextResponse.json({ ok: false, error: access.error }, { status: access.status });
    if (!access.usesBottles) return NextResponse.json({ ok: false, error: "This shift is not on bottles." }, { status: 409 });
    const customer = await db.customer.findUnique({ where: { id: customerId }, select: { shiftId: true } });
    if (!customer || customer.shiftId !== shiftId) return NextResponse.json({ ok: false, error: "That customer is not on this shift." }, { status: 404 });

    const day = bottleDay(date);
    if (returned === 0) {
      await db.bottleReturn.deleteMany({ where: { customerId, date: day } });
    } else {
      await db.bottleReturn.upsert({
        where: { customerId_date: { customerId, date: day } },
        create: { customerId, date: day, returned, source: "rider", riderId: auth.riderId, routeId: body?.routeId?.trim() || null },
        update: { returned, source: "rider", riderId: auth.riderId, routeId: body?.routeId?.trim() || null, enteredById: null, enteredByName: null },
      });
    }
    const after = (await bottleCustomers(date, date)).find((c) => c.customerId === customerId);
    return NextResponse.json({ ok: true, customerId, date, returned, heldNow: after?.held ?? 0 });
  } catch (e) {
    console.error("[api/rider/bottles POST]", e);
    return NextResponse.json({ ok: false, error: "Server error." }, { status: 500 });
  }
}
