"use client";

import { useState, useTransition, useMemo } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Pencil, Trash2, Clock, UserRound, Truck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  createShift,
  updateShift,
  deleteShift,
  handOverRound,
  type ShiftEntry,
  type ShiftType,
  type RiderOption,
} from "@/app/(dashboard)/customers/areas/actions";
import type { AreaEntry } from "@/app/(dashboard)/customers/areas/actions";

const TYPE_LABELS: Record<ShiftType, string> = {
  MORNING: "Morning",
  EVENING: "Evening",
  CUSTOM: "Custom",
};

const TYPE_COLORS: Record<ShiftType, string> = {
  MORNING: "bg-amber-100 text-amber-700",
  EVENING: "bg-indigo-100 text-indigo-700",
  CUSTOM: "bg-emerald-100 text-emerald-700",
};

type ShiftForm = {
  name: string;
  type: ShiftType;
  startTime: string;
  riderId: string;
  areaIds: string[];
};

const clockPKT = (iso: string) => new Date(iso).toLocaleTimeString("en-PK", { timeZone: "Asia/Karachi", hour: "numeric", minute: "2-digit" });

/** "On the road since 7:49 AM" — the shift is frozen until its round is finished. */
function OnRoadBadge({ shift }: { shift: ShiftEntry }) {
  if (!shift.onRoadSince) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800" title={`Loaded ${clockPKT(shift.onRoadSince)}${shift.onRoadBy ? ` by ${shift.onRoadBy}` : ""}. The shift cannot be changed until the round is finished.`}>
      <Truck className="size-3" /> On the road since {clockPKT(shift.onRoadSince)}
    </span>
  );
}

/** Admin only: give a round that is on the road to another rider, with a reason. */
function HandOverDialog({ shift, riders, pending, onClose, onConfirm }: {
  shift: ShiftEntry | null; riders: RiderOption[]; pending: boolean; onClose: () => void; onConfirm: (riderId: string, reason: string) => void;
}) {
  const [riderId, setRiderId] = useState("");
  const [reason, setReason] = useState("");
  if (!shift) return null;
  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Hand over {shift.name}</DialogTitle>
          <DialogDescription className="text-sm">
            This round is on the road{shift.onRoadBy ? ` with ${shift.onRoadBy}` : ""}. The round, its stops and its customers move to the rider you choose, on their phone and on the returns summary. The reason is kept in the audit log.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs">Rider taking over</Label>
            <Select value={riderId} onValueChange={setRiderId}>
              <SelectTrigger className="mt-1 h-9 text-sm"><SelectValue placeholder="Choose a rider" /></SelectTrigger>
              <SelectContent>
                {riders.filter((r) => r.id !== shift.riderId).map((r) => <SelectItem key={r.id} value={r.id} className="text-sm">{r.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Reason</Label>
            <Input className="mt-1 h-9 text-sm" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Zeeshan fell ill after loading" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button onClick={() => onConfirm(riderId, reason)} disabled={pending || !riderId || reason.trim().length < 3}>{pending ? "Handing over…" : "Hand over"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Customers on a round that is still running today are not moved — the rider
// carrying their milk would lose them from his app mid-round.
const heldNote = (n: number) =>
  `${n} customer${n === 1 ? " is" : "s are"} on a round still running today, so ${n === 1 ? "was" : "were"} not moved. Save this shift again once today's rounds are finished.`;

const emptyForm: ShiftForm = {
  name: "",
  type: "MORNING",
  startTime: "",
  riderId: "",
  areaIds: [],
};

function ShiftFormFields({
  initial,
  pending,
  areas,
  riders,
  onClose,
  onSave,
}: {
  initial: ShiftForm;
  pending: boolean;
  areas: AreaEntry[];
  riders: RiderOption[];
  onClose: () => void;
  onSave: (f: ShiftForm) => void;
}) {
  const [form, setForm] = useState<ShiftForm>(initial);

  function toggleArea(id: string) {
    setForm((f) => ({
      ...f,
      areaIds: f.areaIds.includes(id)
        ? f.areaIds.filter((a) => a !== id)
        : [...f.areaIds, id],
    }));
  }

  return (
    <>
      <div className="space-y-4 py-1">
        <div>
          <Label>Shift Name *</Label>
          <Input
            className="mt-1"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="e.g. Morning DHA"
            autoFocus
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Type</Label>
            <Select
              value={form.type}
              onValueChange={(v) => setForm((f) => ({ ...f, type: v as ShiftType }))}
            >
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="MORNING">Morning</SelectItem>
                <SelectItem value="EVENING">Evening</SelectItem>
                <SelectItem value="CUSTOM">Custom</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Start Time</Label>
            <Input
              type="time"
              className="mt-1"
              value={form.startTime}
              onChange={(e) => setForm((f) => ({ ...f, startTime: e.target.value }))}
            />
          </div>
        </div>

        <div>
          <Label>Rider (optional)</Label>
          <Select
            value={form.riderId || "none"}
            onValueChange={(v) => setForm((f) => ({ ...f, riderId: v === "none" ? "" : v }))}
          >
            <SelectTrigger className="mt-1">
              <SelectValue placeholder="No rider assigned" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No rider</SelectItem>
              {riders.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {areas.length > 0 && (
          <div>
            <Label className="mb-2 block">Areas covered</Label>
            <div className="rounded-lg border border-border max-h-44 overflow-y-auto divide-y divide-border">
              {areas.map((area) => (
                <label
                  key={area.id}
                  className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-muted/40 transition-colors"
                >
                  <Checkbox
                    checked={form.areaIds.includes(area.id)}
                    onCheckedChange={() => toggleArea(area.id)}
                  />
                  <span className="text-sm">{area.name}</span>
                </label>
              ))}
            </div>
            {form.areaIds.length > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                {form.areaIds.length} area{form.areaIds.length !== 1 ? "s" : ""} selected
              </p>
            )}
          </div>
        )}
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

function ShiftFormDialog({
  open,
  title,
  initial,
  pending,
  areas,
  riders,
  onClose,
  onSave,
}: {
  open: boolean;
  title: string;
  initial: ShiftForm;
  pending: boolean;
  areas: AreaEntry[];
  riders: RiderOption[];
  onClose: () => void;
  onSave: (f: ShiftForm) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Set the shift name, type, time, assign a rider, and pick which areas it covers.
          </DialogDescription>
        </DialogHeader>
        {open && (
          <ShiftFormFields
            key={initial.name + initial.type}
            initial={initial}
            pending={pending}
            areas={areas}
            riders={riders}
            onClose={onClose}
            onSave={onSave}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function DeleteShiftConfirm({
  shift,
  pending,
  onCancel,
  onConfirm,
}: {
  shift: ShiftEntry | null;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={!!shift} onOpenChange={(v) => !v && onCancel()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Delete shift?</DialogTitle>
          <DialogDescription>
            {shift && (
              <>
                <strong>&ldquo;{shift.name}&rdquo;</strong> will be permanently removed.
                {shift.customerCount > 0 && (
                  <span className="block mt-1 text-destructive">
                    {shift.customerCount} customer{shift.customerCount !== 1 ? "s are" : " is"} assigned to this shift — unassign them first.
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
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={pending || (shift?.customerCount ?? 0) > 0}
          >
            {pending ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ShiftsClient({
  initialShifts,
  riders,
  areas,
  canHandOver = false,
}: {
  initialShifts: ShiftEntry[];
  riders: RiderOption[];
  areas: AreaEntry[];
  canHandOver?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [handOverTarget, setHandOverTarget] = useState<ShiftEntry | null>(null);

  function handleHandOver(riderId: string, reason: string) {
    if (!handOverTarget) return;
    startTransition(async () => {
      const res = await handOverRound(handOverTarget.id, riderId, reason);
      if (res.ok) {
        toast.success(`${handOverTarget.name} handed over.`);
        setHandOverTarget(null);
        router.refresh();
      } else toast.error(res.error);
    });
  }

  // A shift on the road is frozen: say so instead of opening a dialog that will be refused.
  function tryEdit(shift: ShiftEntry) {
    if (shift.onRoadSince) { toast.warning(`${shift.name} is on the road since ${clockPKT(shift.onRoadSince)} — it can be changed once the round is finished.`); return; }
    setEditTarget(shift);
  }
  function tryDelete(shift: ShiftEntry) {
    if (shift.onRoadSince) { toast.warning(`${shift.name} is on the road — it can be deleted once the round is finished.`); return; }
    setDeleteTarget(shift);
  }

  const [addOpen, setAddOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ShiftEntry | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ShiftEntry | null>(null);

  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  function handleSort(key: string) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  }

  const sorted = useMemo(() => {
    if (!sortKey) return initialShifts;
    return [...initialShifts].sort((a, b) => {
      const av = (a as Record<string, unknown>)[sortKey];
      const bv = (b as Record<string, unknown>)[sortKey];
      if (typeof av === "number" && typeof bv === "number")
        return sortDir === "asc" ? av - bv : bv - av;
      const as_ = String(av ?? ""), bs_ = String(bv ?? "");
      return sortDir === "asc" ? as_.localeCompare(bs_) : bs_.localeCompare(as_);
    });
  }, [initialShifts, sortKey, sortDir]);

  function handleAdd(form: ShiftForm) {
    startTransition(async () => {
      const res = await createShift({
        name: form.name,
        type: form.type,
        startTime: form.startTime || null,
        riderId: form.riderId || null,
        areaIds: form.areaIds,
      });
      if (res.ok) {
        toast.success(res.moved ? `Shift added. ${res.moved} customer${res.moved === 1 ? "" : "s"} in its areas moved onto it.` : "Shift added.");
        if (res.held) toast.warning(heldNote(res.held), { duration: 12000 });
        setAddOpen(false);
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  function handleEdit(form: ShiftForm) {
    if (!editTarget) return;
    startTransition(async () => {
      const res = await updateShift(editTarget.id, {
        name: form.name,
        type: form.type,
        startTime: form.startTime || null,
        riderId: form.riderId || null,
        areaIds: form.areaIds,
      });
      if (res.ok) {
        toast.success(res.moved ? `Shift updated. ${res.moved} customer${res.moved === 1 ? "" : "s"} moved with their area.` : "Shift updated.");
        if (res.held) toast.warning(heldNote(res.held), { duration: 12000 });
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
      const res = await deleteShift(deleteTarget.id);
      if (res.ok) {
        toast.success("Shift deleted.");
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
          {initialShifts.length} shift{initialShifts.length !== 1 ? "s" : ""}
        </p>
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus className="mr-1.5 size-4" />
          Add Shift
        </Button>
      </div>

      {initialShifts.length === 0 ? (
        <div className="flex h-48 flex-col items-center justify-center gap-3 rounded-xl border border-dashed text-muted-foreground">
          <Clock className="size-7 opacity-40" />
          <p className="text-sm">No shifts yet. Add your first delivery shift.</p>
          <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
            <Plus className="mr-1.5 size-4" />
            Add Shift
          </Button>
        </div>
      ) : (
        <>
        {/* Mobile: stacked cards (the wide table would force horizontal scrolling) */}
        <div className="space-y-2 md:hidden">
          {sorted.map((shift) => (
            <div key={shift.id} className="rounded-xl border border-border bg-card p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium truncate">{shift.name}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${TYPE_COLORS[shift.type]}`}>
                      {TYPE_LABELS[shift.type]}
                    </span>
                    <OnRoadBadge shift={shift} />
                    {shift.startTime && (
                      <span className="tabular-nums text-xs text-muted-foreground">{shift.startTime}</span>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {canHandOver && shift.onRoadSince && (
                    <button onClick={() => setHandOverTarget(shift)} className="rounded p-1.5 text-amber-700 hover:bg-amber-50" title="Hand this round to another rider">
                      <Truck className="size-4" />
                    </button>
                  )}
                  <button onClick={() => tryEdit(shift)} className={`rounded p-1.5 ${shift.onRoadSince ? "text-muted-foreground/40" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`} title={shift.onRoadSince ? "On the road — cannot be changed now" : "Edit"}>
                    <Pencil className="size-4" />
                  </button>
                  <button onClick={() => tryDelete(shift)} className={`rounded p-1.5 ${shift.onRoadSince ? "text-muted-foreground/40" : "text-muted-foreground hover:bg-rose-50 hover:text-rose-600"}`} title={shift.onRoadSince ? "On the road — cannot be deleted now" : "Delete"}>
                    <Trash2 className="size-4" />
                  </button>
                </div>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                <div className="truncate">
                  <span className="text-muted-foreground">Rider: </span>
                  {shift.riderName ?? "—"}
                </div>
                <div className="text-right">
                  <span className="text-muted-foreground">Customers: </span>
                  {shift.customerCount}
                </div>
              </div>
              {shift.areaNames.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {shift.areaNames.map((a) => (
                    <span key={a} className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">{a}</span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Desktop: full table */}
        <div className="hidden overflow-x-auto rounded-xl border border-border md:block">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th
                  onClick={() => handleSort("name")}
                  className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
                >
                  <span className="inline-flex items-center gap-1">
                    Shift
                    <span className={sortKey === "name" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                      {sortKey === "name" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                    </span>
                  </span>
                </th>
                <th
                  onClick={() => handleSort("type")}
                  className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
                >
                  <span className="inline-flex items-center gap-1">
                    Type
                    <span className={sortKey === "type" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                      {sortKey === "type" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                    </span>
                  </span>
                </th>
                <th
                  onClick={() => handleSort("startTime")}
                  className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
                >
                  <span className="inline-flex items-center gap-1">
                    Time
                    <span className={sortKey === "startTime" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                      {sortKey === "startTime" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                    </span>
                  </span>
                </th>
                <th
                  onClick={() => handleSort("riderName")}
                  className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
                >
                  <span className="inline-flex items-center gap-1">
                    Rider
                    <span className={sortKey === "riderName" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                      {sortKey === "riderName" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                    </span>
                  </span>
                </th>
                <th
                  onClick={() => handleSort("areaNames")}
                  className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
                >
                  <span className="inline-flex items-center gap-1">
                    Areas
                    <span className={sortKey === "areaNames" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                      {sortKey === "areaNames" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
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
              {sorted.map((shift) => (
                <tr key={shift.id} className="hover:bg-muted/20">
                  <td className="px-4 py-3 font-medium">{shift.name}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${TYPE_COLORS[shift.type]}`}
                    >
                      {TYPE_LABELS[shift.type]}
                    </span>
                  </td>
                  <td className="px-4 py-3 tabular-nums text-muted-foreground">
                    {shift.startTime ?? "—"}
                  </td>
                  <td className="px-4 py-3">
                    {shift.riderName ? (
                      <span className="flex items-center gap-1.5 text-sm">
                        <UserRound className="size-3.5 text-muted-foreground" />
                        {shift.riderName}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {shift.areaNames.length === 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {shift.areaNames.map((a) => (
                          <span
                            key={a}
                            className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary"
                          >
                            {a}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right text-muted-foreground">
                    {shift.customerCount}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <OnRoadBadge shift={shift} />
                      {canHandOver && shift.onRoadSince && (
                        <button onClick={() => setHandOverTarget(shift)} className="rounded p-1.5 text-amber-700 hover:bg-amber-50 transition-colors" title="Hand this round to another rider">
                          <Truck className="size-3.5" />
                        </button>
                      )}
                      <button
                        onClick={() => tryEdit(shift)}
                        className={`rounded p-1.5 transition-colors ${shift.onRoadSince ? "text-muted-foreground/40" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
                        title={shift.onRoadSince ? "On the road — cannot be changed now" : "Edit"}
                      >
                        <Pencil className="size-3.5" />
                      </button>
                      <button
                        onClick={() => tryDelete(shift)}
                        className={`rounded p-1.5 transition-colors ${shift.onRoadSince ? "text-muted-foreground/40" : "text-muted-foreground hover:bg-rose-50 hover:text-rose-600"}`}
                        title={shift.onRoadSince ? "On the road — cannot be deleted now" : "Delete"}
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
        </>
      )}

      <ShiftFormDialog
        open={addOpen}
        title="Add Shift"
        initial={emptyForm}
        pending={pending}
        areas={areas}
        riders={riders}
        onClose={() => setAddOpen(false)}
        onSave={handleAdd}
      />

      <ShiftFormDialog
        open={!!editTarget}
        title="Edit Shift"
        initial={
          editTarget
            ? {
                name: editTarget.name,
                type: editTarget.type,
                startTime: editTarget.startTime ?? "",
                riderId: editTarget.riderId ?? "",
                areaIds: editTarget.areaIds,
              }
            : emptyForm
        }
        pending={pending}
        areas={areas}
        riders={riders}
        onClose={() => setEditTarget(null)}
        onSave={handleEdit}
      />

      <DeleteShiftConfirm
        shift={deleteTarget}
        pending={pending}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
      />
      <HandOverDialog shift={handOverTarget} riders={riders} pending={pending} onClose={() => setHandOverTarget(null)} onConfirm={handleHandOver} />
    </div>
  );
}

