"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { CalendarDays, X } from "lucide-react";
import { type DateRange } from "react-day-picker";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";

const TABS = [
  { id: "today", label: "Today" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
] as const;

function dateLabelShort(dateStr: string): string {
  return new Date(`${dateStr}T12:00:00`).toLocaleDateString("en-US", {
    timeZone: "Asia/Karachi",
    day: "numeric",
    month: "short",
  });
}

function dateStrFromLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function PeriodTabs({
  value,
  selectedFrom,
  selectedTo,
}: {
  value: string;
  selectedFrom?: string; // "YYYY-MM-DD"
  selectedTo?: string;   // "YYYY-MM-DD"
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const hasRange = !!selectedFrom;

  // Build a DateRange object for the Calendar from the URL params
  const calSelected: DateRange | undefined = selectedFrom
    ? (() => {
        const [fy, fm, fd] = selectedFrom.split("-").map(Number);
        const from = new Date(fy, fm - 1, fd);
        if (selectedTo) {
          const [ty, tm, td] = selectedTo.split("-").map(Number);
          return { from, to: new Date(ty, tm - 1, td) };
        }
        return { from, to: undefined };
      })()
    : undefined;

  function handleRangeSelect(range: DateRange | undefined) {
    if (!range) return;
    if (range.from && range.to) {
      const from = dateStrFromLocal(range.from);
      const to   = dateStrFromLocal(range.to);
      setOpen(false);
      router.push(`${pathname}?from=${from}&to=${to}`, { scroll: false });
    }
    // If only `from` is set, keep the popover open so user picks `to`
  }

  // Label shown on the button
  const buttonLabel = hasRange
    ? selectedTo
      ? `${dateLabelShort(selectedFrom)} – ${dateLabelShort(selectedTo)}`
      : dateLabelShort(selectedFrom)
    : "Pick date";

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Period tabs */}
      <div className="inline-flex rounded-lg border border-border bg-muted p-1 text-sm">
        {TABS.map((tab) => (
          <Link
            key={tab.id}
            href={`${pathname}?period=${tab.id}`}
            className={`rounded-md px-3 py-1.5 transition-colors ${
              !hasRange && value === tab.id
                ? "bg-background font-medium text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
          </Link>
        ))}
      </div>

      {/* Calendar range picker */}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className={`gap-1.5 text-sm ${hasRange ? "border-primary text-primary font-medium" : ""}`}
          >
            <CalendarDays className="size-4" />
            {buttonLabel}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-auto max-w-[calc(100vw-1rem)] overflow-x-auto p-0">
          <Calendar
            mode="range"
            selected={calSelected}
            onSelect={handleRangeSelect}
            disabled={{ after: new Date() }}
            numberOfMonths={2}
          />
        </PopoverContent>
      </Popover>

      {/* Clear range when one is selected */}
      {hasRange && (
        <Link
          href={`${pathname}?period=today`}
          className="rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          title="Clear date filter"
        >
          <X className="size-3.5" />
        </Link>
      )}
    </div>
  );
}
