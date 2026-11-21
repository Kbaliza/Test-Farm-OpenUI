import { cookies } from "next/headers";
import { PageHeader } from "@/components/layout/page-header";
import { DbNotReady } from "@/components/db-not-ready";
import { PreDeliveryClient } from "@/components/customers/pre-delivery-client";
import { TodayTotalsButton } from "@/components/customers/today-totals-button";
import { getPreDeliveryContext, getShiftCustomers } from "./actions";
import { todayPKTString, addDaysToDateStr } from "@/lib/pkt";
import { getDashboardUser, FULL_ACCESS } from "@/lib/auth";
import { isShiftLockedOnDateStr } from "@/lib/schedule";

// Always render fresh: this editor must reflect the latest saved route the moment
// a manager returns to it (a cached copy is what made saved edits look reverted).
export const dynamic = "force-dynamic";

export default async function PreDeliveryPage({
  searchParams,
}: {
  searchParams: Promise<{ shift?: string; date?: string }>;
}) {
  const [ctx, user, sp, cookieStore] = await Promise.all([getPreDeliveryContext(), getDashboardUser(), searchParams, cookies()]);
  const isAdmin = !!user && FULL_ACCESS.includes(user.role);
  if (!ctx.dbReady) {
    return (
      <div className="flex flex-col">
        <PageHeader title="Pre-Delivery / Shift Editor" />
        <DbNotReady what="Pre-Delivery editor" />
      </div>
    );
  }

  // Default to the first shift actually scheduled today — not just
  // alphabetically first — so the editor never opens on a locked shift by
  // accident. Falls back to shifts[0] only if nothing runs today at all.
  const today = todayPKTString();
  const defaultShiftId =
    ctx.shifts.find((s) => !isShiftLockedOnDateStr(s.schedules, today))?.id
    ?? ctx.shifts[0]?.id
    ?? "";
  // Restore which shift the manager was last on so reopening from the (param-less)
  // sidebar link returns to it instead of snapping back to today's first shift — which
  // is what made a saved quantity look reverted. Precedence: explicit ?shift (deep
  // link / refresh) → the pd_shift cookie the client sets → default. The DATE always
  // resets to today unless an explicit ?date is given (per product decision).
  const cookieShift = cookieStore.get("pd_shift")?.value;
  const selectedShiftId =
    sp.shift && ctx.shifts.some((s) => s.id === sp.shift) ? sp.shift
    : cookieShift && ctx.shifts.some((s) => s.id === cookieShift) ? cookieShift
    : defaultShiftId;
  // A link (?date=…) cannot open further ahead than the date box allows. Phones
  // ignore the box's limit, so it is enforced here as well as when a date is picked.
  const requestedDate = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : today;
  const initialDate = requestedDate > addDaysToDateStr(today, 1) ? today : requestedDate;
  const initial = selectedShiftId
    ? await getShiftCustomers(selectedShiftId, initialDate)
    : { stops: [], available: {}, tracked: [], fromRetail: [], extras: [], settledExtras: [], status: null, startedAt: null, completedAt: null };

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Pre-Delivery / Shift Editor"
        description="Plan today's route - reorder stops, adjust quantities, assign rider"
        actions={<TodayTotalsButton />}
      />
      <PreDeliveryClient
        shifts={ctx.shifts}
        products={ctx.products}
        initialShiftId={selectedShiftId}
        initialDate={initialDate}
        initialStops={initial.stops}
        initialAvailable={initial.available}
        initialTracked={initial.tracked}
        initialFromRetail={initial.fromRetail}
        initialExtras={initial.extras}
        initialSettledExtras={initial.settledExtras}
        initialStatus={initial.status}
        initialStartedAt={initial.startedAt}
        initialCompletedAt={initial.completedAt}
        isAdmin={isAdmin}
      />
    </div>
  );
}
