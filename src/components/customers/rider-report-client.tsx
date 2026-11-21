"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, XCircle, MinusCircle, PlusCircle } from "lucide-react";

import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { todayPKTString } from "@/lib/pkt";
import { isShiftLockedOnDateStr } from "@/lib/schedule";
import { RiderEditDialog } from "@/components/customers/rider-edit-dialog";
import {
  getRiderShiftReport,
  type ReportRider,
  type ReportShift,
  type ReportRow,
  type RiderReportResult,
} from "@/app/(dashboard)/customers/rider-report/actions";

const UNIT_LABEL: Record<string, string> = { LITER: "L", KG: "kg", PIECE: "pc" };
function fmt(n: number) {
  return n % 1 === 0 ? n.toFixed(0) : n.toFixed(1);
}
const money = (n: number) => "₨" + Math.round(n).toLocaleString("en-PK");
const whenPKT = (iso: string) =>
  new Date(iso).toLocaleString("en-PK", { timeZone: "Asia/Karachi", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

const STATUS_META: Record<string, { label: string; cls: string; Icon: typeof CheckCircle2 }> = {
  delivered: { label: "Delivered", cls: "text-emerald-600", Icon: CheckCircle2 },
  // Billed, but the milk never left the van: nobody in, or turned away at the door.
  charged_not_delivered: { label: "Charged, not delivered", cls: "text-amber-700", Icon: MinusCircle },
  not_delivered: { label: "Not delivered", cls: "text-rose-600", Icon: XCircle },
  skipped: { label: "Skipped", cls: "text-amber-600", Icon: MinusCircle },
  extra: { label: "Extra", cls: "text-sky-600", Icon: PlusCircle },
};

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-lg font-semibold">{value}</p>
      {sub && <p className="text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

export function RiderReportClient({
  riders,
  shifts,
  initialRiderId = "",
  initialShiftId = "",
  initialDate,
  canEdit = false,
  isManager = false,
}: {
  riders: ReportRider[];
  shifts: ReportShift[];
  initialRiderId?: string;
  initialShiftId?: string;
  initialDate?: string;
  /** Admins: editing a delivery here rewrites the customer's bill. */
  canEdit?: boolean;
  /** Managers may edit as well, but only until the report's managerEditUntil. */
  isManager?: boolean;
}) {
  const [riderId, setRiderId] = useState(initialRiderId);
  const [shiftId, setShiftId] = useState(initialShiftId);
  const [date, setDate] = useState(initialDate ?? todayPKTString());
  const [report, setReport] = useState<RiderReportResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [editRow, setEditRow] = useState<ReportRow | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  // The clock the manager's window is measured against, moved on every minute so
  // the Edit buttons go away at the deadline without a reload. The server checks
  // the same deadline on every save regardless.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  // Only the shifts actually due on the date being viewed — a rider's other
  // shifts (a different area schedule, an every-2nd-day route that isn't due
  // today) used to show up here too, so picking "the shift" for a rider with
  // more than one was a guess. The currently selected shift is kept in the list
  // even if a later date change makes it no longer due, so an existing
  // selection (or a deep link from Rider Sale Summary) never disappears out
  // from under the dropdown — the report below still says plainly if there is
  // no data for it.
  const riderShifts = useMemo(
    () =>
      shifts.filter(
        (s) => s.riderId === riderId && (s.id === shiftId || !isShiftLockedOnDateStr(s.schedules, date))
      ),
    [shifts, riderId, date, shiftId]
  );
  // All of the rider's shifts, due today or not — only to tell "has none at
  // all" apart from "has some, just not due on this date" in the empty-state
  // message below.
  const allRiderShifts = useMemo(() => shifts.filter((s) => s.riderId === riderId), [shifts, riderId]);

  useEffect(() => {
    if (!shiftId || !date) {
      setReport(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    getRiderShiftReport(shiftId, date)
      .then((r) => { if (!cancelled) setReport(r); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [shiftId, date, reloadTick]);

  const stats = report?.stats;
  const managerUntil = isManager && report?.managerEditUntil ? report.managerEditUntil : null;
  const mayEdit = canEdit || (managerUntil != null && now < new Date(managerUntil).getTime());
  const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { timeZone: "Asia/Karachi", hour: "numeric", minute: "2-digit" });
  const span = (min: number) => (min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min}m`);

  return (
    <div className="space-y-4 p-4 sm:p-6">
      {/* Selection bar */}
      <div className="grid grid-cols-1 gap-3 rounded-xl border border-border bg-card p-4 sm:grid-cols-3">
        <div>
          <Label className="text-xs">Rider</Label>
          <Select value={riderId} onValueChange={(v) => { setRiderId(v); setShiftId(""); }}>
            <SelectTrigger className="mt-1"><SelectValue placeholder="Select a rider" /></SelectTrigger>
            <SelectContent>
              {riders.map((r) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs">Shift</Label>
          <Select value={shiftId} onValueChange={setShiftId} disabled={!riderId}>
            <SelectTrigger className="mt-1"><SelectValue placeholder={riderId ? "Select a shift" : "Pick a rider first"} /></SelectTrigger>
            <SelectContent>
              {riderShifts.length === 0 ? (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">
                  {allRiderShifts.length === 0 ? "No shifts for this rider" : "None of this rider's shifts are due on this date"}
                </div>
              ) : (
                riderShifts.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)
              )}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs">Date</Label>
          <Input type="date" className="mt-1" value={date} max={todayPKTString()} onChange={(e) => setDate(e.target.value)} />
        </div>
      </div>

      {!shiftId ? (
        <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          Pick a rider, shift and date to view the report.
        </p>
      ) : loading ? (
        <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
      ) : !report?.ok ? (
        <p className="py-8 text-center text-sm text-muted-foreground">No data for this shift/date.</p>
      ) : (
        <>
          {stats && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <StatCard
                label="Round time"
                value={stats.roundMinutes == null ? "—" : span(stats.roundMinutes)}
                sub={stats.firstDeliveryAt && stats.lastDeliveryAt ? `${clock(stats.firstDeliveryAt)} → ${clock(stats.lastDeliveryAt)}` : "no delivery times yet"}
              />
              <StatCard label="Delivered" value={`${stats.deliveredCustomers}/${stats.plannedCustomers}`} sub={`${stats.deliveryRate}% delivery rate`} />
              <StatCard
                label="Took"
                value={stats.tookQty == null ? "—" : fmt(stats.tookQty)}
                sub={
                  stats.tookQty == null
                    ? `sheet ${fmt(stats.plannedQty)} · no load confirmed in the app`
                    : `sheet ${fmt(stats.plannedQty)}${stats.shortAtLoadQty > 0.0005 ? ` · ${fmt(stats.shortAtLoadQty)} short at load` : ""}${stats.extraAtLoadQty > 0.0005 ? ` · ${fmt(stats.extraAtLoadQty)} extra` : ""}`
                }
              />
              <StatCard
                label="Not delivered"
                value={String(stats.notDeliveredCustomers + stats.skippedCustomers + stats.chargedNotDeliveredCustomers)}
                sub={
                  stats.chargedNotDeliveredCustomers > 0
                    ? `${stats.chargedNotDeliveredCustomers} charged anyway (${fmt(stats.chargedNotDeliveredQty)} came back)`
                    : `incl. ${stats.skippedCustomers} not home / skipped`
                }
              />
              <StatCard label="Qty delivered" value={fmt(stats.deliveredQty)} sub={stats.tookQty == null ? `of ${fmt(stats.plannedQty)} planned` : `of ${fmt(stats.tookQty)} taken`} />
              <StatCard label="Cash collected" value={money(stats.totalCash)} sub={stats.extraCustomers ? `${stats.extraCustomers} extra stop(s)` : undefined} />
            </div>
          )}

          {managerUntil && (
            mayEdit ? (
              <p className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800">
                You can edit this shift until <b>{whenPKT(managerUntil)}</b> — 24 hours after it ended. After that only an admin can change it.
              </p>
            ) : (
              <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                Editing closed on <b>{whenPKT(managerUntil)}</b>, 24 hours after this shift ended. Ask an admin if something needs changing.
              </p>
            )
          )}

          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="w-8 px-3 py-2 font-medium">#</th>
                  <th className="px-3 py-2 font-medium">Customer</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Planned</th>
                  <th className="px-3 py-2 font-medium">Delivered</th>
                  <th className="px-3 py-2 font-medium">Cash</th>
                  <th className="px-3 py-2 font-medium text-right">Edit</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {report.rows.map((r, idx) => {
                  const meta = STATUS_META[r.status];
                  const Icon = meta.Icon;
                  return (
                    <tr key={r.customerId} className="align-top">
                      <td className="px-3 py-2 text-xs text-muted-foreground tabular-nums">{r.markedAt ? idx + 1 : "—"}</td>
                      <td className="px-3 py-2">
                        <div className="font-medium">{r.name}</div>
                        <div className="text-[11px] text-muted-foreground">{r.customerCode}</div>
                      </td>
                      <td className="px-3 py-2">
                        <span className={cn("inline-flex items-center gap-1 text-xs font-medium", meta.cls)}>
                          <Icon className="size-3.5" /> {meta.label}
                        </span>
                        {r.markedAt && (
                          <div className="text-[11px] text-muted-foreground tabular-nums">
                            {clock(r.markedAt)}
                            {r.gapMinutes != null && <span> · {r.gapMinutes === 0 ? "same time" : `+${span(r.gapMinutes)}`}</span>}
                          </div>
                        )}
                        {(r.status === "skipped" || r.status === "charged_not_delivered") && r.skipReason && (
                          <div className="text-[11px] text-muted-foreground">{r.skipReason}</div>
                        )}
                        {r.status === "charged_not_delivered" && (
                          <div className="text-[11px] text-amber-700">on the bill · milk came back</div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {r.products.filter((p) => p.planned > 0).map((p, i) => (
                          <div key={i} className="text-xs text-muted-foreground">{p.productName}: {fmt(p.planned)} {UNIT_LABEL[p.unit] ?? ""}</div>
                        ))}
                        {r.plannedTotal === 0 && <span className="text-[11px] text-muted-foreground">—</span>}
                      </td>
                      <td className="px-3 py-2">
                        {r.products.filter((p) => p.delivered > 0 || p.returned > 0).map((p, i) => (
                          <div key={i} className="text-xs">
                            {p.productName}: <span className="font-medium">{fmt(p.delivered)} {UNIT_LABEL[p.unit] ?? ""}</span>
                            {p.returned > 0 && <span className="text-rose-600"> (−{fmt(p.returned)} ret)</span>}
                          </div>
                        ))}
                        {r.deliveredTotal === 0 && r.returnedTotal === 0 && <span className="text-[11px] text-muted-foreground">—</span>}
                      </td>
                      <td className="px-3 py-2 text-xs">{r.cashCollected != null ? money(r.cashCollected) : "—"}</td>
                      <td className="px-3 py-2 text-right">
                        {mayEdit && <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setEditRow(r)}>Edit</Button>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Samples on this run — they are not customer stops, so they get their own list. */}
          <div className="rounded-xl border border-border bg-card">
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <p className="text-sm font-semibold">Samples</p>
              <p className="text-xs text-muted-foreground">
                {report.samples.filter((s) => s.status === "delivered").length} delivered ·{" "}
                {report.samples.filter((s) => s.status === "not_delivered").length} not delivered ·{" "}
                {report.samples.filter((s) => s.status === "pending").length} pending
              </p>
            </div>
            {report.samples.length === 0 ? (
              <p className="px-3 py-4 text-sm text-muted-foreground">No samples on this run.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Sample</th>
                      <th className="px-3 py-2 text-left font-medium">Status</th>
                      <th className="px-3 py-2 text-left font-medium">Items</th>
                      <th className="px-3 py-2 text-left font-medium">Paid</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {report.samples.map((s) => (
                      <tr key={s.id} className="align-top">
                        <td className="px-3 py-2">
                          <div className="font-medium">{s.name}</div>
                          <div className="text-[11px] text-muted-foreground">{s.phone}</div>
                        </td>
                        <td className="px-3 py-2 text-xs">
                          <span className={cn(
                            "font-medium",
                            s.status === "delivered" ? "text-emerald-700" : s.status === "not_delivered" ? "text-orange-700" : "text-muted-foreground",
                          )}>
                            {s.status === "delivered" ? "Delivered" : s.status === "not_delivered" ? "Not delivered" : "Pending"}
                          </span>
                          {s.reportedOnly && <div className="text-[11px] text-muted-foreground">reported by rider</div>}
                          {s.status === "not_delivered" && s.reason && <div className="text-[11px] text-muted-foreground">{s.reason}</div>}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {s.items.map((it, i) => (
                            <div key={i}>{it.productName}: {fmt(it.quantity)} {UNIT_LABEL[it.unit] ?? ""}</div>
                          ))}
                        </td>
                        <td className="px-3 py-2 text-xs">
                          {s.status === "delivered"
                            ? `${money(s.amount)}${s.paymentMethod && s.paymentMethod !== "CASH" ? ` · ${s.paymentMethod}` : " · cash"}`
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      <RiderEditDialog
        row={editRow}
        shiftId={shiftId}
        date={date}
        onClose={() => setEditRow(null)}
        onSaved={() => { setEditRow(null); setReloadTick((t) => t + 1); }}
      />
    </div>
  );
}
