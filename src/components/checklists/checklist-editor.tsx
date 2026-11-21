"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, X, GripVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  createChecklist,
  updateChecklist,
  type AssignableUser,
  type ChecklistView,
} from "@/app/(dashboard)/checklists/actions";

type ItemRow = { key: string; id?: string; label: string; dueTime: string };
let seq = 0;
const rowKey = () => `r${seq++}`;

export function ChecklistEditor({
  open,
  onClose,
  assignees,
  initial,
}: {
  open: boolean;
  onClose: () => void;
  assignees: AssignableUser[];
  initial?: ChecklistView | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const [title, setTitle] = useState(initial?.title ?? "");
  const [assigneeId, setAssigneeId] = useState(initial?.assigneeId ?? "");
  const [roleLabel, setRoleLabel] = useState(initial?.roleLabel ?? "");
  const [dueTime, setDueTime] = useState(initial?.dueTime ?? "10:00");
  const [items, setItems] = useState<ItemRow[]>(
    initial?.items.length
      ? initial.items.map((i) => ({ key: rowKey(), id: i.id, label: i.label, dueTime: i.dueTime ?? "" }))
      : [{ key: rowKey(), label: "", dueTime: "" }]
  );

  function setItem(key: string, patch: Partial<ItemRow>) {
    setItems((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }
  function addItem() {
    setItems((prev) => [...prev, { key: rowKey(), label: "", dueTime: "" }]);
  }
  function removeItem(key: string) {
    setItems((prev) => (prev.length > 1 ? prev.filter((r) => r.key !== key) : prev));
  }
  function move(key: string, dir: -1 | 1) {
    setItems((prev) => {
      const i = prev.findIndex((r) => r.key === key);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  function save() {
    const payload = {
      assigneeId,
      title,
      roleLabel: roleLabel || null,
      dueTime,
      items: items.map((r) => ({ id: r.id, label: r.label, dueTime: r.dueTime || null })),
    };
    start(async () => {
      const res = initial ? await updateChecklist(initial.id, payload) : await createChecklist(payload);
      if (res.ok) {
        toast.success(initial ? "Checklist updated." : "Checklist created.");
        onClose();
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{initial ? "Edit checklist" : "New checklist"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label className="text-xs">Title</Label>
            <Input className="mt-1" placeholder="e.g. Milking Operator Daily" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <Label className="text-xs">Assign to</Label>
              <Select value={assigneeId} onValueChange={setAssigneeId}>
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="Select a person" />
                </SelectTrigger>
                <SelectContent>
                  {assignees.map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {u.name} <span className="text-muted-foreground">· {u.roleLabel}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Due time (daily)</Label>
              <Input type="time" className="mt-1" value={dueTime} onChange={(e) => setDueTime(e.target.value)} />
            </div>
          </div>

          <div>
            <Label className="text-xs">Role label (optional)</Label>
            <Input className="mt-1" placeholder="e.g. Milking Operator" value={roleLabel} onChange={(e) => setRoleLabel(e.target.value)} />
            <p className="mt-1 text-[11px] text-muted-foreground">Shown as the job label; defaults to the person&apos;s role.</p>
          </div>

          <div>
            <Label className="text-xs">Checklist items</Label>
            <p className="mt-1 text-[11px] text-muted-foreground">
              A task time is optional. Missing it only marks that task red on the
              sheet — no alert is sent. Only the checklist due time above raises one.
            </p>
            <div className="mt-1 space-y-2">
              {items.map((r, i) => (
                <div key={r.key} className="flex items-center gap-1.5">
                  <div className="flex flex-col">
                    <button type="button" onClick={() => move(r.key, -1)} disabled={i === 0} className="text-muted-foreground hover:text-foreground disabled:opacity-25" title="Move up">
                      <GripVertical className="size-3.5" />
                    </button>
                  </div>
                  <Input
                    className="h-9 flex-1 text-sm"
                    placeholder={`Item ${i + 1}`}
                    value={r.label}
                    onChange={(e) => setItem(r.key, { label: e.target.value })}
                  />
                  <Input
                    type="time"
                    className="h-9 w-[7.5rem] shrink-0 text-sm"
                    title="Optional time for this task — late shows red, no alert"
                    value={r.dueTime}
                    onChange={(e) => setItem(r.key, { dueTime: e.target.value })}
                  />
                  <button
                    type="button"
                    onClick={() => removeItem(r.key)}
                    disabled={items.length === 1}
                    className="grid size-9 shrink-0 place-items-center rounded-md border border-border text-muted-foreground hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-30"
                    title="Remove"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
            <Button type="button" variant="outline" size="sm" className="mt-2 text-xs" onClick={addItem}>
              <Plus className="mr-1 size-3.5" /> Add item
            </Button>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={save} disabled={pending}>
            {pending ? "Saving…" : initial ? "Save changes" : "Create checklist"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
