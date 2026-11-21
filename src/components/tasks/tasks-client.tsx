"use client";

import { useState, useTransition, useMemo } from "react";
import { toast } from "sonner";
import {
  ChevronDown, ChevronUp, Trash2, Plus, ListChecks, User, X, Search,
  AlertTriangle, Clock, CheckCircle2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  getTasks,
  createTask,
  updateTaskStatus,
  deleteTask,
  addTaskFollowup,
  type TaskEntry,
  type AssigneeOption,
} from "@/app/(dashboard)/tasks/actions";

// ── constants ─────────────────────────────────────────────────────────────────

const STATUS_OPTIONS = [
  { value: "PENDING",     label: "Pending" },
  { value: "IN_PROGRESS", label: "In Progress" },
  { value: "COMPLETED",   label: "Completed" },
];

const STATUS_STYLE: Record<string, string> = {
  PENDING:     "bg-amber-50 text-amber-700",
  IN_PROGRESS: "bg-sky-50 text-sky-700",
  COMPLETED:   "bg-emerald-50 text-emerald-700",
};

const PRIORITY_STYLE: Record<string, string> = {
  HIGH:    "bg-amber-100 text-amber-800",
  EXTREME: "bg-rose-100 text-rose-800",
};

// ── helpers ───────────────────────────────────────────────────────────────────

function fmtDeadline(iso: string) {
  return new Date(iso).toLocaleString("en-GB", {
    timeZone: "Asia/Karachi",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", {
    timeZone: "Asia/Karachi",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// datetime-local default: now + 1 day, in PKT, without calling Date during render
function defaultDeadline() {
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
  // Render as PKT local datetime-local value (YYYY-MM-DDTHH:mm)
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Karachi",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

// ── Assignee combobox (searchable) ─────────────────────────────────────────────

function AssigneeCombobox({
  assignees,
  value,
  onChange,
}: {
  assignees: AssigneeOption[];
  value: AssigneeOption | null;
  onChange: (a: AssigneeOption | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? assignees.filter(
          (a) => a.name.toLowerCase().includes(q) || a.role.toLowerCase().includes(q)
        )
      : assignees;
    return list.slice(0, 50);
  }, [assignees, query]);

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
            {value ? value.name : "Assign to employee…"}
          </span>
          {value ? (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); onChange(null); }}
              className="ml-auto rounded p-0.5 hover:bg-muted"
              aria-label="Clear assignee"
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
            placeholder="Search employees or riders…"
            className="h-8 pl-7 text-xs"
          />
        </div>
        <div className="max-h-60 overflow-y-auto p-1">
          {matches.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs text-muted-foreground">
              No staff found.
            </p>
          ) : (
            matches.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => { onChange(a); setOpen(false); setQuery(""); }}
                className={cn(
                  "flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted",
                  value?.id === a.id && "bg-muted"
                )}
              >
                <span className="truncate font-medium">{a.name}</span>
                {a.role ? <span className="shrink-0 text-[10px] text-muted-foreground">{a.role}</span> : null}
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ── Add task form ──────────────────────────────────────────────────────────────

function AddTaskForm({
  onAdded,
  assignees,
}: {
  onAdded: () => void;
  assignees: AssigneeOption[];
}) {
  const [pending, startTransition] = useTransition();
  const [text, setText] = useState("");
  const [assignee, setAssignee] = useState<AssigneeOption | null>(null);
  const [deadline, setDeadline] = useState(defaultDeadline);
  const [priority, setPriority] = useState("NORMAL");
  const [author, setAuthor] = useState("Admin");

  function handleSubmit() {
    if (!text.trim()) { toast.error("Describe the task first."); return; }
    if (!assignee) { toast.error("Choose who to assign it to."); return; }
    if (!deadline) { toast.error("Set a deadline."); return; }
    startTransition(async () => {
      const res = await createTask({
        title: text,
        assigneeId: assignee.id,
        assigneeName: assignee.name,
        deadline,
        priority,
        authorName: author,
      });
      if (res.ok) {
        toast.success("Task assigned.");
        setText("");
        setAssignee(null);
        setPriority("NORMAL");
        setDeadline(defaultDeadline());
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
        placeholder="What needs to be done? e.g. Collect cash from Block C customers"
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="resize-none text-sm"
      />
      <div className="flex flex-wrap items-end gap-2">
        {/* Assignee */}
        <div>
          <Label className="text-xs text-muted-foreground mb-1 block">Assign to</Label>
          <AssigneeCombobox assignees={assignees} value={assignee} onChange={setAssignee} />
        </div>

        {/* Deadline */}
        <div>
          <Label className="text-xs text-muted-foreground mb-1 block">Deadline</Label>
          <input
            type="datetime-local"
            value={deadline}
            onChange={(e) => setDeadline(e.target.value)}
            className="h-8 rounded-md border border-border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
          />
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
          {pending ? "Assigning…" : "Assign task"}
        </Button>
      </div>
    </div>
  );
}

// ── Task card ────────────────────────────────────────────────────────────────

function TaskCard({
  task,
  onStatusChange,
  onDelete,
  onFollowupAdded,
}: {
  task: TaskEntry;
  onStatusChange: (id: string, status: string) => void;
  onDelete: (id: string) => void;
  onFollowupAdded: (taskId: string, followup: TaskEntry["followups"][0]) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [fuText, setFuText] = useState("");
  const [pending, startTransition] = useTransition();

  const ss = STATUS_STYLE[task.status] ?? STATUS_STYLE.PENDING;
  const ps = task.priority !== "NORMAL" ? PRIORITY_STYLE[task.priority] : null;
  const bar = task.isOverdue
    ? "bg-rose-500"
    : task.status === "COMPLETED"
      ? "bg-emerald-500"
      : task.status === "IN_PROGRESS"
        ? "bg-sky-500"
        : "bg-amber-500";

  function handleStatusChange(val: string) {
    startTransition(async () => {
      const res = await updateTaskStatus(task.id, val);
      if (res.ok) onStatusChange(task.id, val);
      else toast.error(res.error);
    });
  }

  function handleDelete() {
    startTransition(async () => {
      const res = await deleteTask(task.id);
      if (res.ok) onDelete(task.id);
      else toast.error(res.error);
    });
  }

  function handleAddFollowup() {
    if (!fuText.trim()) return;
    startTransition(async () => {
      const res = await addTaskFollowup(task.id, fuText);
      if (res.ok) {
        onFollowupAdded(task.id, {
          id: `tmp-${task.followups.length}`,
          body: fuText.trim(),
          createdAt: new Date().toISOString(),
        });
        setFuText("");
        toast.success("Update added.");
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <div className={cn(
      "rounded-lg border bg-card overflow-hidden hover:shadow-sm transition-shadow",
      task.isOverdue ? "border-rose-200" : "border-border"
    )}>
      <div className="flex items-stretch gap-0">
        {/* Status colour bar */}
        <div className={`w-1 flex-shrink-0 ${bar}`} />

        <div className="flex-1 px-3 py-2.5 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1 min-w-0">
              {/* Task text */}
              <p className={cn(
                "text-sm font-medium leading-snug mb-1.5",
                task.status === "COMPLETED" && "text-muted-foreground line-through"
              )}>
                {task.title}
              </p>

              {/* Meta row */}
              <div className="flex flex-wrap items-center gap-1.5">
                {/* Assignee */}
                <span className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2 py-0.5 text-[10px] font-semibold text-violet-700">
                  <User className="size-2.5" />
                  {task.assigneeName}
                </span>

                {/* Deadline / overdue */}
                {task.isOverdue ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-bold text-rose-700">
                    <AlertTriangle className="size-2.5" />
                    Missed · {fmtDeadline(task.deadline)}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600">
                    <Clock className="size-2.5" />
                    Due {fmtDeadline(task.deadline)}
                  </span>
                )}

                {ps && (
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${ps}`}>
                    {task.priority === "EXTREME" ? "!! Extreme" : "! High"}
                  </span>
                )}

                {/* Inline status select */}
                <select
                  value={task.status}
                  onChange={(e) => handleStatusChange(e.target.value)}
                  disabled={pending}
                  className={`rounded-full border-0 px-2 py-0.5 text-[10px] font-medium focus:outline-none cursor-pointer ${ss}`}
                >
                  {STATUS_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>

                <span className="text-[10px] text-muted-foreground">
                  by {task.authorName}
                </span>
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-1 flex-shrink-0">
              <button
                onClick={() => setExpanded((v) => !v)}
                className="size-6 flex items-center justify-center rounded border border-border bg-muted/40 text-muted-foreground hover:bg-muted transition-colors"
                title={expanded ? "Collapse" : "Updates"}
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

      {/* Expandable updates / follow-up section */}
      {expanded && (
        <div className="border-t border-border bg-muted/20 px-4 py-3 space-y-3">
          {task.followups.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                Progress log
              </p>
              <div className="space-y-1">
                {task.followups.map((f) => (
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
              Add an update
            </p>
            <div className="flex gap-2">
              <Textarea
                rows={1}
                className="resize-none text-xs flex-1 h-8 py-1.5"
                placeholder="e.g. Called rider, will finish by evening…"
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

// ── Main client ────────────────────────────────────────────────────────────────

export function TasksClient({
  initialTasks,
  assignees,
}: {
  initialTasks: TaskEntry[];
  assignees: AssigneeOption[];
}) {
  const [tasks, setTasks] = useState<TaskEntry[]>(initialTasks);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState(""); // "" | OPEN | OVERDUE | COMPLETED | <assigneeName>
  const [refreshing, startRefresh] = useTransition();

  // Tell the topbar bell to refresh its overdue count.
  function notifyTopbar() {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event("tasks:changed"));
    }
  }

  function refresh() {
    startRefresh(async () => {
      const { tasks: fresh } = await getTasks();
      setTasks(fresh);
      notifyTopbar();
    });
  }

  function handleStatusChange(id: string, status: string) {
    setTasks((prev) =>
      prev.map((t) =>
        t.id === id
          ? { ...t, status, isOverdue: status === "COMPLETED" ? false : t.isOverdue }
          : t
      )
    );
    notifyTopbar();
  }

  function handleDelete(id: string) {
    setTasks((prev) => prev.filter((t) => t.id !== id));
    notifyTopbar();
  }

  function handleFollowupAdded(taskId: string, followup: TaskEntry["followups"][0]) {
    setTasks((prev) =>
      prev.map((t) =>
        t.id === taskId ? { ...t, followups: [...t.followups, followup] } : t
      )
    );
  }

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return tasks.filter((t) => {
      if (filter === "OPEN" && t.status === "COMPLETED") return false;
      if (filter === "OVERDUE" && !t.isOverdue) return false;
      if (filter === "COMPLETED" && t.status !== "COMPLETED") return false;
      if (
        q &&
        !t.title.toLowerCase().includes(q) &&
        !t.assigneeName.toLowerCase().includes(q)
      )
        return false;
      return true;
    });
  }, [tasks, search, filter]);

  const summary = useMemo(() => {
    let open = 0, overdue = 0, completed = 0;
    for (const t of tasks) {
      if (t.status === "COMPLETED") completed++;
      else open++;
      if (t.isOverdue) overdue++;
    }
    return { total: tasks.length, open, overdue, completed };
  }, [tasks]);

  const FILTERS = [
    { value: "",          label: "All" },
    { value: "OPEN",      label: "Open" },
    { value: "OVERDUE",   label: "Missed" },
    { value: "COMPLETED", label: "Completed" },
  ];

  return (
    <div className="space-y-4 p-4 sm:p-6">
      {/* Add task form */}
      <AddTaskForm onAdded={refresh} assignees={assignees} />

      {/* Summary chips */}
      {tasks.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <div className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium">
            <ListChecks className="size-3 text-muted-foreground" />
            Total: {summary.total}
          </div>
          <div className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium">
            <Clock className="size-3 text-amber-500" />
            Open: {summary.open}
          </div>
          <div className={cn(
            "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium",
            summary.overdue > 0 ? "border-rose-200 bg-rose-50 text-rose-700" : "border-border bg-card"
          )}>
            <AlertTriangle className="size-3" />
            Missed: {summary.overdue}
          </div>
          <div className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium">
            <CheckCircle2 className="size-3 text-emerald-600" />
            Completed: {summary.completed}
          </div>
        </div>
      )}

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card px-4 py-3">
        <Input
          placeholder="Search tasks or employee…"
          className="h-8 w-full sm:w-56 text-xs"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={`rounded-full border px-3 py-1 text-[11px] font-medium transition-colors ${
                filter === f.value
                  ? "border-foreground bg-foreground text-background"
                  : "border-border text-muted-foreground hover:bg-muted/40"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {filtered.length} task{filtered.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Task list */}
      {refreshing ? (
        <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
          Loading…
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex h-40 flex-col items-center justify-center gap-3 rounded-xl border border-dashed text-muted-foreground">
          <ListChecks className="size-7 opacity-40" />
          <p className="text-sm">
            {tasks.length === 0
              ? "No tasks yet. Assign one above."
              : "No tasks match your filters."}
          </p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {filtered.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
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
