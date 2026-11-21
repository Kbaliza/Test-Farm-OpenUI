"use client";

import { useState, useTransition, useMemo } from "react";
import { toast } from "sonner";
import { ChevronDown, ChevronUp, Trash2, Plus, StickyNote, User, X, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { todayPKTString } from "@/lib/pkt";
import {
  getDailyNotes,
  createNote,
  updateNoteStatus,
  deleteNote,
  addFollowup,
  type NoteEntry,
  type CustomerOption,
} from "@/app/(dashboard)/daily-notes/actions";

// ── constants ─────────────────────────────────────────────────────────────────

const TYPE_OPTIONS = [
  { value: "ORDER_CHANGE", label: "Order Change" },
  { value: "TASK",         label: "Task" },
  { value: "COMPLAINT",    label: "Complaint" },
  { value: "TEMP_STOP",    label: "Temporary Stop" },
  { value: "DESI_GHEE",    label: "Desi Ghee" },
  { value: "DESI_EGGS",    label: "Desi Eggs" },
  { value: "BILL_ISSUE",   label: "Bill Issue" },
  { value: "REQUEST",      label: "Request" },
  { value: "NOTE",         label: "Note" },
];

const STATUS_OPTIONS = [
  { value: "PENDING",         label: "Pending" },
  { value: "IN_PROGRESS",     label: "In Progress" },
  { value: "SOLVED",          label: "Solved" },
  { value: "TASK_COMPLETED",  label: "Task Completed" },
];

const TYPE_STYLE: Record<string, { pill: string; bar: string }> = {
  ORDER_CHANGE: { pill: "bg-blue-50 text-blue-700",    bar: "bg-blue-500" },
  TASK:         { pill: "bg-emerald-50 text-emerald-700", bar: "bg-emerald-500" },
  COMPLAINT:    { pill: "bg-orange-50 text-orange-700", bar: "bg-orange-500" },
  TEMP_STOP:    { pill: "bg-rose-50 text-rose-700",     bar: "bg-rose-500" },
  DESI_GHEE:    { pill: "bg-amber-50 text-amber-700",   bar: "bg-amber-500" },
  DESI_EGGS:    { pill: "bg-yellow-50 text-yellow-700", bar: "bg-yellow-500" },
  BILL_ISSUE:   { pill: "bg-red-50 text-red-700",       bar: "bg-red-500" },
  REQUEST:      { pill: "bg-violet-50 text-violet-700", bar: "bg-violet-500" },
  NOTE:         { pill: "bg-slate-100 text-slate-600",  bar: "bg-slate-400" },
};

const STATUS_STYLE: Record<string, string> = {
  PENDING:        "bg-amber-50 text-amber-700",
  IN_PROGRESS:    "bg-slate-100 text-slate-600",
  SOLVED:         "bg-emerald-50 text-emerald-700",
  TASK_COMPLETED: "bg-blue-50 text-blue-700",
};

const PRIORITY_STYLE: Record<string, string> = {
  HIGH:    "bg-amber-100 text-amber-800",
  EXTREME: "bg-rose-100 text-rose-800",
};

const DOT_COLOR: Record<string, string> = {
  ORDER_CHANGE: "bg-blue-500",
  TASK:         "bg-emerald-500",
  COMPLAINT:    "bg-orange-500",
  TEMP_STOP:    "bg-rose-500",
  DESI_GHEE:    "bg-amber-500",
  DESI_EGGS:    "bg-yellow-500",
  BILL_ISSUE:   "bg-red-500",
  REQUEST:      "bg-violet-500",
  NOTE:         "bg-slate-400",
};

// ── helpers ───────────────────────────────────────────────────────────────────

function labelOf(options: { value: string; label: string }[], v: string) {
  return options.find((o) => o.value === v)?.label ?? v;
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", {
    timeZone: "Asia/Karachi",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ── Customer combobox (searchable) ────────────────────────────────────────────

function CustomerCombobox({
  customers,
  value,
  onChange,
}: {
  customers: CustomerOption[];
  value: CustomerOption | null;
  onChange: (c: CustomerOption | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? customers.filter(
          (c) => c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q)
        )
      : customers;
    return list.slice(0, 50);
  }, [customers, query]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex h-8 min-w-44 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-xs",
            value ? "text-foreground" : "text-muted-foreground"
          )}
        >
          <User className="size-3.5 shrink-0 opacity-60" />
          <span className="truncate">
            {value ? `${value.name} (${value.code})` : "Link a customer…"}
          </span>
          {value ? (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); onChange(null); }}
              className="ml-auto rounded p-0.5 hover:bg-muted"
              aria-label="Clear customer"
            >
              <X className="size-3" />
            </span>
          ) : (
            <ChevronDown className="ml-auto size-3 opacity-60" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <div className="relative border-b border-border p-2">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or code…"
            className="h-8 pl-7 text-xs"
          />
        </div>
        <div className="max-h-60 overflow-y-auto p-1">
          {matches.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs text-muted-foreground">
              No customers found.
            </p>
          ) : (
            matches.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => { onChange(c); setOpen(false); setQuery(""); }}
                className={cn(
                  "flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted",
                  value?.id === c.id && "bg-muted"
                )}
              >
                <span className="truncate font-medium">{c.name}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground">{c.code}</span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ── Add note form ─────────────────────────────────────────────────────────────

function AddNoteForm({
  onAdded,
  customers,
}: {
  onAdded: () => void;
  customers: CustomerOption[];
}) {
  const [pending, startTransition] = useTransition();
  const [text, setText] = useState("");
  const [type, setType] = useState("ORDER_CHANGE");
  const [status, setStatus] = useState("PENDING");
  const [priority, setPriority] = useState("NORMAL");
  const [author, setAuthor] = useState("Admin");
  const [customer, setCustomer] = useState<CustomerOption | null>(null);

  function handleSubmit() {
    if (!text.trim()) { toast.error("Enter a note first."); return; }
    startTransition(async () => {
      const res = await createNote({
        title: text, type, status, priority, authorName: author,
        customerId: customer?.id ?? null,
      });
      if (res.ok) {
        toast.success("Note added.");
        setText("");
        setPriority("NORMAL");
        setCustomer(null);
        onAdded();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-3">
      <Textarea
        rows={2}
        placeholder="Write a note, order change, task, complaint…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="resize-none text-sm"
      />
      <div className="flex flex-wrap items-end gap-2">
        {/* Type */}
        <div>
          <Label className="text-xs text-muted-foreground mb-1 block">Type</Label>
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="h-8 rounded-md border border-border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
          >
            {TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>

        {/* Customer */}
        <div>
          <Label className="text-xs text-muted-foreground mb-1 block">Customer</Label>
          <CustomerCombobox customers={customers} value={customer} onChange={setCustomer} />
        </div>

        {/* Status */}
        <div>
          <Label className="text-xs text-muted-foreground mb-1 block">Status</Label>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="h-8 rounded-md border border-border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
          >
            {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>

        {/* Priority */}
        <div>
          <Label className="text-xs text-muted-foreground mb-1 block">Priority</Label>
          <div className="flex rounded-md border border-border bg-muted/40 p-0.5 gap-0.5">
            {["NORMAL", "HIGH", "EXTREME"].map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPriority(p)}
                className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors ${
                  priority === p
                    ? "bg-card shadow-sm text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {p === "NORMAL" ? "Normal" : p === "HIGH" ? "High" : "Extreme"}
              </button>
            ))}
          </div>
        </div>

        {/* Author */}
        <div>
          <Label className="text-xs text-muted-foreground mb-1 block">By</Label>
          <Input
            className="h-8 w-28 text-xs"
            placeholder="Your name"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
          />
        </div>

        <Button size="sm" className="h-8 ml-auto" onClick={handleSubmit} disabled={pending}>
          <Plus className="mr-1 size-3.5" />
          {pending ? "Adding…" : "Add note"}
        </Button>
      </div>
    </div>
  );
}

// ── Note card ─────────────────────────────────────────────────────────────────

function NoteCard({
  note,
  onStatusChange,
  onDelete,
  onFollowupAdded,
}: {
  note: NoteEntry;
  onStatusChange: (id: string, status: string) => void;
  onDelete: (id: string) => void;
  onFollowupAdded: (noteId: string, followup: NoteEntry["followups"][0]) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [fuText, setFuText] = useState("");
  const [pending, startTransition] = useTransition();

  const ts = TYPE_STYLE[note.type] ?? TYPE_STYLE.NOTE;
  const ss = STATUS_STYLE[note.status] ?? STATUS_STYLE.PENDING;
  const ps = note.priority !== "NORMAL" ? PRIORITY_STYLE[note.priority] : null;

  function handleStatusChange(val: string) {
    startTransition(async () => {
      const res = await updateNoteStatus(note.id, val);
      if (res.ok) onStatusChange(note.id, val);
      else toast.error(res.error);
    });
  }

  function handleDelete() {
    startTransition(async () => {
      const res = await deleteNote(note.id);
      if (res.ok) onDelete(note.id);
      else toast.error(res.error);
    });
  }

  function handleAddFollowup() {
    if (!fuText.trim()) return;
    startTransition(async () => {
      const res = await addFollowup(note.id, fuText);
      if (res.ok) {
        onFollowupAdded(note.id, {
          id: Date.now().toString(),
          body: fuText.trim(),
          createdAt: new Date().toISOString(),
        });
        setFuText("");
        toast.success("Follow-up added.");
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden hover:shadow-sm transition-shadow">
      <div className="flex items-stretch gap-0">
        {/* Type colour bar */}
        <div className={`w-1 flex-shrink-0 ${ts.bar}`} />

        <div className="flex-1 px-3 py-2.5 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1 min-w-0">
              {/* Note text */}
              <p className="text-sm font-medium leading-snug mb-1.5">{note.title}</p>

              {/* Meta row */}
              <div className="flex flex-wrap items-center gap-1.5">
                {ps && (
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${ps}`}>
                    {note.priority === "EXTREME" ? "!! Extreme" : "! High"}
                  </span>
                )}
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${ts.pill}`}>
                  {labelOf(TYPE_OPTIONS, note.type)}
                </span>

                {/* Inline status select */}
                <select
                  value={note.status}
                  onChange={(e) => handleStatusChange(e.target.value)}
                  disabled={pending}
                  className={`rounded-full border-0 px-2 py-0.5 text-[10px] font-medium focus:outline-none cursor-pointer ${ss}`}
                >
                  {STATUS_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>

                {note.customerName ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2 py-0.5 text-[10px] font-semibold text-sky-700">
                    <User className="size-2.5" />
                    {note.customerName}
                  </span>
                ) : null}

                <span className="text-[10px] text-muted-foreground">
                  {fmtTime(note.date)} · {note.authorName}
                </span>
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-1 flex-shrink-0">
              <button
                onClick={() => setExpanded((v) => !v)}
                className="size-6 flex items-center justify-center rounded border border-border bg-muted/40 text-muted-foreground hover:bg-muted transition-colors"
                title={expanded ? "Collapse" : "Follow-ups"}
              >
                {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
              </button>
              <button
                onClick={handleDelete}
                disabled={pending}
                className="size-6 flex items-center justify-center rounded border border-border bg-muted/40 text-muted-foreground hover:bg-rose-50 hover:text-rose-600 hover:border-rose-200 transition-colors"
                title="Delete"
              >
                <Trash2 className="size-3" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Expandable follow-up section */}
      {expanded && (
        <div className="border-t border-border bg-muted/20 px-4 py-3 space-y-3">
          {note.followups.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                Follow-up log
              </p>
              <div className="space-y-1">
                {note.followups.map((f) => (
                  <div key={f.id} className="flex items-start justify-between border-b border-border/60 pb-1 last:border-0 last:pb-0">
                    <span className="text-xs text-foreground/80">{f.body}</span>
                    <span className="text-[10px] text-muted-foreground ml-3 shrink-0">{fmtTime(f.createdAt)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
              Add follow-up
            </p>
            <div className="flex gap-2">
              <Textarea
                rows={1}
                className="resize-none text-xs flex-1 h-8 py-1.5"
                placeholder="Add a follow-up or update…"
                value={fuText}
                onChange={(e) => setFuText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleAddFollowup();
                  }
                }}
              />
              <Button size="sm" className="h-8 shrink-0" onClick={handleAddFollowup} disabled={pending}>
                Add
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main client ───────────────────────────────────────────────────────────────

export function DailyNotesClient({
  initialNotes,
  customers,
}: {
  initialNotes: NoteEntry[];
  customers: CustomerOption[];
}) {
  const [notes, setNotes] = useState<NoteEntry[]>(initialNotes);
  const [date, setDate] = useState(todayPKTString());
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [loadingDate, startDateTransition] = useTransition();

  function handleDateChange(d: string) {
    setDate(d);
    startDateTransition(async () => {
      const { notes: n } = await getDailyNotes(d);
      setNotes(n);
    });
  }

  function handleNoteAdded() {
    startDateTransition(async () => {
      const { notes: fresh } = await getDailyNotes(date);
      setNotes(fresh);
    });
  }

  function handleStatusChange(id: string, status: string) {
    setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, status } : n)));
  }

  function handleDelete(id: string) {
    setNotes((prev) => prev.filter((n) => n.id !== id));
  }

  function handleFollowupAdded(
    noteId: string,
    followup: NoteEntry["followups"][0]
  ) {
    setNotes((prev) =>
      prev.map((n) =>
        n.id === noteId ? { ...n, followups: [...n.followups, followup] } : n
      )
    );
  }

  // Client-side filtering (search + type only; date is server-fetched)
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return notes.filter((n) => {
      if (typeFilter === "PENDING" && n.status !== "PENDING") return false;
      if (typeFilter && typeFilter !== "PENDING" && n.type !== typeFilter) return false;
      if (
        q &&
        !n.title.toLowerCase().includes(q) &&
        !(n.customerName?.toLowerCase().includes(q) ?? false)
      )
        return false;
      return true;
    });
  }, [notes, search, typeFilter]);

  // Summary from all loaded notes (before search/type filter)
  const summary = useMemo(() => {
    const counts: Record<string, number> = {};
    let pending = 0;
    for (const n of notes) {
      counts[n.type] = (counts[n.type] ?? 0) + 1;
      if (n.status === "PENDING") pending++;
    }
    return { total: notes.length, pending, counts };
  }, [notes]);

  const TYPE_FILTERS = [
    { value: "",          label: "All" },
    { value: "ORDER_CHANGE", label: "Order Changes" },
    { value: "TASK",      label: "Tasks" },
    { value: "COMPLAINT", label: "Complaints" },
    { value: "TEMP_STOP", label: "Stops" },
    { value: "PENDING",   label: "Pending" },
  ];

  return (
    <div className="space-y-4 p-4 sm:p-6">
      {/* Add note form */}
      <AddNoteForm onAdded={handleNoteAdded} customers={customers} />

      {/* Summary chips */}
      {notes.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <div className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium">
            <span className="size-1.5 rounded-full bg-emerald-600" />
            Total: {summary.total}
          </div>
          <div className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium">
            <span className="size-1.5 rounded-full bg-amber-500" />
            Pending: {summary.pending}
          </div>
          {TYPE_OPTIONS.map((t) =>
            summary.counts[t.value] ? (
              <div
                key={t.value}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium"
              >
                <span className={`size-1.5 rounded-full ${DOT_COLOR[t.value]}`} />
                {t.label}: {summary.counts[t.value]}
              </div>
            ) : null
          )}
        </div>
      )}

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card px-4 py-3">
        <Input
          placeholder="Search notes or customer…"
          className="h-8 w-full sm:w-56 text-xs"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <input
          type="date"
          value={date}
          onChange={(e) => handleDateChange(e.target.value)}
          className="h-8 rounded-md border border-border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <div className="flex flex-wrap gap-1.5">
          {TYPE_FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setTypeFilter(f.value)}
              className={`rounded-full border px-3 py-1 text-[11px] font-medium transition-colors ${
                typeFilter === f.value
                  ? "border-foreground bg-foreground text-background"
                  : "border-border text-muted-foreground hover:bg-muted/40"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {filtered.length} note{filtered.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Notes list */}
      {loadingDate ? (
        <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
          Loading…
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex h-40 flex-col items-center justify-center gap-3 rounded-xl border border-dashed text-muted-foreground">
          <StickyNote className="size-7 opacity-40" />
          <p className="text-sm">
            {notes.length === 0
              ? "No notes for this day yet."
              : "No notes match your filters."}
          </p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {filtered.map((note) => (
            <NoteCard
              key={note.id}
              note={note}
              onStatusChange={handleStatusChange}
              onDelete={handleDelete}
              onFollowupAdded={handleFollowupAdded}
            />
          ))}
        </div>
      )}
    </div>
  );
}
