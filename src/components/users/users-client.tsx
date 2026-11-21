"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Plus, KeyRound, Pencil, Trash2, ShieldCheck, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { ASSIGNABLE_ROLES, ROLE_LABELS } from "@/lib/access";
import {
  createUser, updateUser, resetUserPassword, setUserActive, removeUser,
  type UsersPageData, type UserRow,
} from "@/app/(dashboard)/users/actions";
import type { Role } from "@prisma/client";

// What each role can reach — shown on the form so the admin knows what they're
// handing out. Mirrors src/lib/access.ts.
const ROLE_ACCESS: Record<string, string> = {
  ADMIN: "Everything. Only an Admin can manage other Admins.",
  MANAGER: "Everything, except managing Admin accounts.",
  DOCTOR: "Production Reconciliation + Inventory Summary only.",
  PACKAGING: "Packaging, Wastage log, Waste entry, Rider item returns, Yogurt and Inventory Summary.",
  VAN_DRIVER: "Retail + Inventory Summary only. (Legacy role — no longer assignable.)",
};

const ROLE_PILL: Record<string, string> = {
  ADMIN: "bg-violet-100 text-violet-700",
  MANAGER: "bg-blue-100 text-blue-700",
  DOCTOR: "bg-emerald-100 text-emerald-700",
  PACKAGING: "bg-amber-100 text-amber-700",
  VAN_DRIVER: "bg-sky-100 text-sky-700",
};

export function UsersClient({ data }: { data: UsersPageData }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [addOpen, setAddOpen] = useState(false);
  const [editUser, setEditUser] = useState<UserRow | null>(null);
  const [pwUser, setPwUser] = useState<UserRow | null>(null);

  function act(fn: () => Promise<{ ok: true } | { ok: false; error: string }>, msg: string) {
    startTransition(async () => {
      const res = await fn();
      if (res.ok) {
        toast.success(msg);
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  // A Manager can't touch an Admin — the server enforces this too; this only
  // keeps the UI honest.
  const canTouch = (u: UserRow) => data.canManageAdmins || u.role !== "ADMIN";

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {data.canManageAdmins
            ? "You are an Admin — you can manage every account, including other Admins."
            : "You are a Manager — you can manage everyone except Admin accounts."}
        </p>
        <Button onClick={() => setAddOpen(true)} size="sm">
          <Plus className="mr-1.5 size-4" /> Add user
        </Button>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full border-collapse text-xs">
          <thead className="bg-muted/40">
            <tr>
              {["User", "Role", "Access", "Status", ""].map((h, i) => (
                <th
                  key={h || i}
                  className={cn(
                    "border-b border-border px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground whitespace-nowrap",
                    i === 4 ? "text-right" : "text-left"
                  )}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.users.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                  No users yet.
                </td>
              </tr>
            ) : (
              data.users.map((u) => (
                <tr key={u.id} className={cn("border-b border-border/50 hover:bg-muted/20", !u.active && "opacity-60")}>
                  <td className="px-3 py-2.5">
                    <p className="text-[13px] font-semibold">
                      {u.name}
                      {u.isSelf && <span className="ml-1.5 text-[10px] font-medium text-muted-foreground">(you)</span>}
                    </p>
                    <p className="text-[11px] text-muted-foreground">{u.email}</p>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold", ROLE_PILL[u.role] ?? "bg-slate-100 text-slate-600")}>
                      {u.roleLabel}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-[11px] text-muted-foreground">
                    {ROLE_ACCESS[u.role] ?? "—"}
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap">
                    {u.active ? (
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">Active</span>
                    ) : (
                      <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-semibold text-rose-700">Disabled</span>
                    )}
                    {!u.hasLogin && (
                      <span className="ml-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600">No login</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right whitespace-nowrap">
                    {canTouch(u) ? (
                      <div className="inline-flex gap-1">
                        <Button size="sm" variant="outline" className="h-7 text-[11px]" disabled={pending}
                          onClick={() => setEditUser(u)}>
                          <Pencil className="size-3" /> Edit
                        </Button>
                        <Button size="sm" variant="outline" className="h-7 text-[11px]" disabled={pending}
                          onClick={() => setPwUser(u)}>
                          <KeyRound className="size-3" /> Password
                        </Button>
                        <Button size="sm" variant="outline" className="h-7 text-[11px]" disabled={pending || u.isSelf}
                          onClick={() => act(() => setUserActive(u.id, !u.active), u.active ? "User disabled." : "User enabled.")}>
                          {u.active ? "Disable" : "Enable"}
                        </Button>
                        <Button size="sm" variant="outline" className="h-7 text-[11px] text-rose-600" disabled={pending || u.isSelf}
                          onClick={() => {
                            if (confirm(`Remove ${u.name}? Their login will be revoked immediately.`)) {
                              act(() => removeUser(u.id), "User removed.");
                            }
                          }}>
                          <Trash2 className="size-3" />
                        </Button>
                      </div>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                        <ShieldCheck className="size-3.5" /> Admin — protected
                      </span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {addOpen && (
        <UserFormDialog
          canManageAdmins={data.canManageAdmins}
          onClose={() => setAddOpen(false)}
          onDone={() => { setAddOpen(false); router.refresh(); }}
        />
      )}
      {editUser && (
        <UserFormDialog
          user={editUser}
          canManageAdmins={data.canManageAdmins}
          onClose={() => setEditUser(null)}
          onDone={() => { setEditUser(null); router.refresh(); }}
        />
      )}
      {pwUser && (
        <PasswordDialog
          user={pwUser}
          onClose={() => setPwUser(null)}
          onDone={() => { setPwUser(null); router.refresh(); }}
        />
      )}
    </div>
  );
}

// ── Add / edit ────────────────────────────────────────────────────────────────

function UserFormDialog({
  user, canManageAdmins, onClose, onDone,
}: {
  user?: UserRow;
  canManageAdmins: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const isEdit = !!user;
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [phone, setPhone] = useState(user?.phone ?? "");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>((user?.role as Role) ?? "MANAGER");

  // A Manager may not hand out the Admin role.
  const roles = ASSIGNABLE_ROLES.filter((r) => canManageAdmins || r !== "ADMIN");

  function submit() {
    startTransition(async () => {
      const res = isEdit
        ? await updateUser(user!.id, { name, phone, role })
        : await createUser({ name, email, password, role, phone });
      if (res.ok) {
        toast.success(isEdit ? "User updated." : "User created.");
        onDone();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit user" : "Add user"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Change their details or role. Use “Password” to set a new password."
              : "They will sign in with this email and password."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label>Name *</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" className="mt-1" />
          </div>
          <div>
            <Label>Email (username) *</Label>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="person@example.com"
              disabled={isEdit}
              className="mt-1"
            />
            {isEdit && <p className="mt-1 text-xs text-muted-foreground">Email can&rsquo;t be changed.</p>}
          </div>
          {!isEdit && (
            <div>
              <Label>Password *</Label>
              <Input
                type="text"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 6 characters"
                className="mt-1"
              />
            </div>
          )}
          <div>
            <Label>Phone</Label>
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Optional" className="mt-1" />
          </div>
          <div>
            <Label>Role *</Label>
            <Select value={role} onValueChange={(v) => setRole(v as Role)}>
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                {roles.map((r) => (
                  <SelectItem key={r} value={r}>{ROLE_LABELS[r]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="mt-1.5 rounded-md bg-muted/50 px-2 py-1.5 text-xs text-muted-foreground">
              {ROLE_ACCESS[role]}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={pending}>
            {pending ? <><Loader2 className="mr-1.5 size-4 animate-spin" /> Saving…</> : isEdit ? "Save" : "Create user"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Reset password ────────────────────────────────────────────────────────────

function PasswordDialog({
  user, onClose, onDone,
}: {
  user: UserRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [password, setPassword] = useState("");

  function submit() {
    startTransition(async () => {
      const res = await resetUserPassword(user.id, password);
      if (res.ok) {
        toast.success(`Password updated for ${user.name}.`);
        onDone();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Set a new password</DialogTitle>
          <DialogDescription>{user.name} · {user.email}</DialogDescription>
        </DialogHeader>
        <div>
          <Label>New password *</Label>
          <Input
            type="text"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 6 characters"
            className="mt-1"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={pending}>
            {pending ? <><Loader2 className="mr-1.5 size-4 animate-spin" /> Saving…</> : "Update password"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
