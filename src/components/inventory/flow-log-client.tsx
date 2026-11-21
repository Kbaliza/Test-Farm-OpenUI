"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronDown, Clock, Check, X, Loader2, Workflow, Settings2, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { addDaysToDateStr, fmtDatePKT, todayPKTString, yesterdayPKTString } from "@/lib/pkt";
import { saveFlowDeadlines, type FlowLog, type FlowDay, type FlowStep, type FlowRider } from "@/app/(dashboard)/inventory/flow-log/actions";
import type { FlowDeadlines } from "@/lib/flow-deadlines";

type Deadlines = FlowDeadlines;

// One colour per stage, from the software's own palette.
const STAGE = {
  production: { dot: "bg-emerald-600", text: "text-emerald-700" },
  accept: { dot: "bg-indigo-600", text: "text-indigo-700" },
  packaging: { dot: "bg-sky-600", text: "text-sky-700" },
  retailAccept: { dot: "bg-violet-600", text: "text-violet-700" },
  dispatch: { dot: "bg-amber-600", text: "text-amber-700" },
  returns: { dot: "bg-teal-600", text: "text-teal-700" },
} as const;
const RIDER_DOT = { recv: "bg-emerald-600", start: "bg-sky-600", end: "bg-amber-600", ret: "bg-teal-600" } as const;

function fmtQty(n: number) {
  return (Math.round(n * 100) / 100).toLocaleString("en-PK");
}
function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
}
/** "07:35" → "7:35 AM", because the whole farm reads a 12-hour clock. */
function to12(hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  const ap = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ap}`;
}
function lateBy(at: string | null, dl: string | null): number | null {
  if (!at || !dl) return null;
  const [ah, am] = at.split(":").map(Number);
  const [dh, dm] = dl.split(":").map(Number);
  return Math.max(0, ah * 60 + am - (dh * 60 + dm));
}
function mins(m: number) {
  if (m <= 0) return "0m";
  const h = Math.floor(m / 60), mm = m % 60;
  return [h ? `${h}h` : "", mm || !h ? `${mm}m` : ""].filter(Boolean).join(" ");
}

function deadlineOf(dl: Deadlines, key: string): string | null {
  const [kind, which] = key.split(":");
  if (kind === "prod") return dl.production[Number(which)] ?? null;
  if (kind === "acc") return dl.accepted[Number(which)] ?? null;
  if (kind === "pack") return dl.packaging[Number(which)] ?? null;
  if (kind === "racc") return dl.retailAccepted[Number(which)] ?? null;
  if (kind === "egg") return dl.eggs;
  if (kind === "rider") return dl.rider[which as keyof Deadlines["rider"]] ?? null;
  if (kind === "dispatch") return dl.dispatch;
  if (kind === "returns") return dl.returnsAccepted;
  return null;
}

/**
 * A milking or send that has a deadline but never happened is still a step — one
 * that was missed. As many as there are deadlines, so changing the schedule
 * changes what the day is judged against.
 */
function withMissing(d: FlowDay, dl: Deadlines): FlowDay {
  const production = [...d.production];
  for (let i = production.length; i < dl.production.length; i++) {
    production.push({ key: `prod:${i}`, label: `Milking ${i + 1}`, at: null, qty: null, unit: "L" });
  }
  const sends = d.packaging.filter((s) => !s.egg);
  const eggs = d.packaging.filter((s) => s.egg);
  for (let i = sends.length; i < dl.packaging.length; i++) {
    sends.push({ key: `pack:${i}`, label: `Send to Retail ${i + 1}`, at: null, qty: null, unit: "L" });
  }
  const accepted = [...d.accepted];
  for (let i = accepted.length; i < dl.accepted.length; i++) {
    accepted.push({ key: `acc:${i}`, label: `Accepted at packaging ${i + 1}`, at: null, qty: null, unit: "L" });
  }
  // One acceptance per send: a send Retail has not taken in yet is "not done".
  const retailAccepted = [...d.retailAccepted];
  for (let i = retailAccepted.length; i < Math.max(sends.length, dl.retailAccepted.length); i++) {
    retailAccepted.push({ key: `racc:${i}`, label: `Retail accepted send ${i + 1}`, at: null, qty: null, unit: "L" });
  }
  return { ...d, production, accepted, packaging: [...sends, ...eggs], retailAccepted };
}

/** The time, green when it met the target and red when it did not. */
function TimeCell({ at, dl }: { at: string | null; dl: string | null }) {
  if (!at) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-700">
        <X className="size-3" /> Not done
      </span>
    );
  }
  const late = lateBy(at, dl);
  return (
    <span className={cn("text-[15px] font-semibold tabular-nums", late && late > 0 ? "text-rose-700" : "text-emerald-700")}>
      {to12(at)}
    </span>
  );
}

function DeadlineChip({ at, dl }: { at: string | null; dl: string | null }) {
  if (!dl) return null;
  const lateMin = at ? (lateBy(at, dl) ?? 0) : 0;
  const late = lateMin > 0;
  return (
    <span
      className={cn("inline-flex items-center gap-1 whitespace-nowrap text-xs text-muted-foreground", late && "text-rose-600")}
      title="The time this step is meant to be done by"
    >
      {at && !late ? <Check className="size-3 text-emerald-600" /> : <Clock className="size-3" />}
      by {to12(dl)}
      {late && <span className="font-semibold">· {mins(lateMin)} late</span>}
    </span>
  );
}

function StepRow({ step, dl }: { step: FlowStep; dl: string | null }) {
  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 px-3 py-2.5 sm:grid-cols-[1fr_auto_auto]">
      <span className="min-w-0">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[15px]">
          <span>{step.label}</span>
          {step.egg && <span className="rounded-full bg-amber-50 px-1.5 py-px text-[11px] font-medium text-amber-700">Eggs</span>}
        </span>
        {step.detail && <span className="block text-xs text-muted-foreground">{step.detail}</span>}
      </span>
      {/* On a phone the time sits on its own line under the name, so a late step
          does not squeeze the name into a column a word wide. */}
      <span className="order-last col-span-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 sm:order-none sm:col-span-1 sm:flex-col sm:items-end">
        <TimeCell at={step.at} dl={dl} />
        <DeadlineChip at={step.at} dl={dl} />
      </span>
      <span className={cn("min-w-[72px] text-right text-[15px] font-medium tabular-nums", step.qty == null && "text-muted-foreground")}>
        {step.qty == null ? "—" : `${fmtQty(step.qty)} ${step.unit ?? ""}`}
      </span>
    </div>
  );
}

function RiderCard({ r, dl }: { r: FlowRider; dl: Deadlines }) {
  const fields: [keyof typeof RIDER_DOT, string, string | null][] = [
    ["recv", "Load received", r.recv],
    ["start", "Delivery start", r.start],
    ["end", "Delivery end", r.end],
    ["ret", "Load returned", r.ret],
  ];
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-2">
        <span className="grid size-6 shrink-0 place-items-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">{initials(r.name)}</span>
        <span className="text-[15px] font-semibold">{r.name}</span>
        <span className="ml-auto text-sm text-muted-foreground">
          Load <span className="font-semibold text-foreground tabular-nums">{fmtQty(r.load)} L</span>
        </span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4">
        {fields.map(([k, label, at], i) => (
          <div
            key={k}
            className={cn(
              "px-3 py-2",
              i % 2 === 0 && "border-r border-border/60",
              i < 2 && "border-b border-border/60 sm:border-b-0",
              "sm:border-r sm:last:border-r-0",
            )}
          >
            <div className="mb-0.5 flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground">
              <span className={cn("size-1.5 rounded-full", RIDER_DOT[k])} />
              {label}
            </div>
            <TimeCell at={at} dl={deadlineOf(dl, `rider:${k}`)} />
            <div><DeadlineChip at={at} dl={deadlineOf(dl, `rider:${k}`)} /></div>
          </div>
        ))}
      </div>
      <div className="flex gap-3 border-t border-border/60 px-3 py-2 text-sm text-muted-foreground">
        <span>Delivered <b className="font-semibold text-foreground tabular-nums">{fmtQty(r.delivered)} L</b></span>
        <span>Returned <b className="font-semibold text-foreground tabular-nums">{fmtQty(r.returned)} L</b></span>
      </div>
    </div>
  );
}

/** Every step across the window, so the summary can count what was met and what was not. */
function allSteps(days: FlowDay[], dl: Deadlines) {
  const out: { cat: string; who: string; at: string | null; dl: string | null }[] = [];
  for (const d of days) {
    for (const s of d.production) out.push({ cat: "Production", who: s.label, at: s.at, dl: deadlineOf(dl, s.key) });
    for (const s of d.accepted) out.push({ cat: "Packaging acceptance", who: s.label, at: s.at, dl: deadlineOf(dl, s.key) });
    for (const s of d.packaging) out.push({ cat: "Packaging", who: s.label, at: s.at, dl: deadlineOf(dl, s.key) });
    for (const s of d.retailAccepted) out.push({ cat: "Retail acceptance", who: s.label, at: s.at, dl: deadlineOf(dl, s.key) });
    out.push({ cat: "Dispatch", who: "Dispatched retail", at: d.dispatch.at, dl: dl.dispatch });
    for (const r of d.riders) {
      out.push({ cat: "Rider", who: r.name, at: r.recv, dl: dl.rider.recv });
      out.push({ cat: "Rider", who: r.name, at: r.start, dl: dl.rider.start });
      out.push({ cat: "Rider", who: r.name, at: r.end, dl: dl.rider.end });
      out.push({ cat: "Rider", who: r.name, at: r.ret, dl: dl.rider.ret });
    }
    out.push({ cat: "Returns", who: "Returns accepted", at: d.returnsAccepted.at, dl: dl.returnsAccepted });
  }
  return out;
}

function StatCard({ label, value, sub, cls }: { label: string; value: string; sub?: string; cls?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("mt-0.5 text-xl font-semibold tabular-nums", cls)}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

type Preset = "today" | "yesterday" | "7" | "15" | "30" | "custom";
const PRESETS: [Exclude<Preset, "custom">, string][] = [
  ["today", "Today"], ["yesterday", "Yesterday"], ["7", "7 days"], ["15", "15 days"], ["30", "30 days"],
];
function presetRange(p: Exclude<Preset, "custom">): [string, string] {
  const today = todayPKTString();
  if (p === "today") return [today, today];
  if (p === "yesterday") { const y = yesterdayPKTString(); return [y, y]; }
  return [addDaysToDateStr(today, -(Number(p) - 1)), today];
}
function presetOf(from: string, to: string): Preset {
  for (const [k] of PRESETS) {
    const [f, t] = presetRange(k);
    if (f === from && t === to) return k;
  }
  return "custom";
}

export function FlowLogClient({ data, deadlines, canEdit }: { data: FlowLog; deadlines: Deadlines; canEdit: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  // Only the newest day opens by itself; the others wait to be clicked.
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [editOpen, setEditOpen] = useState(false);
  const preset = presetOf(data.from, data.to);

  function applyRange(from: string, to: string) {
    const p = new URLSearchParams();
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    start(() => router.push(`/inventory/flow-log?${p}`, { scroll: false }));
  }

  const days = useMemo(() => data.days.map((d) => withMissing(d, deadlines)), [data.days, deadlines]);
  const steps = useMemo(() => allSteps(days, deadlines), [days, deadlines]);
  const done = steps.filter((s) => s.at);
  const withTarget = done.filter((s) => s.dl);
  const missed = withTarget.filter((s) => (lateBy(s.at, s.dl) ?? 0) > 0);
  const onTime = withTarget.length - missed.length;
  const rate = withTarget.length ? Math.round((onTime / withTarget.length) * 100) : 0;
  const totalDelay = missed.reduce((s, x) => s + (lateBy(x.at, x.dl) ?? 0), 0);

  return (
    <div className="space-y-4 p-4 sm:p-6">
      {/* Range */}
      <div className="flex flex-wrap items-end gap-3.5 rounded-xl border border-border bg-card px-4 py-3.5 shadow-sm">
        <div>
          <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Range</label>
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map(([k, l]) => (
              <Button key={k} size="sm" variant={preset === k ? "default" : "outline"} className="h-9 px-3 text-sm" disabled={pending}
                onClick={() => { const [f, t] = presetRange(k); applyRange(f, t); }}>
                {l}
              </Button>
            ))}
          </div>
        </div>
        <div>
          <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wide text-muted-foreground">From</label>
          <input type="date" value={data.from} max={todayPKTString()} onChange={(e) => e.target.value && applyRange(e.target.value, data.to)}
            className="h-9 rounded-md border border-border bg-background px-2.5 text-sm tabular-nums" />
        </div>
        <div>
          <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wide text-muted-foreground">To</label>
          <input type="date" value={data.to} min={data.from} max={todayPKTString()} onChange={(e) => e.target.value && applyRange(data.from, e.target.value)}
            className="h-9 rounded-md border border-border bg-background px-2.5 text-sm tabular-nums" />
        </div>
        {pending && <Loader2 className="mb-2.5 size-4 animate-spin text-muted-foreground" />}
        {canEdit && (
          <Button size="sm" variant="outline" className="ml-auto h-9 text-sm" onClick={() => setEditOpen(true)}>
            <Settings2 className="mr-1.5 size-3.5" /> Deadlines
          </Button>
        )}
      </div>

      {/* Summary across the window */}
      {days.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <StatCard label="On time" value={String(onTime)} cls="text-emerald-700" />
          <StatCard label="Late" value={String(missed.length)} cls={missed.length ? "text-rose-700" : undefined} />
          <StatCard label="Not done" value={String(steps.length - done.length)} />
          <StatCard label="On-time rate" value={withTarget.length ? `${rate}%` : "—"}
            cls={!withTarget.length ? undefined : rate >= 90 ? "text-emerald-700" : rate >= 70 ? "text-amber-700" : "text-rose-700"} />
          <StatCard label="Total delay" value={mins(totalDelay)} sub={`${days.length} day${days.length === 1 ? "" : "s"}`} />
        </div>
      )}

      {days.length === 0 && (
        <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          <Workflow className="mx-auto mb-2 size-6 opacity-40" />
          Nothing recorded in this window.
        </div>
      )}

      {days.map((d, idx) => {
        const dayLate = allSteps([d], deadlines).filter((s) => s.at && s.dl && (lateBy(s.at, s.dl) ?? 0) > 0).length;
        const isOpen = open[d.date] ?? idx === 0;
        return (
          <div key={d.date} className="overflow-hidden rounded-xl border border-border bg-card">
            <button
              type="button"
              onClick={() => setOpen((o) => ({ ...o, [d.date]: !isOpen }))}
              className={cn("flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/40", isOpen && "border-b border-border")}
            >
              <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", !isOpen && "-rotate-90")} />
              <span>
                <span className="block text-base font-semibold">{fmtDatePKT(d.date)}</span>
                <span className="block text-sm text-muted-foreground">
                  {new Date(d.date + "T12:00:00").toLocaleDateString("en-GB", { weekday: "long" })}
                </span>
              </span>
              <span className={cn(
                "ml-auto rounded-full px-2.5 py-0.5 text-sm font-medium",
                dayLate ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-700"
              )}>
                {dayLate ? `${dayLate} late` : "On time"}
              </span>
            </button>

            {isOpen && (
              <div>
                <div className="space-y-4 px-4 py-4">
                  <Stage stage="production" title="Production" note="Milk collected at the farm">
                    <div className="divide-y divide-border rounded-lg border border-border">
                      {d.production.map((s) => <StepRow key={s.key} step={s} dl={deadlineOf(deadlines, s.key)} />)}
                    </div>
                  </Stage>

                  <Stage stage="accept" title="Packaging acceptance" note="Each milking taken into packaging's stock">
                    <div className="divide-y divide-border rounded-lg border border-border">
                      {d.accepted.map((s) => <StepRow key={s.key} step={s} dl={deadlineOf(deadlines, s.key)} />)}
                    </div>
                  </Stage>

                  <Stage stage="packaging" title="Packaging" note="Bottled and sent to Retail — plus the eggs">
                    <div className="divide-y divide-border rounded-lg border border-border">
                      {d.packaging.map((s) => <StepRow key={s.key} step={s} dl={deadlineOf(deadlines, s.key)} />)}
                    </div>
                  </Stage>

                  <Stage stage="retailAccept" title="Retail acceptance" note="Each send taken in at the retail centre">
                    <div className="divide-y divide-border rounded-lg border border-border">
                      {d.retailAccepted.map((s) => <StepRow key={s.key} step={s} dl={deadlineOf(deadlines, s.key)} />)}
                    </div>
                  </Stage>

                  <Stage
                    stage="dispatch"
                    title="Dispatched Retail"
                    note={`Loaded out to ${d.riders.length} rider${d.riders.length === 1 ? "" : "s"}`}
                    right={<><TimeCell at={d.dispatch.at} dl={deadlines.dispatch} /><div><DeadlineChip at={d.dispatch.at} dl={deadlines.dispatch} /></div></>}
                  >
                    {d.riders.length > 0 ? (
                      <div className="space-y-2">
                        {d.riders.map((r) => <RiderCard key={r.riderId ?? r.name} r={r} dl={deadlines} />)}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">No loads went out.</p>
                    )}
                  </Stage>

                  <Stage
                    stage="returns"
                    title="Returned Accepted"
                    note="Leftover from every rider received back into stock"
                    right={<><TimeCell at={d.returnsAccepted.at} dl={deadlines.returnsAccepted} /><div><DeadlineChip at={d.returnsAccepted.at} dl={deadlines.returnsAccepted} /></div></>}
                  />
                </div>

              </div>
            )}
          </div>
        );
      })}

      {editOpen && <DeadlinesDialog initial={deadlines} onClose={() => setEditOpen(false)} />}
    </div>
  );
}

function Stage({ stage, title, note, right, children }: {
  stage: keyof typeof STAGE; title: string; note: string; right?: React.ReactNode; children?: React.ReactNode;
}) {
  const c = STAGE[stage];
  return (
    <div className={cn("grid gap-3", right ? "grid-cols-[14px_1fr_auto]" : "grid-cols-[14px_1fr]")}>
      <div className="flex flex-col items-center pt-1">
        <span className={cn("size-2.5 shrink-0 rounded-full", c.dot)} />
        <span className="mt-1 w-px flex-1 bg-border" />
      </div>
      <div className="min-w-0">
        <p className={cn("text-base font-semibold", c.text)}>{title}</p>
        <p className="text-sm text-muted-foreground">{note}</p>
        {children && <div className="mt-2">{children}</div>}
      </div>
      {right && <div className="whitespace-nowrap text-right">{right}</div>}
    </div>
  );
}

// ── Deadlines ────────────────────────────────────────────────────────────────
// One schedule for every day. Saved, it holds until someone changes it again.

function Time({ label, value, onChange, onRemove }: { label: string; value: string; onChange: (v: string) => void; onRemove?: () => void }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-36 shrink-0 text-sm text-muted-foreground">{label}</span>
      <Input type="time" value={value} onChange={(e) => onChange(e.target.value)} className="h-9 w-36 text-sm" />
      {onRemove && (
        <button type="button" onClick={onRemove} className="text-muted-foreground hover:text-rose-600" title="Remove">
          <Trash2 className="size-3.5" />
        </button>
      )}
    </div>
  );
}

function Section({ title, children, onAdd }: { title: string; children: React.ReactNode; onAdd?: () => void }) {
  return (
    <div className="space-y-1.5 rounded-lg border border-border p-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold">{title}</p>
        {onAdd && (
          <button type="button" onClick={onAdd} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
            <Plus className="size-3" /> Add
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

type ListKey = "production" | "accepted" | "packaging" | "retailAccepted";

function DeadlinesDialog({ initial, onClose }: { initial: Deadlines; onClose: () => void }) {
  const router = useRouter();
  const [d, setD] = useState<Deadlines>(() => structuredClone(initial));
  const [saving, startSave] = useTransition();

  const setList = (k: ListKey, i: number, v: string) =>
    setD((x) => ({ ...x, [k]: x[k].map((c, j) => (j === i ? v : c)) }));
  const addTo = (k: ListKey) =>
    setD((x) => ({ ...x, [k]: [...x[k], x[k][x[k].length - 1] ?? "12:00"] }));
  const removeFrom = (k: ListKey, i: number) =>
    setD((x) => ({ ...x, [k]: x[k].filter((_, j) => j !== i) }));

  function save() {
    startSave(async () => {
      const r = await saveFlowDeadlines(d);
      if (!r.ok) { toast.error(r.error); return; }
      toast.success("Deadlines saved — every day is now judged against them.");
      onClose();
      router.refresh();
    });
  }

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-h-[90vh] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Deadlines</DialogTitle>
          <DialogDescription className="text-xs">
            The time each step should be done by. One schedule for every day — change it here whenever it needs to change.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Section title="Production" onAdd={() => addTo("production")}>
            {d.production.map((c, i) => (
              <Time key={i} label={`Milking ${i + 1}`} value={c} onChange={(v) => setList("production", i, v)}
                onRemove={d.production.length > 1 ? () => removeFrom("production", i) : undefined} />
            ))}
          </Section>
          <Section title="Packaging acceptance" onAdd={() => addTo("accepted")}>
            {d.accepted.map((c, i) => (
              <Time key={i} label={`Accepted ${i + 1}`} value={c} onChange={(v) => setList("accepted", i, v)}
                onRemove={d.accepted.length > 1 ? () => removeFrom("accepted", i) : undefined} />
            ))}
          </Section>
          <Section title="Packaging" onAdd={() => addTo("packaging")}>
            {d.packaging.map((c, i) => (
              <Time key={i} label={`Send to Retail ${i + 1}`} value={c} onChange={(v) => setList("packaging", i, v)}
                onRemove={d.packaging.length > 1 ? () => removeFrom("packaging", i) : undefined} />
            ))}
            <Time label="Eggs collected & packed" value={d.eggs} onChange={(v) => setD((x) => ({ ...x, eggs: v }))} />
          </Section>
          <Section title="Retail acceptance" onAdd={() => addTo("retailAccepted")}>
            {d.retailAccepted.map((c, i) => (
              <Time key={i} label={`Send ${i + 1} accepted`} value={c} onChange={(v) => setList("retailAccepted", i, v)}
                onRemove={d.retailAccepted.length > 1 ? () => removeFrom("retailAccepted", i) : undefined} />
            ))}
          </Section>
          <Section title="Dispatch">
            <Time label="Dispatched Retail" value={d.dispatch} onChange={(v) => setD((x) => ({ ...x, dispatch: v }))} />
          </Section>
          <Section title="Each rider">
            <Time label="Load received" value={d.rider.recv} onChange={(v) => setD((x) => ({ ...x, rider: { ...x.rider, recv: v } }))} />
            <Time label="Delivery start" value={d.rider.start} onChange={(v) => setD((x) => ({ ...x, rider: { ...x.rider, start: v } }))} />
            <Time label="Delivery end" value={d.rider.end} onChange={(v) => setD((x) => ({ ...x, rider: { ...x.rider, end: v } }))} />
            <Time label="Load returned" value={d.rider.ret} onChange={(v) => setD((x) => ({ ...x, rider: { ...x.rider, ret: v } }))} />
          </Section>
          <Section title="Returns">
            <Time label="Returned Accepted" value={d.returnsAccepted} onChange={(v) => setD((x) => ({ ...x, returnsAccepted: v }))} />
          </Section>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button size="sm" onClick={save} disabled={saving}>
            {saving && <Loader2 className="mr-1.5 size-3.5 animate-spin" />} Save deadlines
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
