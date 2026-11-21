"use server";

import { requireRole, FULL_ACCESS } from "@/lib/auth";

import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import {
  getHeadBalances, getCashWithRiders, checkHeadFunds, guardHeadFundsTx,
  HEAD_LABELS, RIDER_CASH_RECEIPT_NOTE, type HeadBalance,
} from "@/lib/head-balances";
import { todayRangePKT, dateRangeFromToPKT } from "@/lib/pkt";

// Rider-cash is stored as a normal customer Payment with head=RIDER_CASH, written
// the moment the rider takes the money — so the customer's bill drops straight away.
//
// Rider Cash is a CASHBOX, though, not a record of what riders are carrying. The
// money does not enter the head until the rider hands it over and a manager confirms
// receipt (Payment.receivedAt); until then it is "cash with riders" and sits in no
// head at all. That rule lives in HEAD_PAYMENT_WHERE in lib/head-balances.
//
// Confirming therefore just stamps receivedAt: no HeadTransfer, and the money stays
// in the Rider Cash box until somebody actually deposits it to Cash on the Transfers
// screen. (It used to sweep RIDER_CASH -> CASH automatically, which is why some
// historic rows have a paired transfer — see undoRiderCashReceived.)

export type RiderCashStatus = "pending" | "awaiting" | "received";

export type RiderCashRow = {
  id: string;
  riderId: string | null;
  riderName: string;
  customer: string;
  customerCode: string;
  area: string;
  amount: number;
  collectedAt: string;             // ISO (payment.date)
  handedOverAt: string | null;
  handedToName: string | null;
  receivedAt: string | null;
  receivedByName: string | null;   // staff account that confirmed receipt
  status: RiderCashStatus;
};

export type RiderTile = { riderId: string | null; riderName: string; pending: number };

export type RiderCashData = {
  rows: RiderCashRow[];
  riders: { id: string; name: string }[];
  tiles: RiderTile[];
  // withRiders: collected but not yet handed over — NOT in any head.
  // riderCashBox: the RIDER_CASH head itself, i.e. handed over and confirmed.
  //
  // Every figure in here is LIVE and global — never scoped to the date range. They
  // answer "where does the money stand right now", which a date filter must not
  // change: filtering to last week and reading "with riders 0" would say the
  // opposite of the truth. Only `rows` follows the range.
  summary: { withRiders: number; pendingCount: number; collectedToday: number; receivedToday: number; riderCashBox: number };
  headBalances: HeadBalance[];
  /** The range actually applied, echoed back so the page can show what it is showing. */
  range: { from: string; to: string } | null;
  dbReady: boolean;
};

export type RiderCashResult = { ok: true } | { ok: false; error: string };

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A sample payment left behind by a deleted lead: the link is gone, but the note
 * it was written with still names the person. Without this the row shows "—" and
 * nobody can tell what the money was for.
 */
function strandedSampleName(notes: string | null): string | null {
  const m = notes?.match(/^Sample delivery · (.+?)(?: · paid by .+)?$/);
  return m?.[1]?.trim() || null;
}

/**
 * Works out the date window to show, tolerantly.
 *
 * One date on its own means that single day, so picking just a "From" behaves like
 * the old single-date picker did. Reversed dates are swapped rather than returning
 * a confusing empty table, and anything that is not a real "YYYY-MM-DD" is ignored
 * instead of throwing — these values arrive from the URL and cannot be trusted.
 */
function resolveRange(range?: { from?: string; to?: string }): { from: string; to: string } | null {
  const f = range?.from && DAY_RE.test(range.from) ? range.from : "";
  const t = range?.to && DAY_RE.test(range.to) ? range.to : "";
  if (!f && !t) return null;
  const from = f || t;
  const to = t || f;
  return from <= to ? { from, to } : { from: to, to: from };
}

// One shape for every payment read here, so the table rows and the live per-rider
// tiles cannot drift into describing the same payment differently.
const ROW_SELECT = {
  id: true, amount: true, date: true,
  handedOverAt: true, handedToName: true, receivedAt: true, receivedByName: true,
  notes: true,
  // The rider stamped on the payment = who actually collected it.
  rider: { select: { id: true, user: { select: { name: true } } } },
  customer: {
    select: {
      name: true, customerCode: true,
      area: { select: { name: true } },
      // Fallback for legacy rows: whoever runs the customer's shift TODAY.
      // Deliberately NOT customer.rider — that field goes stale when a shift
      // changes hands and credits the cash to the wrong rider.
      shift: { select: { rider: { select: { id: true, user: { select: { name: true } } } } } },
    },
  },
  // Sample payments have no customer — the rider comes from the shift.
  sample: {
    select: {
      name: true,
      area: { select: { name: true } },
      shift: { select: { rider: { select: { id: true, user: { select: { name: true } } } } } },
    },
  },
} satisfies Prisma.PaymentSelect;

type RawRow = Prisma.PaymentGetPayload<{ select: typeof ROW_SELECT }>;

function mapRow(p: RawRow): RiderCashRow {
  // Attribution order: the rider stamped on the payment (the truth — who actually
  // collected it), then the rider running that shift today (legacy rows written
  // before the stamp existed).
  const rider = p.rider ?? p.customer?.shift?.rider ?? p.sample?.shift?.rider ?? null;
  return {
    id: p.id,
    riderId: rider?.id ?? null,
    riderName: rider?.user?.name ?? "Unassigned",
    customer:
      p.customer?.name ??
      (p.sample
        ? `Sample · ${p.sample.name}`
        : strandedSampleName(p.notes)
          ? `Sample · ${strandedSampleName(p.notes)}`
          : "—"),
    customerCode: p.customer?.customerCode ?? "SAMPLE",
    area:
      p.customer?.area?.name ??
      p.sample?.area?.name ??
      (!p.sample && strandedSampleName(p.notes) ? "lead deleted" : "—"),
    amount: Number(p.amount),
    collectedAt: p.date.toISOString(),
    handedOverAt: p.handedOverAt?.toISOString() ?? null,
    handedToName: p.handedToName ?? null,
    receivedAt: p.receivedAt?.toISOString() ?? null,
    receivedByName: p.receivedByName ?? null,
    status: p.receivedAt ? "received" : p.handedOverAt ? "awaiting" : "pending",
  };
}

/**
 * @param range Optional collection-date window ("YYYY-MM-DD", PKT). The filtering
 *   happens in the QUERY, not in the browser. The default view deliberately caps
 *   settled history at ~30 days, so the old client-side date filter silently showed
 *   an empty table for any older date even though the records were sitting there.
 */
export async function getRiderCashData(range?: { from?: string; to?: string }): Promise<RiderCashData> {
  await requireRole(FULL_ACCESS);
  const applied = resolveRange(range);
  try {
    // Default view: every unsettled collection, plus ~30 days of settled history.
    // With a range: exactly that window, however far back it reaches.
    const since = new Date(Date.now() - 30 * 86_400_000);
    const rowWhere = applied
      ? { head: "RIDER_CASH" as const, date: dateRangeFromToPKT(applied.from, applied.to) }
      : {
          head: "RIDER_CASH" as const,
          OR: [{ receivedAt: null }, { date: { gte: since } }, { receivedAt: { gte: since } }],
        };

    const { gte: tStart, lte: tEnd } = todayRangePKT();

    const [tableRows, unreceivedRows, balances, withRiders, collectedToday, receivedToday] =
      await Promise.all([
        db.payment.findMany({ where: rowWhere, select: ROW_SELECT, orderBy: { date: "desc" } }),
        // Live, and never range-scoped: this is what each rider is still carrying.
        db.payment.findMany({
          where: { head: "RIDER_CASH", receivedAt: null },
          select: ROW_SELECT,
          orderBy: { date: "desc" },
        }),
        getHeadBalances(),
        getCashWithRiders(),
        db.payment.aggregate({
          _sum: { amount: true },
          where: { head: "RIDER_CASH", date: { gte: tStart, lte: tEnd } },
        }),
        db.payment.aggregate({
          _sum: { amount: true },
          where: { head: "RIDER_CASH", receivedAt: { gte: tStart, lte: tEnd } },
        }),
      ]);

    const rows = tableRows.map(mapRow);
    const unreceived = unreceivedRows.map(mapRow);

    // Per-rider "still to hand over" tiles, from the live unreceived set. Keyed by
    // rider ID, not name, so two riders sharing a name do not collapse into one bucket.
    const UNASSIGNED = "__unassigned__";
    const tileMap = new Map<string, RiderTile>();
    for (const r of unreceived) {
      const key = r.riderId ?? UNASSIGNED;
      const t = tileMap.get(key) ?? { riderId: r.riderId, riderName: r.riderName, pending: 0 };
      t.pending += r.amount;
      tileMap.set(key, t);
    }
    const tiles: RiderTile[] = [...tileMap.values()]
      .sort((a, b) => b.pending - a.pending || a.riderName.localeCompare(b.riderName));

    // The rider filter must offer everyone visible in EITHER list — a rider present
    // in the table but missing from the dropdown would be unfilterable.
    const riderMap = new Map<string, string>();
    for (const r of [...rows, ...unreceived]) if (r.riderId) riderMap.set(r.riderId, r.riderName);
    const riders = [...riderMap.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const summary = {
      withRiders,
      pendingCount: unreceived.length,
      collectedToday: Number(collectedToday._sum.amount ?? 0),
      receivedToday: Number(receivedToday._sum.amount ?? 0),
      riderCashBox: balances.find((b) => b.head === "RIDER_CASH")?.balance ?? 0,
    };

    return { rows, riders, tiles, summary, headBalances: balances, range: applied, dbReady: true };
  } catch (e) {
    console.error("[getRiderCashData]", e);
    return {
      rows: [], riders: [], tiles: [],
      summary: { withRiders: 0, pendingCount: 0, collectedToday: 0, receivedToday: 0, riderCashBox: 0 },
      headBalances: [], range: applied, dbReady: false,
    };
  }
}

// Thrown inside the claim transaction when another caller won the race; turned
// back into a normal error result below rather than surfacing as a 500.
class AlreadyConfirmed extends Error {
  constructor() { super("This cash is already confirmed received."); }
}

// Manager confirms the cash physically arrived: stamp receivedAt, which is what
// puts the money INTO the Rider Cash box. The collection already reduced the
// customer's bill when the payment was recorded, so there is no double counting.
export async function confirmRiderCashReceived(paymentId: string): Promise<RiderCashResult> {
  // The signed-in staff account is who confirms receipt — recorded so the row can
  // show "Confirmed by <name>" instead of an anonymous "Confirmed".
  // Started before the guard so the two overlap. The guard is not just a local
  // check — it validates the session against Supabase AND reads the User row, so
  // running the payment lookup after it meant two waits where one would do, and on
  // this pooler a round trip is 700-1700ms (see lib/prisma-options).
  //
  // Nothing about the guard has moved: it is still awaited before a single decision
  // is taken and long before anything is written, and an AuthError still reaches the
  // caller as a throw because this is outside the try. The only difference is that
  // one harmless SELECT is in flight while the session is being checked.
  //
  // Settled rather than awaited, so a read that fails while the guard is still
  // running cannot surface as an unhandled rejection.
  const paymentRead = db.payment
    .findUnique({
      where: { id: paymentId },
      // The rider/customer names this used to fetch were only ever for the sweep
      // transfer's note. There is no sweep any more.
      select: { id: true, head: true, receivedAt: true, handedOverAt: true },
    })
    .then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));

  const confirmer = await requireRole(FULL_ACCESS);
  try {
    const read = await paymentRead;
    if (!read.ok) throw read.e;
    const p = read.v;
    if (!p) return { ok: false, error: "Payment not found." };
    if (p.head !== "RIDER_CASH") return { ok: false, error: "Not a rider-cash payment." };
    if (p.receivedAt) return { ok: false, error: "This cash is already confirmed received." };

    // Confirming is an INFLOW — the money enters the Rider Cash box at this moment —
    // so there is no overdraft guard here. The guard lives on
    // undoRiderCashReceived, which is the direction that can overdraw.

    // The rider must have recorded the handover in the app first. This is the whole
    // control: the office confirms that cash ARRIVED, it does not get to assert that
    // a rider handed it over. Without the gate one person could clear a collection
    // from both ends, and it would also silently clear the row from the uncollected
    // alert — the one control that surfaces cash still out with a rider.
    //
    // (An earlier version stamped the handover itself when the app had not. That is
    // deliberately gone: it made the two halves the same signature.)
    if (!p.handedOverAt) {
      return {
        ok: false,
        error: "The rider hasn't recorded handing this cash over in the app yet — ask them to do that, then confirm it here.",
      };
    }

    const now = new Date();

    // Claim-then-write. The receivedAt check above is a read in a separate query, so
    // two managers (or one double-click) could both pass it. updateMany with
    // receivedAt:null in the WHERE is an atomic compare-and-swap: exactly one caller
    // can ever get count === 1, so the box is credited once. It needs no surrounding
    // transaction now that this is the only write.
    const claim = await db.payment.updateMany({
      where: { id: paymentId, receivedAt: null },
      data: { receivedAt: now, receivedByName: confirmer.name },
    });
    if (claim.count === 0) throw new AlreadyConfirmed();

    // This page is NOT revalidated here, the other four are.
    //
    // The client calls router.refresh() after the dialog closes, and that is what
    // actually puts the confirmed row on screen — tested both ways: with the
    // revalidate and no refresh the row sits on "Awaiting acceptance" until the
    // page is reloaded by hand. So revalidating this path as well only had Next
    // render the page a second time for the same tap, inline in this action's own
    // response, which is time the person confirming waits for twice over.
    revalidatePath("/payments/transfers");
    revalidatePath("/ledgers");
    revalidatePath("/billing/payment-receiving");
    revalidatePath("/");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to confirm receipt." };
  }
}

// Undo a mistaken confirmation: clears receivedAt AND removes the matching
// RIDER_CASH -> CASH transfer, in one transaction so the two halves can never
// drift apart.
//
// This exists because the Transfers screen deliberately refuses to delete a
// handover transfer (deleting it alone left receivedAt set, so the cash could
// never be re-confirmed and RIDER_CASH stayed overstated forever). That refusal
// points the user here, so the remedy has to actually live here.
export async function undoRiderCashReceived(paymentId: string): Promise<RiderCashResult> {
  await requireRole(FULL_ACCESS);
  try {
    const p = await db.payment.findUnique({
      where: { id: paymentId },
      select: { id: true, amount: true, head: true, receivedAt: true },
    });
    if (!p) return { ok: false, error: "Payment not found." };
    if (p.head !== "RIDER_CASH") return { ok: false, error: "Not a rider-cash payment." };
    if (!p.receivedAt) return { ok: false, error: "This cash hasn't been confirmed received." };

    // Which head the undo takes the money back out of depends on when the row was
    // confirmed:
    //
    //   LEGACY (confirmed while confirming also swept RIDER_CASH -> CASH): a paired
    //     transfer exists. Undoing deletes it, which puts the money back on
    //     RIDER_CASH and takes it off CASH — so CASH is the head that can overdraw.
    //   CURRENT (no transfer): the money is sitting in the Rider Cash box and undoing
    //     hands it back to the rider — so RIDER_CASH is the head that can overdraw.
    //
    // Getting this wrong is a real hole: confirm ₨5,000, spend it from Rider Cash,
    // then undo, and the head sits at −5,000.
    const legacyXfer = await db.headTransfer.findFirst({
      where: {
        fromHead: "RIDER_CASH",
        toHead: "CASH",
        amount: p.amount,
        notes: { startsWith: RIDER_CASH_RECEIPT_NOTE },
      },
      orderBy: { date: "desc" },
      select: { id: true },
    });
    const drawnFrom = legacyXfer ? "CASH" : "RIDER_CASH";

    const guard = await checkHeadFunds(drawnFrom, Number(p.amount));
    if (!guard.ok) {
      return {
        ok: false,
        error: `Can't undo — this money has already been spent from ${HEAD_LABELS[drawnFrom]}. ${guard.error}`,
      };
    }

    await db.$transaction(async (tx) => {
      // Race-free guard inside the write (checkHeadFunds above is a pre-check).
      await guardHeadFundsTx(tx, drawnFrom, Number(p.amount));
      // Release the claim atomically; if someone already undid it, stop.
      const release = await tx.payment.updateMany({
        where: { id: paymentId, receivedAt: { not: null } },
        data: { receivedAt: null, receivedByName: null },
      });
      if (release.count === 0) throw new Error("This cash hasn't been confirmed received.");

      // Legacy rows only — delete the paired sweep, re-matched inside the
      // transaction so a concurrent undo can't take the same one twice.
      if (legacyXfer) {
        await tx.headTransfer.deleteMany({ where: { id: legacyXfer.id } });
      }
    });

    revalidatePath("/payments/rider-cash");
    revalidatePath("/payments/transfers");
    revalidatePath("/ledgers");
    revalidatePath("/billing/payment-receiving");
    revalidatePath("/");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to undo receipt." };
  }
}
