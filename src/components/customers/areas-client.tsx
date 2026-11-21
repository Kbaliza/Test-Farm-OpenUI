"use client";

import { useState, useMemo, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Pencil, Trash2, MapPin, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { describeSchedule, deliveryDatesInMonth, type AreaSchedule } from "@/lib/schedule";
import { todayPKTString } from "@/lib/pkt";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  createArea,
  updateArea,
  deleteArea,
  type AreaEntry,
  type ShiftEntry,
  type RiderOption,
} from "@/app/(dashboard)/customers/areas/actions";
import { ShiftsClient } from "@/components/customers/shifts-client";

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

// The schedule slice of the form (the 4 Area schedule fields, as strings for the UI).
type Sched = { scheduleType: string; scheduleInterval: number; scheduleAnchor: string; customDates: string[] };
type FormState = { name: string; charge: string } & Sched;
const emptyForm: FormState = { name: "", charge: "0", scheduleType: "DAILY", scheduleInterval: 1, scheduleAnchor: "", customDates: [] };

function toAreaSchedule(s: Sched): AreaSchedule {
  return { scheduleType: s.scheduleType, scheduleInterval: s.scheduleInterval, scheduleAnchor: s.scheduleAnchor || null, customDates: s.customDates };
}

// Table cell: the area's schedule as a pill.
function ScheduleBadge({ area }: { area: AreaEntry }) {
  return (
    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
      {describeSchedule(area)}
    </span>
  );
}

// Dropdown option <-> schedule fields.
function schedToOption(s: Sched): string {
  if (s.scheduleType === "EVERY_N") return s.scheduleInterval === 3 ? "every3" : "every2";
  if (s.scheduleType === "CUSTOM") return "custom";
  return "daily";
}
function optionToSched(opt: string, cur: Sched): Sched {
  if (opt === "every2") return { ...cur, scheduleType: "EVERY_N", scheduleInterval: 2, scheduleAnchor: cur.scheduleAnchor || todayPKTString() };
  if (opt === "every3") return { ...cur, scheduleType: "EVERY_N", scheduleInterval: 3, scheduleAnchor: cur.scheduleAnchor || todayPKTString() };
  if (opt === "custom") return { ...cur, scheduleType: "CUSTOM", scheduleInterval: 1 };
  return { ...cur, scheduleType: "DAILY", scheduleInterval: 1 };
}

// Delivery-schedule editor: dropdown + (for Every-N) a cycle-start date + a month
// calendar that previews the delivery days (read-only for Daily/Every-N) or lets
// you tap specific dates (Custom).
function ScheduleEditor({ value, onChange }: { value: Sched; onChange: (s: Sched) => void }) {
  const [ty, tm] = todayPKTString().split("-").map(Number);
  const [cal, setCal] = useState<{ y: number; m: number }>({ y: ty, m: tm });
  const isCustom = value.scheduleType === "CUSTOM";
  const sched = toAreaSchedule(value);
  const deliverySet = new Set(deliveryDatesInMonth(sched, cal.y, cal.m));
  const monthCount = deliverySet.size;

  const firstDow = new Date(cal.y, cal.m - 1, 1).getDay();
  const daysInMonth = new Date(cal.y, cal.m, 0).getDate();
  const cells: (number | null)[] = [...Array(firstDow).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
  const dateStr = (day: number) => `${cal.y}-${String(cal.m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

  const toggleDate = (day: number) => {
    if (!isCustom) return;
    const ds = dateStr(day);
    const has = value.customDates.includes(ds);
    onChange({ ...value, customDates: has ? value.customDates.filter((d) => d !== ds) : [...value.customDates, ds].sort() });
  };
  const stepMonth = (dir: 1 | -1) =>
    setCal((c) => {
      const m = c.m + dir;
      if (m < 1) return { y: c.y - 1, m: 12 };
      if (m > 12) return { y: c.y + 1, m: 1 };
      return { y: c.y, m };
    });

  return (
    <div className="space-y-3">
      <Select value={schedToOption(value)} onValueChange={(v) => onChange(optionToSched(v, value))}>
        <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="daily">Daily</SelectItem>
          <SelectItem value="every2">Every 2nd day</SelectItem>
          <SelectItem value="every3">Every 3rd day</SelectItem>
          <SelectItem value="custom">Custom (pick dates)</SelectItem>
        </SelectContent>
      </Select>

      {value.scheduleType === "EVERY_N" && (
        <div className="flex items-center gap-2">
          <Label className="text-xs text-muted-foreground">Cycle starts on</Label>
          <Input
            type="date"
            value={value.scheduleAnchor}
            onChange={(e) => onChange({ ...value, scheduleAnchor: e.target.value })}
            className="h-8 w-40 text-sm"
          />
        </div>
      )}

      <div className="rounded-lg border border-border p-2">
        <div className="mb-1 flex items-center justify-between">
          <button type="button" onClick={() => stepMonth(-1)} className="rounded p-1 hover:bg-muted"><ChevronLeft className="size-4" /></button>
          <span className="text-sm font-medium">{MONTHS[cal.m - 1]} {cal.y}</span>
          <button type="button" onClick={() => stepMonth(1)} className="rounded p-1 hover:bg-muted"><ChevronRight className="size-4" /></button>
        </div>
        <div className="grid grid-cols-7 gap-0.5 text-center">
          {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
            <div key={i} className="pb-1 text-[10px] font-medium text-muted-foreground">{d}</div>
          ))}
          {cells.map((day, i) =>
            day === null ? (
              <div key={i} />
            ) : (
              <button
                key={i}
                type="button"
                onClick={() => toggleDate(day)}
                disabled={!isCustom}
                className={cn(
                  "flex aspect-square items-center justify-center rounded text-[11px] transition-colors",
                  deliverySet.has(dateStr(day)) ? "bg-emerald-100 font-semibold text-emerald-700" : "text-muted-foreground",
                  isCustom ? "cursor-pointer hover:bg-muted" : "cursor-default"
                )}
              >
                {day}
              </button>
            )
          )}
        </div>
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          {describeSchedule(sched)} · {monthCount} delivery day{monthCount !== 1 ? "s" : ""} in {MONTHS[cal.m - 1].slice(0, 3)}
          {isCustom ? " · tap dates to toggle" : " · preview"}
        </p>
      </div>
    </div>
  );
}

function AreaFormFields({
  initial,
  pending,
  onClose,
  onSave,
}: {
  initial: FormState;
  pending: boolean;
  onClose: () => void;
  onSave: (f: FormState) => void;
}) {
  const [form, setForm] = useState<FormState>(initial);
  return (
    <>
      <div className="space-y-4 py-1">
        <div>
          <Label>Area Name *</Label>
          <Input
            className="mt-1"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="e.g. DHA Phase 5"
            autoFocus
          />
        </div>
        <div>
          <Label>Default Delivery Charge (Rs)</Label>
          <Input
            type="number"
            min="0"
            step="1"
            className="mt-1"
            value={form.charge}
            onChange={(e) => setForm((f) => ({ ...f, charge: e.target.value }))}
          />
        </div>
        <div>
          <Label className="mb-2 block">Delivery Schedule</Label>
          <ScheduleEditor
            value={form}
            onChange={(s) => setForm((f) => ({ ...f, ...s }))}
          />
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={pending}>
          Cancel
        </Button>
        <Button onClick={() => onSave(form)} disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </>
  );
}

function AreaFormDialog({
  open,
  title,
  initial,
  pending,
  onClose,
  onSave,
}: {
  open: boolean;
  title: string;
  initial: FormState;
  pending: boolean;
  onClose: () => void;
  onSave: (f: FormState) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Set the area name, default delivery charge, and how often milk is delivered here.
          </DialogDescription>
        </DialogHeader>
        {open && (
          <AreaFormFields
            key={initial.name}
            initial={initial}
            pending={pending}
            onClose={onClose}
            onSave={onSave}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function DeleteConfirm({
  area,
  pending,
  onCancel,
  onConfirm,
}: {
  area: AreaEntry | null;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={!!area} onOpenChange={(v) => !v && onCancel()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Delete area?</DialogTitle>
          <DialogDescription>
            {area && (
              <>
                <strong>&ldquo;{area.name}&rdquo;</strong> will be permanently removed.
                {area.customerCount > 0 && (
                  <span className="block mt-1 text-destructive">
                    {area.customerCount} customer{area.customerCount !== 1 ? "s are" : " is"} assigned to this area — unassign them first.
                  </span>
                )}
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={pending || (area?.customerCount ?? 0) > 0}>
            {pending ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AreasPanel({ initialAreas }: { initialAreas: AreaEntry[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [addOpen, setAddOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<AreaEntry | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AreaEntry | null>(null);
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  function handleSort(key: string) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  }

  const sorted = useMemo(() => {
    if (!sortKey) return initialAreas;
    return [...initialAreas].sort((a, b) => {
      const av = (a as Record<string, unknown>)[sortKey];
      const bv = (b as Record<string, unknown>)[sortKey];
      if (typeof av === "number" && typeof bv === "number")
        return sortDir === "asc" ? av - bv : bv - av;
      const as_ = String(av ?? ""), bs_ = String(bv ?? "");
      return sortDir === "asc" ? as_.localeCompare(bs_) : bs_.localeCompare(as_);
    });
  }, [initialAreas, sortKey, sortDir]);

  function handleAdd(form: FormState) {
    startTransition(async () => {
      const res = await createArea({
        name: form.name,
        defaultDeliveryCharge: parseFloat(form.charge) || 0,
        schedule: { scheduleType: form.scheduleType, scheduleInterval: form.scheduleInterval, scheduleAnchor: form.scheduleAnchor || null, customDates: form.customDates },
      });
      if (res.ok) {
        toast.success("Area added.");
        setAddOpen(false);
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  function handleEdit(form: FormState) {
    if (!editTarget) return;
    startTransition(async () => {
      const res = await updateArea(editTarget.id, {
        name: form.name,
        defaultDeliveryCharge: parseFloat(form.charge) || 0,
        schedule: { scheduleType: form.scheduleType, scheduleInterval: form.scheduleInterval, scheduleAnchor: form.scheduleAnchor || null, customDates: form.customDates },
      });
      if (res.ok) {
        toast.success("Area updated.");
        setEditTarget(null);
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  function handleDelete() {
    if (!deleteTarget) return;
    startTransition(async () => {
      const res = await deleteArea(deleteTarget.id);
      if (res.ok) {
        toast.success("Area deleted.");
        setDeleteTarget(null);
        router.refresh();
      } else {
        toast.error(res.error);
        setDeleteTarget(null);
      }
    });
  }

  return (
    <div className="p-4 sm:p-6 space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {initialAreas.length} area{initialAreas.length !== 1 ? "s" : ""}
        </p>
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus className="mr-1.5 size-4" />
          Add Area
        </Button>
      </div>

      {initialAreas.length === 0 ? (
        <div className="flex h-48 flex-col items-center justify-center gap-3 rounded-xl border border-dashed text-muted-foreground">
          <MapPin className="size-7 opacity-40" />
          <p className="text-sm">No areas yet. Add your first delivery area.</p>
          <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
            <Plus className="mr-1.5 size-4" />
            Add Area
          </Button>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th
                  onClick={() => handleSort("name")}
                  className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
                >
                  <span className="inline-flex items-center gap-1">
                    Area
                    <span className={sortKey === "name" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                      {sortKey === "name" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                    </span>
                  </span>
                </th>
                <th
                  onClick={() => handleSort("defaultDeliveryCharge")}
                  className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
                >
                  <span className="inline-flex items-center justify-end gap-1">
                    Delivery Charge
                    <span className={sortKey === "defaultDeliveryCharge" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                      {sortKey === "defaultDeliveryCharge" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                    </span>
                  </span>
                </th>
                <th
                  onClick={() => handleSort("scheduleType")}
                  className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
                >
                  <span className="inline-flex items-center gap-1">
                    Schedule
                    <span className={sortKey === "scheduleType" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                      {sortKey === "scheduleType" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                    </span>
                  </span>
                </th>
                <th
                  onClick={() => handleSort("customerCount")}
                  className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
                >
                  <span className="inline-flex items-center justify-end gap-1">
                    Customers
                    <span className={sortKey === "customerCount" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                      {sortKey === "customerCount" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                    </span>
                  </span>
                </th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sorted.map((area) => (
                <tr key={area.id} className="hover:bg-muted/20">
                  <td className="px-4 py-3 font-medium">{area.name}</td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    Rs {area.defaultDeliveryCharge.toLocaleString()}
                  </td>
                  <td className="px-4 py-3">
                    <ScheduleBadge area={area} />
                  </td>
                  <td className="px-4 py-3 text-right text-muted-foreground">
                    {area.customerCount}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => setEditTarget(area)}
                        className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                        title="Edit"
                      >
                        <Pencil className="size-3.5" />
                      </button>
                      <button
                        onClick={() => setDeleteTarget(area)}
                        className="rounded p-1.5 text-muted-foreground hover:bg-rose-50 hover:text-rose-600 transition-colors"
                        title="Delete"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <AreaFormDialog
        open={addOpen}
        title="Add Area"
        initial={emptyForm}
        pending={pending}
        onClose={() => setAddOpen(false)}
        onSave={handleAdd}
      />

      <AreaFormDialog
        open={!!editTarget}
        title="Edit Area"
        initial={
          editTarget
            ? {
                name: editTarget.name,
                charge: String(editTarget.defaultDeliveryCharge),
                scheduleType: editTarget.scheduleType,
                scheduleInterval: editTarget.scheduleInterval,
                scheduleAnchor: editTarget.scheduleAnchor ?? "",
                customDates: editTarget.customDates,
              }
            : emptyForm
        }
        pending={pending}
        onClose={() => setEditTarget(null)}
        onSave={handleEdit}
      />

      <DeleteConfirm
        area={deleteTarget}
        pending={pending}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
      />
    </div>
  );
}

export function AreasClient({
  initialAreas,
  initialShifts,
  riders,
  canHandOver = false,
}: {
  initialAreas: AreaEntry[];
  initialShifts: ShiftEntry[];
  riders: RiderOption[];
  /** Admins may hand a round that is on the road to another rider. */
  canHandOver?: boolean;
}) {
  return (
    <Tabs defaultValue="areas" className="flex flex-col">
      <div className="border-b border-border px-4 sm:px-6 pt-3">
        <TabsList variant="line">
          <TabsTrigger value="areas">Areas</TabsTrigger>
          <TabsTrigger value="shifts">Shifts</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="areas">
        <AreasPanel initialAreas={initialAreas} />
      </TabsContent>
      <TabsContent value="shifts">
        <ShiftsClient
          initialShifts={initialShifts}
          riders={riders}
          canHandOver={canHandOver}
          areas={initialAreas}
        />
      </TabsContent>
    </Tabs>
  );
}

