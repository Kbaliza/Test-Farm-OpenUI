"use client";

import { useState, useMemo, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  ChevronLeft, ChevronRight, Bike, Search, CheckCheck, Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { STAFF_CATEGORIES, staffCategoryLabel } from "@/lib/staff-category";
import { todayPKTString } from "@/lib/pkt";
import {
  type AttendancePageData, type PersonRow, type AttendanceStatus, type HistoryDay,
  setAttendance,
  clearAttendance,
  markAttendanceBulk,
} from "@/app/(dashboard)/attendance/actions";

// ── Status config ───────────────────────────────────────────────────────────────

const STATUSES: {
  key: AttendanceStatus; label: string; short: string;
  active: string; idle: string;
}[] = [
  {
    key: "PRESENT", label: "Present", short: "P",
    active: "bg-emerald-600 text-white border-emerald-600",
    idle:   "text-emerald-700 hover:bg-emerald-50 border-border",
  },
  {
    key: "ABSENT", label: "Absent", short: "A",
    active: "bg-rose-600 text-white border-rose-600",
    idle:   "text-rose-700 hover:bg-rose-50 border-border",
  },
  {
    key: "HALF_DAY", label: "Half", short: "½",
    active: "bg-amber-500 text-white border-amber-500",
    idle:   "text-amber-700 hover:bg-amber-50 border-border",
  },
  {
    key: "HOLIDAY", label: "Holiday", short: "H",
    active: "bg-slate-500 text-white border-slate-500",
    idle:   "text-slate-600 hover:bg-slate-100 border-border",
  },
];

const AVATAR_PALETTE = [
  { bg: "bg-sky-100",     text: "text-sky-700"     },
  { bg: "bg-teal-100",    text: "text-teal-700"    },
  { bg: "bg-violet-100",  text: "text-violet-700"  },
  { bg: "bg-amber-100",   text: "text-amber-700"   },
  { bg: "bg-rose-100",    text: "text-rose-700"    },
  { bg: "bg-emerald-100", text: "text-emerald-700" },
];

function initials(name: string) {
  return name.split(" ").map((w) => w[0] ?? "").join("").slice(0, 2).toUpperCase();
}

function avatarColor(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
}

// ── Month calendar ────────────────────────────────────────────────────────────

const DAY_COLOR: Record<string, string> = {
  PRESENT:  "bg-emerald-500 text-white",
  ABSENT:   "bg-rose-500 text-white",
  HALF_DAY: "bg-amber-400 text-white",
  HOLIDAY:  "bg-slate-400 text-white",
};

const DAY_LABEL: Record<string, string> = {
  PRESENT: "Present", ABSENT: "Absent", HALF_DAY: "Half day", HOLIDAY: "Holiday",
};

// Mon-first weekday headers
const CAL_HEADERS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

function MonthCalendar({
  days, selectedDate, today, onDayClick,
}: {
  days: HistoryDay[];
  selectedDate: string;
  today: string;
  onDayClick?: (date: string) => void;
}) {
  if (days.length === 0) return null;

  // Derive year/month from first day
  const [y, m] = days[0].date.split("-").map(Number);
  const monthLabel = new Date(y, m - 1, 1).toLocaleString("default", { month: "short", year: "numeric" });

  // Monday-first offset of the 1st day
  const firstDow = new Date(y, m - 1, 1).getDay(); // 0=Sun
  const offset = (firstDow + 6) % 7; // Mon=0 … Sun=6

  // Build status lookup
  const statusByDate = new Map(days.map((d) => [d.date, d.status]));

  // Leading blank cells + day cells
  const cells: (number | null)[] = Array(offset).fill(null);
  for (let d = 1; d <= days.length; d++) cells.push(d);

  return (
    <div className="min-w-[168px]">
      <p className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground text-center">
        {monthLabel}
      </p>
      <div className="grid grid-cols-7 gap-px text-center">
        {CAL_HEADERS.map((h) => (
          <span key={h} className="text-[8px] leading-none text-muted-foreground pb-0.5">{h}</span>
        ))}
        {cells.map((day, i) => {
          if (day === null) return <span key={`b${i}`} />;
          const ds = `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
          const status = statusByDate.get(ds) ?? null;
          const isSel = ds === selectedDate;
          const isFuture = ds > today;
          const colorCls = status ? DAY_COLOR[status] : "";
          return (
            <div
              key={ds}
              title={`${ds}${status ? ` — ${DAY_LABEL[status]}` : ""}`}
              onClick={() => !isFuture && onDayClick?.(ds)}
              className={cn(
                "flex size-[22px] items-center justify-center rounded text-[9px] font-semibold leading-none mx-auto",
                isFuture
                  ? "text-muted-foreground/30"
                  : status
                    ? cn(colorCls, "cursor-pointer hover:opacity-80")
                    : "text-muted-foreground/50 border border-border cursor-pointer hover:bg-muted/40",
                isSel && "ring-2 ring-offset-1 ring-foreground/50"
              )}
            >
              {day}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Summary chip ────────────────────────────────────────────────────────────────

function SummaryChip({ label, value, cls }: { label: string; value: number; cls: string }) {
  return (
    <div className={cn("rounded-lg border p-3 text-center", cls)}>
      <p className="text-lg font-bold tabular-nums leading-none">{value}</p>
      <p className="mt-1 text-[11px] font-medium uppercase tracking-wide opacity-80">{label}</p>
    </div>
  );
}

// ── Person row ──────────────────────────────────────────────────────────────────

function PersonCard({
  person, onSet, pending, selectedDate, today, onDayClick,
}: {
  person: PersonRow;
  onSet: (id: string, status: AttendanceStatus) => void;
  pending: boolean;
  selectedDate: string;
  today: string;
  onDayClick: (date: string) => void;
}) {
  const av = avatarColor(person.name);
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-center gap-3">
        <div className={cn("flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold", av.bg, av.text)}>
          {initials(person.name)}
        </div>
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 truncate text-sm font-semibold">
            {person.name}
          </p>
          <div className="mt-0.5 flex items-center gap-1.5">
            {person.isRider ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                <Bike className="size-3" /> Rider
              </span>
            ) : null}
            {person.role && person.role !== "Rider" ? (
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                {person.role}
              </span>
            ) : null}
            {/* Which part of the business they work in (Staff page). Shown here so
                the filter above is something you can see, not just trust. */}
            <span
              className={cn(
                "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                person.category ? "bg-emerald-50 text-emerald-700" : "bg-muted text-muted-foreground",
              )}
            >
              {staffCategoryLabel(person.category)}
            </span>
            {person.status === null ? (
              <span
                className="rounded-full bg-yellow-100 px-1.5 py-0.5 text-[10px] font-medium text-yellow-700"
                title="Attendance for this day has not been marked yet"
              >
                Not marked today
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4 sm:shrink-0">
        {/* Month calendar */}
        <MonthCalendar
          days={person.history}
          selectedDate={selectedDate}
          today={today}
          onDayClick={onDayClick}
        />

        {/* Status toggles */}
        <div className="grid grid-cols-4 gap-1.5 sm:flex">
          {STATUSES.map((s) => {
            const active = person.status === s.key;
            return (
              <button
                key={s.key}
                type="button"
                disabled={pending}
                onClick={() => onSet(person.id, s.key)}
                title={active ? `${s.label} — tap again to unmark` : `Mark ${s.label.toLowerCase()}`}
                aria-pressed={active}
                className={cn(
                  "rounded-md border px-2.5 py-1.5 text-xs font-semibold transition-colors disabled:opacity-50",
                  active ? s.active : cn("bg-background", s.idle)
                )}
              >
                <span className="sm:hidden">{s.short}</span>
                <span className="hidden sm:inline">{s.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Main client ─────────────────────────────────────────────────────────────────

export function AttendanceClient({ initial }: { initial: AttendancePageData }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [people, setPeople] = useState<PersonRow[]>(initial.people);
  const [query, setQuery]   = useState("");
  // Category filter — "ALL" shows everyone, "NONE" those not given one yet.
  const [category, setCategory] = useState<string>("ALL");

  // Re-sync local state when the server sends fresh data (date change / refresh).
  // Adjusting state during render (instead of in an effect) is React's
  // recommended pattern for resetting state on a prop change.
  const [syncedFrom, setSyncedFrom] = useState(initial);
  if (syncedFrom !== initial) {
    setSyncedFrom(initial);
    setPeople(initial.people);
  }

  const isToday = initial.date === todayPKTString();

  // Notify the topbar quick-card to refresh its marked/total count.
  function notifyTopbar() {
    if (isToday && typeof window !== "undefined") {
      window.dispatchEvent(new Event("attendance:changed"));
    }
  }

  // Everyone in the chosen category. The counts, the list and "Mark remaining
  // present" all follow it, so filtering to Farm never marks someone in Retail.
  const inCategory = useMemo(
    () =>
      category === "ALL" ? people
      : category === "NONE" ? people.filter((p) => !p.category)
      : people.filter((p) => p.category === category),
    [people, category],
  );

  const summary = useMemo(() => ({
    total:    inCategory.length,
    present:  inCategory.filter((p) => p.status === "PRESENT").length,
    absent:   inCategory.filter((p) => p.status === "ABSENT").length,
    half:     inCategory.filter((p) => p.status === "HALF_DAY").length,
    holiday:  inCategory.filter((p) => p.status === "HOLIDAY").length,
    unmarked: inCategory.filter((p) => p.status === null).length,
  }), [inCategory]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return inCategory;
    return inCategory.filter((p) => p.name.toLowerCase().includes(q) || p.role.toLowerCase().includes(q));
  }, [inCategory, query]);

  // ── Navigation ──
  function go(dateStr: string) {
    // scroll: false, or Next scrolls to the top of the page on every date
    // change — and this is a real navigation, so that is its default. It
    // matters most for the per-person calendars further down: clicking a day on
    // someone's row halfway down the list threw you back to the top, away from
    // the person you were looking at.
    router.push(`/attendance?date=${dateStr}`, { scroll: false });
  }
  function shiftDate(delta: number) {
    const d = new Date(initial.date + "T12:00:00");
    d.setDate(d.getDate() + delta);
    go(format(d, "yyyy-MM-dd"));
  }

  const prettyDate = format(new Date(initial.date + "T12:00:00"), "EEE, dd MMM yyyy");

  // ── Mutations (optimistic) ──
  function patchHistory(history: HistoryDay[], date: string, status: AttendanceStatus | null): HistoryDay[] {
    return history.map((h) => h.date === date ? { ...h, status } : h);
  }

  /**
   * Tapping a status sets it; tapping the one already showing CLEARS it.
   *
   * Without the second half there was no way back from a mistaken tap — you
   * could change P to A, but never return the day to unmarked, and unmarked is
   * a real state here: the summary counts it, and the checklist penalty treats
   * an absent row differently from no row at all.
   */
  function setOne(id: string, status: AttendanceStatus) {
    const current = people.find((p) => p.id === id)?.status ?? null;
    const clearing = current === status;
    const next: AttendanceStatus | null = clearing ? null : status;

    setPeople((prev) => prev.map((p) =>
      p.id === id
        ? { ...p, status: next, history: patchHistory(p.history, initial.date, next) }
        : p
    ));
    startTransition(async () => {
      const res = clearing
        ? await clearAttendance(id, initial.date)
        : await setAttendance(id, initial.date, status);
      if (!res.ok) {
        toast.error(res.error);
        router.refresh(); // put back whatever the server actually has
      } else {
        notifyTopbar();
      }
    });
  }

  function markRemainingPresent() {
    const ids = inCategory.filter((p) => p.status === null).map((p) => p.id);
    if (ids.length === 0) {
      toast.info(category === "ALL" ? "Everyone is already marked." : "Everyone in this category is already marked.");
      return;
    }
    const idSet = new Set(ids);
    setPeople((prev) => prev.map((p) =>
      idSet.has(p.id)
        ? { ...p, status: "PRESENT", history: patchHistory(p.history, initial.date, "PRESENT") }
        : p
    ));
    startTransition(async () => {
      const res = await markAttendanceBulk(ids, initial.date, "PRESENT");
      if (res.ok) {
        toast.success(`Marked ${res.count} present`);
        notifyTopbar();
      } else {
        toast.error(res.error);
        router.refresh();
      }
    });
  }


  return (
    <div className="space-y-4 p-4 sm:p-6">
      {/* Date navigation + actions */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="icon" onClick={() => shiftDate(-1)} aria-label="Previous day">
            <ChevronLeft className="size-4" />
          </Button>
          <div className="flex flex-col items-center">
            <Input
              type="date"
              value={initial.date}
              onChange={(e) => e.target.value && go(e.target.value)}
              className="h-9 w-[150px] text-center"
            />
            <span className="mt-0.5 text-[11px] text-muted-foreground">{prettyDate}</span>
          </div>
          <Button type="button" variant="outline" size="icon" onClick={() => shiftDate(1)} aria-label="Next day">
            <ChevronRight className="size-4" />
          </Button>
          {!isToday ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => go(todayPKTString())}>
              Today
            </Button>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={markRemainingPresent} disabled={isPending}>
            <CheckCheck className="size-4" /> Mark remaining present
          </Button>
          <Link
            href="/staff"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-sm font-medium transition-colors hover:bg-muted"
          >
            <Users className="size-4" /> Manage staff
          </Link>
        </div>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <SummaryChip label="Total"    value={summary.total}    cls="bg-card text-foreground border-border" />
        <SummaryChip label="Present"  value={summary.present}  cls="bg-emerald-50 text-emerald-700 border-emerald-200" />
        <SummaryChip label="Absent"   value={summary.absent}   cls="bg-rose-50 text-rose-700 border-rose-200" />
        <SummaryChip label="Half"     value={summary.half}     cls="bg-amber-50 text-amber-700 border-amber-200" />
        <SummaryChip label="Holiday"  value={summary.holiday}  cls="bg-slate-50 text-slate-600 border-slate-200" />
        <SummaryChip label="Unmarked" value={summary.unmarked} cls="bg-yellow-50 text-yellow-700 border-yellow-200" />
      </div>

      {/* Category + search */}
      {people.length > 0 ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          {/* One pill per category, each carrying how many people are in it, so the
              split is visible without opening anything. */}
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by category">
            {[
              { id: "ALL", label: "All" },
              ...STAFF_CATEGORIES.map((c) => ({ id: c.id as string, label: c.label })),
              { id: "NONE", label: "Not set" },
            ].map(({ id, label }) => {
              const count =
                id === "ALL" ? people.length
                : id === "NONE" ? people.filter((p) => !p.category).length
                : people.filter((p) => p.category === id).length;
              const on = category === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setCategory(id)}
                  aria-pressed={on}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                    on
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground",
                    count === 0 && !on && "opacity-50",
                  )}
                >
                  {label}
                  <span className={cn("tabular-nums", on ? "text-primary-foreground/80" : "text-muted-foreground/70")}>{count}</span>
                </button>
              );
            })}
          </div>
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search employees or riders..."
              className="w-full pl-8 sm:max-w-xs"
            />
          </div>
        </div>
      ) : null}

      {/* People list */}
      {people.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          No employees or riders yet. Add riders in the Riders tab, or use
          the Staff page for other employees.
        </div>
      ) : filtered.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          {query.trim()
            ? <>No one matches &ldquo;{query}&rdquo;.</>
            : <>No one in {category === "NONE" ? "“Not set”" : staffCategoryLabel(category)} yet. Set categories on the Staff page.</>}
        </p>
      ) : (
        <div className="space-y-2">
          {filtered.map((p) => (
            <PersonCard
              key={p.id}
              person={p}
              onSet={setOne}
              pending={isPending}
              selectedDate={initial.date}
              today={todayPKTString()}
              onDayClick={go}
            />
          ))}
        </div>
      )}

    </div>
  );
}
