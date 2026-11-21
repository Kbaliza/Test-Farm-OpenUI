"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Check, Clock, AlertTriangle, ClipboardCheck, MessageSquarePlus } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtTimePKT } from "@/lib/pkt";
import {
  toggleChecklistItem,
  setChecklistNote,
  type ChecklistView,
  type ChecklistItemView,
} from "@/app/(dashboard)/checklists/actions";
import { NOTE_MAX, normalizeNote } from "@/lib/checklist-note";

function pct(items: { done: boolean }[]) {
  const done = items.filter((i) => i.done).length;
  return { done, total: items.length, pct: items.length ? Math.round((done / items.length) * 100) : 0 };
}

function bandColor(p: number) {
  return p === 100 ? "bg-emerald-600" : p >= 50 ? "bg-amber-500" : "bg-rose-500";
}

// The optional remark on one task. Appears once the task is ticked, and stays
// visible afterwards if something was written — unticking must not silently throw
// away what the person wanted the manager to read.
function NoteBox({
  item,
  onSaved,
}: {
  item: ChecklistItemView;
  onSaved: (note: string | null) => void;
}) {
  const [open, setOpen] = useState(!!item.note);
  const [text, setText] = useState(item.note ?? "");
  const [saving, setSaving] = useState(false);
  const saved = normalizeNote(item.note);
  const dirty = normalizeNote(text) !== saved;

  async function save() {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      const res = await setChecklistNote(item.id, text);
      if (res.ok) {
        onSaved(res.note);
        if (res.note === null) setOpen(false);
      } else {
        toast.error(res.error);
      }
    } catch {
      toast.error("Couldn't save the note — please try again.");
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <MessageSquarePlus className="size-3.5" /> Add a note (optional)
      </button>
    );
  }

  return (
    <div className="mt-2">
      <textarea
        value={text}
        maxLength={NOTE_MAX}
        rows={2}
        disabled={saving}
        placeholder="Anything the manager should know about this task…"
        onChange={(e) => setText(e.target.value)}
        onBlur={save}
        className="w-full resize-y rounded-md border border-border bg-background px-2.5 py-1.5 text-xs leading-snug outline-none focus-visible:border-emerald-500 disabled:opacity-60"
      />
      <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
        <span>{saving ? "Saving…" : dirty ? "Not saved yet" : saved ? "Saved" : "Empty notes are removed"}</span>
        <span>{text.length}/{NOTE_MAX}</span>
      </div>
    </div>
  );
}

export function ChecklistsEmployee({ checklists: initial, compact }: { checklists: ChecklistView[]; compact?: boolean }) {
  const [lists, setLists] = useState(initial);
  // Track in-flight saves PER ITEM. A single shared "pending" flag disabled every
  // box while one was saving, so a quick second tick was swallowed until refresh.
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  function flip(listId: string, itemId: string) {
    setLists((prev) =>
      prev.map((l) =>
        l.id !== listId
          ? l
          : { ...l, items: l.items.map((it) => (it.id === itemId ? { ...it, done: !it.done, doneAt: !it.done ? new Date().toISOString() : null, doneBy: !it.done ? it.doneBy : null } : it)) }
      )
    );
  }

  // Restore an item to an exact prior state (used to revert on save failure — keeps
  // the original tick time instead of stamping a fresh one).
  function restore(listId: string, item: ChecklistItemView) {
    setLists((prev) =>
      prev.map((l) => (l.id !== listId ? l : { ...l, items: l.items.map((it) => (it.id === item.id ? { ...it, done: item.done, doneAt: item.doneAt } : it)) }))
    );
  }

  function setNote(listId: string, itemId: string, note: string | null) {
    setLists((prev) =>
      prev.map((l) =>
        l.id !== listId ? l : { ...l, items: l.items.map((it) => (it.id === itemId ? { ...it, note } : it)) }
      )
    );
  }

  async function toggle(listId: string, itemId: string) {
    if (busy[itemId]) return; // ignore re-taps on the SAME item while its save is in flight
    const prev = lists.find((l) => l.id === listId)?.items.find((it) => it.id === itemId);
    setBusy((b) => ({ ...b, [itemId]: true }));
    flip(listId, itemId); // optimistic — the UI updates instantly, other items stay tappable
    try {
      const res = await toggleChecklistItem(itemId);
      if (!res.ok) {
        toast.error(res.error);
        if (prev) restore(listId, prev); // revert to the exact prior state (original doneAt)
      }
    } catch {
      toast.error("Couldn't save — please try again.");
      if (prev) restore(listId, prev);
    } finally {
      setBusy((b) => {
        const next = { ...b };
        delete next[itemId];
        return next;
      });
    }
  }

  if (lists.length === 0) {
    return (
      <div className="flex h-48 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border text-muted-foreground">
        <ClipboardCheck className="size-8 opacity-30" />
        <p className="text-sm">No checklist assigned to you.</p>
      </div>
    );
  }

  return (
    <div className={cn("space-y-5", !compact && "mx-auto max-w-2xl")}>
      {lists.map((l) => {
        const s = pct(l.items);
        const allDone = s.total > 0 && s.done === s.total;
        return (
          <div key={l.id} className="overflow-hidden rounded-2xl border border-border bg-card">
            <div className="border-b border-border p-4 sm:p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate text-lg font-semibold sm:text-xl">{l.title}</h2>
                  <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Clock className="size-3.5" /> Due {l.dueTime}
                    {l.roleLabel && <span className="text-muted-foreground/70">· {l.roleLabel}</span>}
                  </p>
                </div>
                <div className={cn("shrink-0 text-2xl font-bold tabular-nums", s.pct === 100 ? "text-emerald-600" : s.pct >= 50 ? "text-amber-600" : "text-rose-600")}>
                  {s.pct}%
                </div>
              </div>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
                <div className={cn("h-full rounded-full transition-all", bandColor(s.pct))} style={{ width: `${s.pct}%` }} />
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">
                {allDone ? "All done — nice work" : `${s.done} of ${s.total} done · ${s.total - s.done} left`}
              </p>
              {l.overdue && !allDone && (
                <p className="mt-2 flex items-center gap-1.5 rounded-lg bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
                  <AlertTriangle className="size-3.5 shrink-0" /> Past due ({l.dueTime}) — please finish this.
                </p>
              )}
            </div>

            <div className="divide-y divide-border">
              {l.items.map((it) => (
                // The row is the tick target; the note sits beside it, outside the
                // button, so typing in it never toggles the task.
                <div key={it.id} className="px-4 py-3.5 sm:px-5">
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={it.done}
                  disabled={!!busy[it.id]}
                  onClick={() => toggle(l.id, it.id)}
                  className="flex w-full items-center gap-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-emerald-500 disabled:opacity-70"
                >
                  <span
                    className={cn(
                      "grid size-6 shrink-0 place-items-center rounded-md border-2 transition-colors",
                      it.done ? "border-emerald-600 bg-emerald-600 text-white" : "border-muted-foreground/40 text-transparent"
                    )}
                  >
                    <Check className="size-3.5" strokeWidth={3} />
                  </span>
                  <span className={cn("flex-1 text-sm leading-snug sm:text-[15px]", it.done && "text-muted-foreground line-through")}>
                    {it.label}
                    {it.dueTime && (
                      // Late is shown, never announced — no alert is raised for a
                      // task time, only for the checklist's own due time.
                      <span className={cn("ml-2 font-mono text-[11px]", it.late ? "text-rose-600" : "text-muted-foreground")}>
                        by {it.dueTime}
                        {it.late && (it.done ? " · late" : " · overdue")}
                      </span>
                    )}
                  </span>
                  {it.doneAt && (
                    <span className={cn("shrink-0 font-mono text-[11px]", it.late ? "text-rose-600" : "text-emerald-600")}>
                      {fmtTimePKT(it.doneAt)}
                    </span>
                  )}
                </button>
                {(it.done || it.note) && (
                  <div className="pl-9">
                    <NoteBox item={it} onSaved={(note) => setNote(l.id, it.id, note)} />
                  </div>
                )}
                </div>
              ))}
            </div>

            {allDone && (
              <div className="flex items-center justify-center gap-2 border-t border-border bg-emerald-50 py-3 text-sm font-semibold text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                <Check className="size-4" strokeWidth={3} /> Sheet complete for today
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
