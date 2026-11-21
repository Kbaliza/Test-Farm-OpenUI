"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Pencil, Trash2, Send, AlertTriangle, ClipboardCheck, Clock, MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtTimePKT } from "@/lib/pkt";
import { Button } from "@/components/ui/button";
import { ChecklistEditor } from "./checklist-editor";
import {
  sendChecklistReminder,
  deleteChecklist,
  type ChecklistView,
  type AssignableUser,
} from "@/app/(dashboard)/checklists/actions";

function initials(n: string) {
  return n.replace(/^Dr\.\s*/, "").split(" ").slice(0, 2).map((w) => w[0] ?? "").join("").toUpperCase();
}
function tone(pct: number, overdue: boolean) {
  if (pct === 100) return "text-emerald-600";
  if (overdue) return "text-rose-600";
  return pct >= 50 ? "text-amber-600" : "text-rose-600";
}
function bar(pct: number, overdue: boolean) {
  if (pct === 100) return "bg-emerald-600";
  if (overdue) return "bg-rose-500";
  return pct >= 50 ? "bg-amber-500" : "bg-rose-500";
}

export function ChecklistsAdmin({ checklists, assignees }: { checklists: ChecklistView[]; assignees: AssignableUser[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [selectedId, setSelectedId] = useState<string | null>(checklists[0]?.id ?? null);
  const [editOpen, setEditOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ChecklistView | null>(null);

  const overall = useMemo(() => {
    const done = checklists.reduce((s, c) => s + c.done, 0);
    const total = checklists.reduce((s, c) => s + c.total, 0);
    return total ? Math.round((done / total) * 100) : 0;
  }, [checklists]);

  const detail = checklists.find((c) => c.id === selectedId) ?? null;

  function openNew() {
    setEditTarget(null);
    setEditOpen(true);
  }
  function openEdit(c: ChecklistView) {
    setEditTarget(c);
    setEditOpen(true);
  }
  function remind(c: ChecklistView) {
    start(async () => {
      const res = await sendChecklistReminder(c.id);
      res.ok ? toast.success(`Reminder queued for ${c.assigneeName}.`) : toast.error(res.error);
    });
  }
  function remove(c: ChecklistView) {
    if (!window.confirm(`Delete "${c.title}" (assigned to ${c.assigneeName})? This removes the checklist and its history.`)) return;
    start(async () => {
      const res = await deleteChecklist(c.id);
      if (res.ok) {
        toast.success("Checklist deleted.");
        if (selectedId === c.id) setSelectedId(null);
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {checklists.length} checklist{checklists.length !== 1 ? "s" : ""} assigned · <span className="font-semibold text-foreground">{overall}%</span> done today
        </p>
        <Button size="sm" onClick={openNew}>
          <Plus className="mr-1.5 size-4" /> New checklist
        </Button>
      </div>

      {checklists.length === 0 ? (
        <div className="flex h-48 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border text-muted-foreground">
          <ClipboardCheck className="size-8 opacity-30" />
          <p className="text-sm">No checklists yet. Create one and assign it to a person.</p>
          <Button size="sm" variant="outline" onClick={openNew}>
            <Plus className="mr-1.5 size-4" /> New checklist
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
          {/* Roster */}
          <ul className="space-y-2">
            {checklists.map((c) => (
              <li key={c.id}>
                <button
                  onClick={() => setSelectedId(c.id)}
                  className={cn(
                    "flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors",
                    c.id === selectedId ? "border-emerald-500 bg-emerald-50/50 dark:bg-emerald-950/20" : "border-border bg-card hover:bg-muted/40"
                  )}
                >
                  <span className="grid size-9 shrink-0 place-items-center rounded-full bg-[#13352b] text-xs font-semibold text-white">{initials(c.assigneeName)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-semibold">{c.assigneeName}</span>
                      {c.overdue && <AlertTriangle className="size-3.5 shrink-0 text-rose-500" />}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">{c.title} · due {c.dueTime}</span>
                    <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-muted">
                      <span className={cn("block h-full rounded-full", bar(c.pct, c.overdue))} style={{ width: `${c.pct}%` }} />
                    </span>
                  </span>
                  <span className={cn("shrink-0 font-mono text-xs font-semibold", tone(c.pct, c.overdue))}>{c.pct}%</span>
                </button>
              </li>
            ))}
          </ul>

          {/* Read-only detail */}
          {detail && (
            <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-lg font-semibold">{detail.title}</h2>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                    {detail.assigneeName} · {detail.assigneeRole} · <Clock className="size-3.5" /> due {detail.dueTime}
                    {detail.lastAt && <span>· last ticked {fmtTimePKT(detail.lastAt)}</span>}
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => remind(detail)} disabled={pending}>
                    <Send className="mr-1 size-3.5" /> Remind
                  </Button>
                  <button onClick={() => openEdit(detail)} className="grid size-8 place-items-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground" title="Edit">
                    <Pencil className="size-3.5" />
                  </button>
                  <button onClick={() => remove(detail)} className="grid size-8 place-items-center rounded-md border border-border text-muted-foreground hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600" title="Delete">
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              </div>

              <div className="mt-3 flex items-center gap-3">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <div className={cn("h-full rounded-full", bar(detail.pct, detail.overdue))} style={{ width: `${detail.pct}%` }} />
                </div>
                <span className={cn("font-mono text-sm font-semibold", tone(detail.pct, detail.overdue))}>
                  {detail.done}/{detail.total}
                </span>
              </div>

              <p className="mt-3 text-[11px] text-muted-foreground">Read-only — the tick is {detail.assigneeName}&apos;s own record. Use Remind to nudge a missed item.</p>

              <div className="mt-2 divide-y divide-border">
                {detail.items.map((it) => (
                  <div key={it.id} className="py-3">
                  <div className="flex items-center gap-3">
                    <span className={cn("grid size-5 shrink-0 place-items-center rounded-md border-2", it.done ? "border-emerald-600 bg-emerald-600 text-white" : "border-muted-foreground/30 text-transparent")}>
                      <ClipboardCheck className="size-3" />
                    </span>
                    <span className={cn("flex-1 text-sm", it.done && "text-muted-foreground line-through")}>
                      {it.label}
                      {it.dueTime && (
                        <span className={cn("ml-2 font-mono text-[11px]", it.late ? "text-rose-600" : "text-muted-foreground")}>
                          by {it.dueTime}
                          {it.late && (it.done ? " · late" : " · overdue")}
                        </span>
                      )}
                    </span>
                    <span className={cn("shrink-0 text-right font-mono text-[11px] leading-tight", it.late ? "text-rose-600" : it.done ? "text-emerald-600" : "text-muted-foreground")}>
                      {it.done && it.doneAt ? (
                        <>
                          <span className="block">{fmtTimePKT(it.doneAt)}</span>
                          {/* Who actually ticked it. Older rows predate the actor
                              being recorded, so fall back to nothing rather than
                              guessing it was the assignee. */}
                          {it.doneBy && (
                            <span className="block text-[10px] font-normal text-muted-foreground">{it.doneBy}</span>
                          )}
                        </>
                      ) : (
                        "pending"
                      )}
                    </span>
                  </div>
                  {/* What the person wanted you to know about this task today.
                      Read-only here — only the assignee can write or clear it. */}
                  {it.note && (
                    <div className="mt-2 ml-8 rounded-md border border-border bg-muted/40 px-2.5 py-1.5">
                      <p className="flex items-start gap-1.5 text-xs leading-snug whitespace-pre-wrap">
                        <MessageSquare className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
                        {it.note}
                      </p>
                      {it.noteBy && (
                        <p className="mt-0.5 pl-4.5 text-[10px] text-muted-foreground">— {it.noteBy}</p>
                      )}
                    </div>
                  )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {editOpen && (
        <ChecklistEditor open={editOpen} onClose={() => setEditOpen(false)} assignees={assignees} initial={editTarget} />
      )}
    </div>
  );
}
