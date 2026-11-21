"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Pencil, UserCheck, UserX, Bike, Phone, Users, KeyRound, ShieldCheck, CreditCard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  createRider,
  updateRider,
  toggleRiderActive,
  type RiderEntry,
} from "@/app/(dashboard)/customers/riders/actions";

const AVATARS = [
  { bg: "bg-blue-100", tc: "text-blue-700" },
  { bg: "bg-rose-100", tc: "text-rose-700" },
  { bg: "bg-emerald-100", tc: "text-emerald-700" },
  { bg: "bg-violet-100", tc: "text-violet-700" },
  { bg: "bg-amber-100", tc: "text-amber-700" },
  { bg: "bg-orange-100", tc: "text-orange-700" },
];

function initials(name: string) {
  return name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

type RiderForm = { name: string; email: string; password: string; phone: string; vehicle: string; cnic: string; newPassword: string };
const emptyForm: RiderForm = { name: "", email: "", password: "", phone: "", vehicle: "", cnic: "", newPassword: "" };

function RiderFormDialog({
  open,
  title,
  initial,
  isEdit,
  pending,
  onClose,
  onSave,
}: {
  open: boolean;
  title: string;
  initial: RiderForm;
  isEdit: boolean;
  pending: boolean;
  onClose: () => void;
  onSave: (f: RiderForm) => void;
}) {
  const [form, setForm] = useState<RiderForm>(initial);
  const [showPass, setShowPass] = useState(false);

  function set(k: keyof RiderForm, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update rider details. Leave new password blank to keep it unchanged."
              : "Rider will use this email and password to log in."}
          </DialogDescription>
        </DialogHeader>
        {open && (
          <>
            <div className="space-y-3 py-1">
              <div>
                <Label>Full Name *</Label>
                <Input
                  className="mt-1"
                  placeholder="e.g. Arbaz Khan"
                  value={form.name}
                  onChange={(e) => set("name", e.target.value)}
                  autoFocus
                />
              </div>

              {!isEdit && (
                <div>
                  <Label>Email (login username) *</Label>
                  <Input
                    type="email"
                    className="mt-1"
                    placeholder="rider@example.com"
                    value={form.email}
                    onChange={(e) => set("email", e.target.value)}
                  />
                </div>
              )}

              <div>
                <Label>{isEdit ? "New Password" : "Password *"}</Label>
                <div className="mt-1 relative">
                  <Input
                    type={showPass ? "text" : "password"}
                    placeholder={isEdit ? "Leave blank to keep current" : "Min 6 characters"}
                    value={isEdit ? form.newPassword : form.password}
                    onChange={(e) => set(isEdit ? "newPassword" : "password", e.target.value)}
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPass((v) => !v)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                    tabIndex={-1}
                  >
                    <KeyRound className="size-3.5" />
                  </button>
                </div>
              </div>

              <div>
                <Label>Phone</Label>
                <Input
                  className="mt-1"
                  placeholder="0300-0000000"
                  value={form.phone}
                  onChange={(e) => set("phone", e.target.value)}
                />
              </div>
              <div>
                <Label>Vehicle</Label>
                <Input
                  className="mt-1"
                  placeholder="e.g. Honda CD-70, Motorcycle"
                  value={form.vehicle}
                  onChange={(e) => set("vehicle", e.target.value)}
                />
              </div>
              <div>
                <Label>CNIC</Label>
                <Input
                  className="mt-1"
                  placeholder="00000-0000000-0"
                  value={form.cnic}
                  onChange={(e) => set("cnic", e.target.value)}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={onClose} disabled={pending}>
                Cancel
              </Button>
              <Button onClick={() => onSave(form)} disabled={pending}>
                {pending ? "Saving…" : isEdit ? "Update" : "Create Rider"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function RidersClient({ initialRiders }: { initialRiders: RiderEntry[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [addOpen, setAddOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<RiderEntry | null>(null);

  function handleAdd(form: RiderForm) {
    startTransition(async () => {
      const res = await createRider({
        name: form.name,
        email: form.email,
        password: form.password,
        phone: form.phone,
        vehicle: form.vehicle,
        cnic: form.cnic,
      });
      if (res.ok) {
        toast.success("Rider added.");
        setAddOpen(false);
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  function handleEdit(form: RiderForm) {
    if (!editTarget) return;
    startTransition(async () => {
      const res = await updateRider(editTarget.id, {
        name: form.name,
        phone: form.phone,
        vehicle: form.vehicle,
        cnic: form.cnic,
        newPassword: form.newPassword || undefined,
      });
      if (res.ok) {
        toast.success("Rider updated.");
        setEditTarget(null);
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  function handleToggle(rider: RiderEntry) {
    startTransition(async () => {
      const res = await toggleRiderActive(rider.id);
      if (res.ok) {
        toast.success(rider.active ? "Rider deactivated." : "Rider activated.");
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  const active = initialRiders.filter((r) => r.active);
  const inactive = initialRiders.filter((r) => !r.active);

  return (
    <div className="p-4 sm:p-6 space-y-6">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4 text-sm text-muted-foreground">
          <span>
            <strong className="text-foreground">{active.length}</strong> active
          </span>
          {inactive.length > 0 && (
            <span>
              <strong className="text-foreground">{inactive.length}</strong> inactive
            </span>
          )}
        </div>
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus className="mr-1.5 size-4" />
          Add Rider
        </Button>
      </div>

      {/* Active riders */}
      {initialRiders.length === 0 ? (
        <div className="flex h-48 flex-col items-center justify-center gap-3 rounded-xl border border-dashed text-muted-foreground">
          <Bike className="size-7 opacity-40" />
          <p className="text-sm">No riders yet. Add your first delivery rider.</p>
          <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
            <Plus className="mr-1.5 size-4" />
            Add Rider
          </Button>
        </div>
      ) : (
        <div className="space-y-6">
          {active.length > 0 && (
            <div>
              <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Active Riders
              </p>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {active.map((rider, idx) => (
                  <RiderCard
                    key={rider.id}
                    rider={rider}
                    idx={idx}
                    pending={pending}
                    onEdit={() => setEditTarget(rider)}
                    onToggle={() => handleToggle(rider)}
                  />
                ))}
              </div>
            </div>
          )}

          {inactive.length > 0 && (
            <div>
              <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Inactive Riders
              </p>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {inactive.map((rider, idx) => (
                  <RiderCard
                    key={rider.id}
                    rider={rider}
                    idx={active.length + idx}
                    pending={pending}
                    onEdit={() => setEditTarget(rider)}
                    onToggle={() => handleToggle(rider)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <RiderFormDialog
        key={addOpen ? "add-open" : "add-closed"}
        open={addOpen}
        title="Add Rider"
        initial={emptyForm}
        isEdit={false}
        pending={pending}
        onClose={() => setAddOpen(false)}
        onSave={handleAdd}
      />

      <RiderFormDialog
        key={editTarget?.id ?? "edit-closed"}
        open={!!editTarget}
        title="Edit Rider"
        isEdit={true}
        initial={
          editTarget
            ? { name: editTarget.name, email: editTarget.email, password: "", phone: editTarget.phone ?? "", vehicle: editTarget.vehicle ?? "", cnic: editTarget.cnic ?? "", newPassword: "" }
            : emptyForm
        }
        pending={pending}
        onClose={() => setEditTarget(null)}
        onSave={handleEdit}
      />
    </div>
  );
}

function RiderCard({
  rider,
  idx,
  pending,
  onEdit,
  onToggle,
}: {
  rider: RiderEntry;
  idx: number;
  pending: boolean;
  onEdit: () => void;
  onToggle: () => void;
}) {
  const av = AVATARS[idx % AVATARS.length];

  return (
    <div
      className={`rounded-xl border border-border bg-card p-4 space-y-3 ${
        !rider.active ? "opacity-60" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-3">
          <div
            className={`size-10 rounded-full flex items-center justify-center text-sm font-semibold flex-shrink-0 ${av.bg} ${av.tc}`}
          >
            {initials(rider.name)}
          </div>
          <div>
            <p className="font-semibold text-sm leading-tight">{rider.name}</p>
            {rider.vehicle && (
              <p className="text-xs text-muted-foreground mt-0.5">{rider.vehicle}</p>
            )}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          {rider.hasAuth && (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
              <ShieldCheck className="size-3" /> Auth linked
            </span>
          )}
          {!rider.active && (
            <Badge variant="secondary" className="text-[10px]">Inactive</Badge>
          )}
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <KeyRound className="size-3" />
          {rider.email.includes("@farm.internal") ? "No login set" : rider.email}
        </div>
        {rider.phone && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Phone className="size-3" />
            {rider.phone}
          </div>
        )}
        {rider.cnic && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <CreditCard className="size-3" />
            {rider.cnic}
          </div>
        )}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Users className="size-3" />
          {rider.customerCount} customer{rider.customerCount !== 1 ? "s" : ""}
        </div>
        {rider.assignedShifts.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-0.5">
            {rider.assignedShifts.map((s) => (
              <span
                key={s}
                className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary"
              >
                {s}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 pt-1 border-t border-border">
        <Button
          size="sm"
          variant="outline"
          className="flex-1 h-7 text-xs"
          onClick={onEdit}
          disabled={pending}
        >
          <Pencil className="mr-1 size-3" />
          Edit
        </Button>
        <Button
          size="sm"
          variant="outline"
          className={`flex-1 h-7 text-xs ${
            rider.active
              ? "text-rose-600 hover:bg-rose-50 hover:border-rose-300"
              : "text-emerald-600 hover:bg-emerald-50 hover:border-emerald-300"
          }`}
          onClick={onToggle}
          disabled={pending}
        >
          {rider.active ? (
            <>
              <UserX className="mr-1 size-3" /> Deactivate
            </>
          ) : (
            <>
              <UserCheck className="mr-1 size-3" /> Activate
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
