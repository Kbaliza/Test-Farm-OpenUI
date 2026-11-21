"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Ban, Bike, Loader2, Pencil, Plus, RotateCcw, Search, Trash2, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { STAFF_CATEGORIES, staffCategoryLabel } from "@/lib/staff-category";
import { todayPKTString } from "@/lib/pkt";
import {
  createStaff,
  deleteStaff,
  setStaffActive,
  updateStaff,
  type LoginOption,
  type StaffInput,
  type StaffPageData,
  type StaffRow,
} from "@/app/(dashboard)/staff/actions";

/** Radix Select does not allow an empty value, so "not linked" needs its own. */
const NO_LOGIN = "__none__";
const NO_CATEGORY = "__no_category__";

type Tab = "active" | "disabled" | "all";

function money(n: number) {
  return `₨ ${Math.round(n).toLocaleString("en-PK")}`;
}
function pay(s: StaffRow) {
  return s.wageType === "fixed" ? `${money(s.baseSalary)} / month` : `${money(s.dailyWage)} / day`;
}
function joined(d: string) {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
/** "October" — the month a leaving date falls in, for the note under the field. */
function monthName(dateStr: string) {
  const [y, m] = dateStr.split("-").map(Number);
  if (!y || !m) return "that month";
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" });
}
function historyLine(s: StaffRow) {
  const h = s.history;
  const parts: string[] = [];
  if (h.attendance) parts.push(`${h.attendance} attendance day${h.attendance === 1 ? "" : "s"}`);
  if (h.payments) parts.push(`${h.payments} salary payment${h.payments === 1 ? "" : "s"}`);
  if (h.bonuses) parts.push(`${h.bonuses} bonus${h.bonuses === 1 ? "" : "es"}`);
  if (h.deductions) parts.push(`${h.deductions} deduction${h.deductions === 1 ? "" : "s"}`);
  if (h.penalties) parts.push(`${h.penalties} penalt${h.penalties === 1 ? "y" : "ies"}`);
  return parts.length ? parts.join(" · ") : "No records yet";
}
const hasHistory = (s: StaffRow) =>
  s.history.attendance + s.history.payments + s.history.bonuses + s.history.deductions + s.history.penalties > 0;

export function StaffClient({ data }: { data: StaffPageData }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [tab, setTab] = useState<Tab>("active");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<StaffRow | "new" | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "disable" | "enable" | "delete"; staff: StaffRow } | null>(null);
  // Their last working day. Asked for rather than assumed: the month someone
  // leaves in is theirs up to that day, and taking today for a person who stopped
  // coming a fortnight ago overpays them by a fortnight.
  const [leftAt, setLeftAt] = useState(todayPKTString());

  const counts = useMemo(() => ({
    active: data.staff.filter((s) => s.active).length,
    disabled: data.staff.filter((s) => !s.active).length,
    all: data.staff.length,
  }), [data.staff]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return data.staff.filter((s) => {
      if (tab === "active" && !s.active) return false;
      if (tab === "disabled" && s.active) return false;
      if (!q) return true;
      return s.name.toLowerCase().includes(q) || s.role.toLowerCase().includes(q) || (s.linkedLogin ?? "").toLowerCase().includes(q);
    });
  }, [data.staff, tab, query]);

  function runConfirm() {
    const c = confirm;
    if (!c) return;
    start(async () => {
      const res =
        c.kind === "delete"
          ? await deleteStaff(c.staff.id)
          : await setStaffActive(c.staff.id, c.kind === "enable", c.kind === "disable" ? leftAt : undefined);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(
        c.kind === "delete" ? `${c.staff.name} deleted.` : c.kind === "disable" ? `${c.staff.name} disabled.` : `${c.staff.name} is active again.`
      );
      setConfirm(null);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-1.5">
          {(["active", "disabled", "all"] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn(
                "rounded-md border px-3 py-1.5 text-xs font-medium transition",
                tab === t ? "border-foreground bg-foreground text-background" : "border-border bg-background hover:bg-muted"
              )}
            >
              {t === "active" ? "Active" : t === "disabled" ? "Disabled" : "All"} ({counts[t]})
            </button>
          ))}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, role or login…" className="h-9 pl-8 sm:w-64" />
          </div>
          <Button type="button" onClick={() => setEditing("new")}>
            <Plus className="size-4" /> Add staff
          </Button>
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
          {data.staff.length === 0 ? "No staff yet. Use “Add staff” to add someone." : "No staff match this view."}
        </p>
      ) : (
        <div className="divide-y divide-border rounded-xl border border-border bg-card">
          {visible.map((s) => (
            <div key={s.id} className={cn("flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between", !s.active && "bg-muted/30")}>
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className={cn("font-semibold", !s.active && "text-muted-foreground")}>{s.name}</span>
                  {s.isRider && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-semibold text-sky-700">
                      <Bike className="size-3" /> Rider
                    </span>
                  )}
                  {!s.active && (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">Disabled</span>
                  )}
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[10px] font-semibold",
                      s.category ? "bg-emerald-50 text-emerald-700" : "bg-muted text-muted-foreground",
                    )}
                  >
                    {staffCategoryLabel(s.category)}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {s.role || "No role"} · {pay(s)} · joined {joined(s.joinedAt)}
                </p>
                <p className="flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <UserRound className="size-3" /> {s.linkedLogin ? `Login: ${s.linkedLogin}` : "No login linked"}
                  </span>
                  <span>· {historyLine(s)}</span>
                </p>
              </div>

              <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                <Button type="button" variant="outline" size="sm" onClick={() => setEditing(s)}>
                  <Pencil className="size-3.5" /> Edit
                </Button>
                {s.isRider && s.active ? (
                  <Link href="/customers/riders" className="px-2 text-[11px] text-muted-foreground underline-offset-2 hover:underline">
                    Turn off on Riders page
                  </Link>
                ) : s.active ? (
                  <Button type="button" variant="outline" size="sm" onClick={() => { setLeftAt(todayPKTString()); setConfirm({ kind: "disable", staff: s }); }}>
                    <Ban className="size-3.5" /> Disable
                  </Button>
                ) : (
                  <Button type="button" variant="outline" size="sm" onClick={() => setConfirm({ kind: "enable", staff: s })}>
                    <RotateCcw className="size-3.5" /> Enable
                  </Button>
                )}
                {!s.isRider && !hasHistory(s) && (
                  <Button type="button" variant="ghost" size="sm" className="text-rose-600 hover:text-rose-700" onClick={() => setConfirm({ kind: "delete", staff: s })}>
                    <Trash2 className="size-3.5" /> Delete
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="text-[11px] text-muted-foreground">
        Delete is only shown for staff with no attendance or salary records. Everyone else can be disabled instead —
        their records stay, and you can enable them again any time.
      </p>

      {editing && (
        <StaffEditor
          key={editing === "new" ? "new" : editing.id}
          staff={editing === "new" ? null : editing}
          logins={data.logins}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); router.refresh(); }}
        />
      )}

      <Dialog open={!!confirm} onOpenChange={(o) => { if (!o && !pending) setConfirm(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {confirm?.kind === "delete" ? `Delete ${confirm.staff.name}?` : confirm?.kind === "disable" ? `Disable ${confirm?.staff.name}?` : `Enable ${confirm?.staff.name}?`}
            </DialogTitle>
            <DialogDescription>
              {confirm?.kind === "delete"
                ? "They have no attendance or salary records, so they will be removed completely. This cannot be undone."
                : confirm?.kind === "disable"
                  ? "They will no longer show on Attendance, Salaries, Daily Expenses or Tasks. All their records — attendance, salary payments, bonuses and deductions — are kept. You can enable them again any time."
                  : "They will show again on Attendance, Salaries, Daily Expenses and Tasks."}
            </DialogDescription>
          </DialogHeader>

          {confirm?.kind === "disable" && (
            <div className="space-y-1.5">
              <Label className="text-xs" htmlFor="left-at">Last working day</Label>
              <input
                id="left-at"
                type="date"
                value={leftAt}
                min={confirm.staff.joinedAt}
                max={todayPKTString()}
                onChange={(e) => setLeftAt(e.target.value)}
                className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
              />
              <p className="text-[11px] text-muted-foreground">
                They are paid up to this day — a wage worker for the days worked, a fixed
                salary pro rata. The rest of {monthName(leftAt)} is marked absent.
              </p>
            </div>
          )}

          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => setConfirm(null)} disabled={pending}>Cancel</Button>
            <Button
              type="button"
              variant={confirm?.kind === "delete" ? "destructive" : "default"}
              onClick={runConfirm}
              disabled={pending || (confirm?.kind === "disable" && !leftAt)}
            >
              {pending && <Loader2 className="size-4 animate-spin" />}
              {confirm?.kind === "delete" ? "Delete" : confirm?.kind === "disable" ? "Disable" : "Enable"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StaffEditor({
  staff,
  logins,
  onClose,
  onSaved,
}: {
  staff: StaffRow | null;
  logins: LoginOption[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [pending, start] = useTransition();
  // Seeded once per open (the parent keys this component), so no effect is needed.
  const [name, setName] = useState(staff?.name ?? "");
  const [role, setRole] = useState(staff?.role ?? "");
  const [wageType, setWageType] = useState<"fixed" | "daily">(staff?.wageType ?? "daily");
  const [wage, setWage] = useState(staff ? String(staff.wageType === "fixed" ? staff.baseSalary : staff.dailyWage) : "");
  const [joinedAt, setJoinedAt] = useState(staff?.joinedAt ?? "");
  const [linked, setLinked] = useState(staff?.userId ?? NO_LOGIN);
  const [category, setCategory] = useState(staff?.category ?? NO_CATEGORY);
  const isRider = !!staff?.isRider;
  // Adding a rider from here: the app login goes with the staff record.
  const [makeRider, setMakeRider] = useState(false);
  const [riderEmail, setRiderEmail] = useState("");
  const [riderPassword, setRiderPassword] = useState("");
  const [riderPhone, setRiderPhone] = useState("");
  const [riderVehicle, setRiderVehicle] = useState("");

  function save() {
    if (!staff && makeRider) {
      if (!riderEmail.trim()) { toast.error("Enter the email the rider will log in with."); return; }
      if (riderPassword.length < 6) { toast.error("The rider's password must be at least 6 characters."); return; }
    }
    const input: StaffInput = {
      name,
      role,
      wageType,
      wage: wage === "" ? 0 : Number(wage),
      joinedAt,
      userId: linked === NO_LOGIN ? null : linked,
      category: category === NO_CATEGORY ? null : category,
      rider: !staff && makeRider ? { email: riderEmail, password: riderPassword, phone: riderPhone, vehicle: riderVehicle } : null,
    };
    start(async () => {
      const res = staff ? await updateStaff(staff.id, input) : await createStaff(input);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(staff ? "Changes saved." : "Staff member added.");
      onSaved();
    });
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !pending) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{staff ? `Edit ${staff.name}` : "Add staff member"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs">Name</Label>
            <Input className="mt-1" value={name} onChange={(e) => setName(e.target.value)} disabled={isRider} placeholder="Full name" />
            {isRider && <p className="mt-1 text-[11px] text-muted-foreground">This is a rider — change the name on the Riders page.</p>}
          </div>
          <div>
            <Label className="text-xs">Category</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_CATEGORY}>— Not set —</SelectItem>
                {STAFF_CATEGORIES.map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="mt-1 text-[11px] text-muted-foreground">Used to filter the Attendance page.</p>
          </div>
          <div>
            <Label className="text-xs">Role</Label>
            <Input className="mt-1" value={role} onChange={(e) => setRole(e.target.value)} placeholder="e.g. Farm worker, Cleaner, Office" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Pay type</Label>
              <Select value={wageType} onValueChange={(v) => setWageType(v as "fixed" | "daily")}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">Daily wage</SelectItem>
                  <SelectItem value="fixed">Monthly salary</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">{wageType === "fixed" ? "Salary per month (₨)" : "Wage per day (₨)"}</Label>
              <Input className="mt-1 text-right" type="number" min="0" value={wage} onChange={(e) => setWage(e.target.value)} placeholder="0" />
            </div>
          </div>
          <div>
            <Label className="text-xs">Join date</Label>
            <Input className="mt-1" type="date" value={joinedAt} onChange={(e) => setJoinedAt(e.target.value)} />
            {!staff && <p className="mt-1 text-[11px] text-muted-foreground">Leave empty for today.</p>}
          </div>
          {!staff && (
            <div className="rounded-lg border border-border bg-muted/20 p-3">
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input type="checkbox" className="size-4" checked={makeRider} onChange={(e) => setMakeRider(e.target.checked)} />
                Give this person a rider login (delivery app)
              </label>
              {makeRider && (
                <div className="mt-3 space-y-3">
                  <p className="text-[11px] text-muted-foreground">Makes the login and the rider together with this staff record — the same as adding them on the Riders page.</p>
                  <div>
                    <Label className="text-xs">Login email</Label>
                    <Input className="mt-1" type="email" value={riderEmail} onChange={(e) => setRiderEmail(e.target.value)} placeholder="rider@example.com" autoComplete="off" />
                  </div>
                  <div>
                    <Label className="text-xs">Password</Label>
                    <Input className="mt-1" type="password" value={riderPassword} onChange={(e) => setRiderPassword(e.target.value)} placeholder="At least 6 characters" autoComplete="new-password" />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label className="text-xs">Phone</Label>
                      <Input className="mt-1" value={riderPhone} onChange={(e) => setRiderPhone(e.target.value)} placeholder="Optional" />
                    </div>
                    <div>
                      <Label className="text-xs">Vehicle</Label>
                      <Input className="mt-1" value={riderVehicle} onChange={(e) => setRiderVehicle(e.target.value)} placeholder="Optional" />
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
          <div>
            <Label className="text-xs">Linked login</Label>
            <Select value={linked} onValueChange={setLinked} disabled={isRider || makeRider}>
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_LOGIN}>— Not linked —</SelectItem>
                {logins.map((l) => {
                  const taken = !!l.linkedTo && l.id !== staff?.userId;
                  return (
                    <SelectItem key={l.id} value={l.id} disabled={taken}>
                      {l.name}{taken ? ` — linked to ${l.linkedTo}` : ""}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {isRider
                ? "A rider is linked to their login automatically."
                : "Link the person's login so their checklist penalties come off this salary."}
            </p>
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button type="button" onClick={save} disabled={pending}>
            {pending && <Loader2 className="size-4 animate-spin" />}
            {staff ? "Save changes" : makeRider ? "Add staff and rider login" : "Add staff"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
