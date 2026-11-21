"use client";

import { useState, useEffect } from "react";
import type { Unit } from "@/lib/units";
import { perUnitLabel, isPackUnit } from "@/lib/units";
import { Plus, Trash2, Calendar as CalendarIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { subscriptionQtyForDate, weekdayOfDateStr, type AreaSchedule } from "@/lib/schedule";
import { getShiftDeliveryDays } from "@/app/(dashboard)/customers/actions";

// "2026-08-24" → "Mon 24 Aug" for the next-delivery preview.
function fmtPreviewDate(ds: string): string {
  return new Date(`${ds}T12:00:00`).toLocaleDateString("en-GB", {
    weekday: "short", day: "numeric", month: "short",
  });
}

export type ProductOption = {
  id: string;
  name: string;
  unit: Unit;
  defaultRate: number;
};

export type CustomerProductRow = {
  productId: string;
  quantity: number;
  ratePerUnit: number;
  scheduleType: "DAILY" | "ALTERNATE" | "WEEKLY";
  alternatePattern: number[];
  /** WEEKLY only: JS weekdays (0=Sun … 6=Sat) to deliver on. */
  weekdays: number[];
  anchorDate?: string | null;
};


// JS getDay() order, so it lines up with weekdayOfDateStr() in lib/schedule.
const WEEKDAYS = [
  { n: 1, label: "Mon" }, { n: 2, label: "Tue" }, { n: 3, label: "Wed" },
  { n: 4, label: "Thu" }, { n: 5, label: "Fri" }, { n: 6, label: "Sat" },
  { n: 0, label: "Sun" },
] as const;

// Picker for "specific day only". `shiftDays` lists the weekdays the customer's
// shift actually runs within the preview window; days outside it are shown as
// unavailable so nobody picks a day the rider never goes out on.
function WeekdayEditor({
  value, onChange, shiftDays, previewDates, loading,
}: {
  value: number[];
  onChange: (v: number[]) => void;
  shiftDays: number[] | null;
  previewDates: string[];
  loading: boolean;
}) {
  const toggle = (n: number) =>
    onChange(value.includes(n) ? value.filter((d) => d !== n) : [...value, n].sort());

  return (
    <div className="rounded-md border border-border bg-muted/30 p-3">
      <p className="mb-2 text-xs text-muted-foreground">
        Delivered only on the day(s) you tick — and only when this customer&apos;s shift
        actually runs that day.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {WEEKDAYS.map((d) => {
          const on = value.includes(d.n);
          const available = shiftDays === null || shiftDays.includes(d.n);
          return (
            <button
              key={d.n}
              type="button"
              onClick={() => toggle(d.n)}
              disabled={!available}
              title={available ? undefined : "This shift does not run on this day"}
              className={
                on
                  ? "rounded-md border border-primary bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground"
                  : available
                    ? "rounded-md border border-border bg-background px-2.5 py-1 text-xs hover:bg-muted"
                    : "cursor-not-allowed rounded-md border border-dashed border-border px-2.5 py-1 text-xs text-muted-foreground/40"
              }
            >
              {d.label}
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">
        {loading
          ? "Checking this shift's delivery days…"
          : shiftDays === null
            ? "Pick a shift for this customer to see which days it runs."
            : value.length === 0
              ? "Tick at least one day, or nothing will be delivered."
              : previewDates.length
                ? `Next deliveries: ${previewDates.join(" · ")}`
                : "This shift has no matching delivery day in the next 8 weeks."}
      </p>
    </div>
  );
}

type ShiftDays = { weekdays: number[]; dates: string[]; areas: AreaSchedule[] };

function PatternEditor({
  value,
  onChange,
  shiftDays,
  anchorDate,
}: {
  value: number[];
  onChange: (v: number[]) => void;
  shiftDays: ShiftDays | null;
  anchorDate: string | null;
}) {
  const safe = value.length ? value : [0, 0];

  // The next few shift days with what each would deliver — the same calculation
  // the shift editor uses, so the team can check it before saving.
  const preview = shiftDays
    ? shiftDays.dates
        .filter((d) => !anchorDate || d >= anchorDate)
        .slice(0, 6)
        .map((d) => ({
          d,
          qty: subscriptionQtyForDate(
            {
              scheduleType: "ALTERNATE",
              quantity: 0,
              alternatePattern: safe,
              weekdays: [],
              anchorDate: anchorDate ? new Date(anchorDate) : null,
              shiftAreas: shiftDays.areas,
            },
            d,
          ),
        }))
    : [];

  const setAt = (i: number, q: number) => {
    const next = [...safe];
    next[i] = q;
    onChange(next);
  };

  const addDay = () => onChange([...safe, 0]);
  const removeAt = (i: number) => {
    if (safe.length <= 2) return;
    onChange(safe.filter((_, idx) => idx !== i));
  };

  return (
    <div className="rounded-md border border-border bg-muted/30 p-3">
      <p className="mb-2 text-xs text-muted-foreground">
        One box per <strong>shift</strong> (the days this customer&apos;s shift runs,
        counted from the start date) — it repeats automatically. e.g.{" "}
        <code className="rounded bg-muted px-1 py-0.5">2, 0</code> on an every-2nd-day
        shift delivers 2 on Monday, nothing on Wednesday, 2 on Friday… Use{" "}
        <code className="rounded bg-muted px-1 py-0.5">0</code> for a skipped shift.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {safe.map((q, i) => (
          <div
            key={i}
            className="flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1"
          >
            <span className="text-xs text-muted-foreground">Shift {i + 1}</span>
            <Input
              type="number"
              step="0.5"
              min={0}
              value={q}
              onChange={(e) => setAt(i, Number(e.target.value || 0))}
              className="h-7 w-16 px-2 text-sm"
            />
            {safe.length > 2 ? (
              <button
                type="button"
                onClick={() => removeAt(i)}
                className="text-muted-foreground hover:text-destructive"
                aria-label={`Remove shift ${i + 1}`}
              >
                <Trash2 className="size-3.5" />
              </button>
            ) : null}
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={addDay}
          className="h-8"
        >
          <Plus className="size-3.5" /> Shift
        </Button>
      </div>
      {preview.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          Next shifts:{" "}
          {preview.map((p, i) => (
            <span key={p.d}>
              {i > 0 && " · "}
              {fmtPreviewDate(p.d)}{" "}
              <strong className="text-foreground">{p.qty > 0 ? p.qty : "skip"}</strong>
            </span>
          ))}
        </p>
      )}
      {!shiftDays && (
        <p className="mt-2 text-xs text-muted-foreground">Choose a shift to see the upcoming deliveries.</p>
      )}
    </div>
  );
}

export function ProductsPicker({
  options,
  value,
  onChange,
  error,
  shiftId,
}: {
  options: ProductOption[];
  value: CustomerProductRow[];
  onChange: (rows: CustomerProductRow[]) => void;
  error?: string;
  /** The customer's shift — decides which weekdays "specific day only" can offer. */
  shiftId?: string | null;
}) {
  const [pendingProductId, setPendingProductId] = useState("");
  // Delivery days of the chosen shift, for the WEEKLY picker. null = not loaded /
  // no shift chosen, which the editor renders as "pick a shift first".
  const [shiftDays, setShiftDays] = useState<ShiftDays | null>(null);
  const [loadingDays, setLoadingDays] = useState(false);

  useEffect(() => {
    if (!shiftId) { setShiftDays(null); return; }
    let cancelled = false;
    setLoadingDays(true);
    getShiftDeliveryDays(shiftId)
      .then((d) => { if (!cancelled) setShiftDays(d); })
      .catch(() => { if (!cancelled) setShiftDays(null); })
      .finally(() => { if (!cancelled) setLoadingDays(false); });
    return () => { cancelled = true; };
  }, [shiftId]);

  const used = new Set(value.map((r) => r.productId));
  const available = options.filter((o) => !used.has(o.id));

  const addProduct = () => {
    if (!pendingProductId) return;
    const opt = options.find((o) => o.id === pendingProductId);
    if (!opt) return;
    onChange([
      ...value,
      {
        productId: opt.id,
        quantity: 1,
        ratePerUnit: opt.defaultRate,
        scheduleType: "DAILY",
        alternatePattern: [],
        weekdays: [],
        anchorDate: null,
      },
    ]);
    setPendingProductId("");
  };

  const updateRow = (idx: number, patch: Partial<CustomerProductRow>) => {
    onChange(value.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };
  const removeRow = (idx: number) => {
    onChange(value.filter((_, i) => i !== idx));
  };

  return (
    <div className="space-y-3">
      {/* Add product row */}
      <Card className="border-dashed">
        <CardContent className="flex flex-col gap-2 p-4 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Label className="text-xs">Add product</Label>
            <Select
              value={pendingProductId}
              onValueChange={setPendingProductId}
            >
              <SelectTrigger className="mt-1">
                <SelectValue placeholder="Choose a product to add" />
              </SelectTrigger>
              <SelectContent>
                {available.length === 0 ? (
                  <div className="px-3 py-2 text-sm text-muted-foreground">
                    All products added
                  </div>
                ) : (
                  available.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}{" "}
                      <span className="ml-1 text-xs text-muted-foreground">
                        ₨ {p.defaultRate}/{perUnitLabel(p.unit)}
                      </span>
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>
          <Button
            type="button"
            onClick={addProduct}
            disabled={!pendingProductId}
          >
            <Plus className="size-4" /> Add
          </Button>
        </CardContent>
      </Card>

      {value.length === 0 ? (
        <p
          className={cn(
            "rounded-md border border-dashed border-border p-4 text-center text-sm text-muted-foreground",
            error && "border-destructive/50 text-destructive"
          )}
        >
          {error ?? "No products yet. Add at least one product to continue."}
        </p>
      ) : null}

      <div className="space-y-3">
        {value.map((row, idx) => {
          const opt = options.find((o) => o.id === row.productId);
          const unit = opt?.unit ?? "LITER";
          return (
            <Card key={row.productId} className="overflow-hidden">
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold">
                      {opt?.name ?? "Unknown product"}
                    </span>
                    <Badge variant="secondary" className="text-xs">
                      per {perUnitLabel(unit)}
                    </Badge>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => removeRow(idx)}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>

                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div>
                    <Label className="text-xs">Quantity</Label>
                    <Input
                      type="number"
                      step={isPackUnit(unit) ? "1" : "0.5"}
                      min={0}
                      value={row.quantity}
                      onChange={(e) =>
                        updateRow(idx, {
                          quantity: Number(e.target.value || 0),
                        })
                      }
                      disabled={row.scheduleType === "ALTERNATE"}
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Rate / {perUnitLabel(unit)}</Label>
                    <Input
                      type="number"
                      step="1"
                      min={0}
                      value={row.ratePerUnit}
                      onChange={(e) =>
                        updateRow(idx, {
                          ratePerUnit: Number(e.target.value || 0),
                        })
                      }
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Schedule</Label>
                    <Select
                      value={row.scheduleType}
                      onValueChange={(s) =>
                        updateRow(idx, {
                          scheduleType: s as "DAILY" | "ALTERNATE" | "WEEKLY",
                          alternatePattern:
                            s === "ALTERNATE" && row.alternatePattern.length < 2
                              ? [row.quantity || 1, 0]
                              : row.alternatePattern,
                          // Leaving WEEKLY clears the day picks, so a later switch
                          // back starts clean instead of reusing stale weekdays.
                          weekdays: s === "WEEKLY" ? row.weekdays : [],
                        })
                      }
                    >
                      <SelectTrigger className="mt-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="DAILY">Daily (every shift day)</SelectItem>
                        <SelectItem value="ALTERNATE">
                          Alternate pattern (per shift)
                        </SelectItem>
                        <SelectItem value="WEEKLY">
                          Specific day only
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="mt-3 space-y-2">
                  {row.scheduleType === "ALTERNATE" && (
                    <PatternEditor
                      value={row.alternatePattern}
                      onChange={(p) =>
                        updateRow(idx, { alternatePattern: p })
                      }
                      shiftDays={shiftDays}
                      anchorDate={row.anchorDate ?? null}
                    />
                  )}
                  {row.scheduleType === "WEEKLY" && (
                    <WeekdayEditor
                      value={row.weekdays}
                      onChange={(w) => updateRow(idx, { weekdays: w })}
                      shiftDays={shiftDays?.weekdays ?? null}
                      loading={loadingDays}
                      previewDates={(shiftDays?.dates ?? [])
                        .filter((d) => row.weekdays.includes(weekdayOfDateStr(d)))
                        .slice(0, 3)
                        .map((d) => fmtPreviewDate(d))}
                    />
                  )}
                  {/* Start date applies to EVERY schedule type — no deliveries before
                      it (see subscriptionQtyForDate). For ALTERNATE it also anchors
                      the pattern's phase. */}
                  <div className="flex flex-wrap items-center gap-2">
                    <CalendarIcon className="size-3.5 text-muted-foreground" />
                    <Label className="text-xs">Start date</Label>
                    <Input
                      type="date"
                      value={row.anchorDate ?? ""}
                      onChange={(e) =>
                        updateRow(idx, {
                          anchorDate: e.target.value || null,
                        })
                      }
                      className="h-8 w-full sm:w-40"
                    />
                    <span className="text-xs text-muted-foreground">
                      {row.scheduleType === "ALTERNATE"
                        ? "No deliveries before this date; pattern starts here"
                        : "No deliveries before this date (optional)"}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
