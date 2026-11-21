"use client";

import { useMemo, useState, useTransition } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Check, StickyNote, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import {
  getChecklistHistory,
  type ChecklistHistoryData,
  type ChecklistHistoryDay,
} from "@/app/(dashboard)/checklists/actions";

/** "YYYY-MM-DD" → a UTC-noon Date, matching how the day keys are stored. */
function parseDay(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
}
function toDay(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DOW = ["M", "T", "W", "T", "F", "S", "S"];

function prettyDay(s: string): string {
  const d = parseDay(s);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0, 3)} ${d.getUTCFullYear()}`;
}
function prettyTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", {
    timeZone: "Asia/Karachi", hour: "2-digit", minute: "2-digit",
  });
}

export function ChecklistHistory({ initial }: { initial: ChecklistHistoryData }) {
  const [data, setData] = useState(initial);
  const [pending, start] = useTransition();
  const [cursor, setCursor] = useState(() => parseDay(initial.date));

  const byDay = useMemo(
    () => new Map(data.days.map((d) => [d.date, d] as const)),
    [data.days]
  );

  function open(dateStr: string) {
    if (dateStr === data.date) return;
    start(async () => setData(await getChecklistHistory(dateStr)));
  }

  // A Monday-first grid for the visible month.
  const grid = useMemo(() => {
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth();
    const first = new Date(Date.UTC(year, month, 1, 12));
    const lead = (first.getUTCDay() + 6) % 7; // Sunday(0) → 6
    const total = new Date(Date.UTC(year, month + 1, 0, 12)).getUTCDate();
    const cells: (string | null)[] = Array(lead).fill(null);
    for (let d = 1; d <= total; d++) cells.push(toDay(new Date(Date.UTC(year, month, d, 12))));
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }, [cursor]);

  const shiftMonth = (by: number) =>
    setCursor((c) => new Date(Date.UTC(c.getUTCFullYear(), c.getUTCMonth() + by, 1, 12)));

  const tooOld = data.date < data.oldestKept;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]">
      {/* ── Calendar ── */}
      <Card className="h-fit">
        <CardContent className="p-3">
          <div className="mb-2 flex items-center justify-between">
            <button
              onClick={() => shiftMonth(-1)}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Previous month"
            >
              <ChevronLeft className="size-4" />
            </button>
            <p className="text-sm font-semibold">
              {MONTHS[cursor.getUTCMonth()]} {cursor.getUTCFullYear()}
            </p>
            <button
              onClick={() => shiftMonth(1)}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Next month"
            >
              <ChevronRight className="size-4" />
            </button>
          </div>

          <div className="mb-1 grid grid-cols-7 gap-1">
            {DOW.map((d, i) => (
              <div key={i} className="text-center text-[10px] font-semibold text-muted-foreground">{d}</div>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-1">
            {grid.map((day, i) => {
              if (!day) return <div key={i} />;
              const rec = byDay.get(day);
              const kept = day >= data.oldestKept && day <= data.today;
              const selected = day === data.date;
              const isToday = day === data.today;
              return (
                <button
                  key={day}
                  onClick={() => kept && open(day)}
                  disabled={!kept || pending}
                  className={cn(
                    "relative flex h-8 items-center justify-center rounded text-xs transition-colors",
                    selected && "bg-primary font-semibold text-primary-foreground",
                    !selected && kept && "hover:bg-muted",
                    !kept && "cursor-not-allowed text-muted-foreground/30",
                    !selected && isToday && "ring-1 ring-primary/40"
                  )}
                  title={
                    !kept
                      ? "Outside the 60 days kept"
                      : rec
                        ? `${rec.done} ticked${rec.notes ? `, ${rec.notes} remark${rec.notes === 1 ? "" : "s"}` : ""}`
                        : "Nothing recorded"
                  }
                >
                  {parseDay(day).getUTCDate()}
                  {rec && !selected && (
                    <span
                      className={cn(
                        "absolute bottom-0.5 size-1 rounded-full",
                        rec.notes > 0 ? "bg-amber-500" : "bg-emerald-500"
                      )}
                    />
                  )}
                </button>
              );
            })}
          </div>

          <p className="mt-3 border-t border-border pt-2 text-[10px] leading-relaxed text-muted-foreground">
            The last 60 days are kept — back to <b>{prettyDay(data.oldestKept)}</b>. Older days
            are deleted automatically. A dot marks a day with something recorded; amber means
            somebody left a remark.
          </p>
        </CardContent>
      </Card>

      {/* ── The chosen day ── */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <CalendarDays className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">
            {prettyDay(data.date)}
            {data.date === data.today && <span className="ml-1.5 text-xs font-normal text-muted-foreground">(today)</span>}
          </h3>
          {pending && <span className="text-xs text-muted-foreground">loading…</span>}
        </div>

        {tooOld ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              That day is older than the 60 days kept, so it has been deleted.
            </CardContent>
          </Card>
        ) : data.checklists.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              Nothing recorded on this day.
            </CardContent>
          </Card>
        ) : (
          data.checklists.map((c) => (
            <Card key={c.id}>
              <CardContent className="p-4">
                <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold">{c.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {c.assigneeName} · {c.assigneeRole} · due {c.dueTime}
                    </p>
                  </div>
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[11px] font-semibold",
                      c.done === c.total && c.total > 0
                        ? "bg-emerald-50 text-emerald-700"
                        : "bg-rose-50 text-rose-700"
                    )}
                  >
                    {c.done}/{c.total} done
                  </span>
                </div>

                <ul className="space-y-1.5">
                  {c.items.map((it) => (
                    <li key={it.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
                      <span
                        className={cn(
                          "inline-flex size-4 shrink-0 translate-y-0.5 items-center justify-center rounded border",
                          it.done ? "border-emerald-500 bg-emerald-500 text-white" : "border-border"
                        )}
                      >
                        {it.done && <Check className="size-3" />}
                      </span>
                      <span className={cn(it.done ? "" : "text-muted-foreground")}>{it.label}</span>
                      {it.done && it.doneAt && (
                        <span className={cn("text-xs tabular-nums", it.late ? "text-rose-600" : "text-muted-foreground")}>
                          <Clock className="mr-0.5 inline size-3" />
                          {prettyTime(it.doneAt)}
                          {it.doneBy ? ` · ${it.doneBy}` : ""}
                        </span>
                      )}
                      {!it.done && (
                        <span className="text-xs text-rose-600">not done</span>
                      )}
                      {it.note && (
                        <span className="basis-full pl-6 text-xs text-amber-800">
                          <StickyNote className="mr-1 inline size-3" />
                          {it.note}
                          {it.noteBy ? <span className="text-muted-foreground"> — {it.noteBy}</span> : null}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}

export type { ChecklistHistoryDay };
