"use client";

import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Search, ChevronsUpDown, X } from "lucide-react";

export type ComboItem = {
  value: string;
  label: string;
  sublabel?: string;
};

// A generic searchable single-select. Shares the look/behaviour of the
// Payment-Receiving / OTC-Sale customer picker, generalized so vendor and
// customer selectors can both use it (items: OTC sale customer & vendor, OTC
// purchase vendor).
export function SearchCombobox({
  items,
  value,
  onChange,
  placeholder = "Search & select…",
  searchPlaceholder = "Search…",
  emptyText = "Nothing found.",
  clearable = true,
}: {
  items: ComboItem[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  clearable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = items.find((i) => i.value === value) ?? null;

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? items.filter(
          (i) =>
            i.label.toLowerCase().includes(q) ||
            (i.sublabel ?? "").toLowerCase().includes(q)
        )
      : items;
    return list.slice(0, 50);
  }, [items, query]);

  return (
    <Popover open={open} onOpenChange={(v) => { setOpen(v); if (!v) setQuery(""); }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-sm"
        >
          <span className={cn("truncate", !selected && "text-muted-foreground")}>
            {selected ? (selected.sublabel ? `${selected.label} · ${selected.sublabel}` : selected.label) : placeholder}
          </span>
          {selected && clearable ? (
            <X className="size-4 shrink-0 opacity-60" onClick={(e) => { e.stopPropagation(); onChange(""); }} />
          ) : (
            <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
        <div className="relative border-b border-border p-2">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={searchPlaceholder}
            className="h-8 pl-7 text-xs"
          />
        </div>
        <div className="max-h-64 overflow-y-auto p-1">
          {matches.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs text-muted-foreground">{emptyText}</p>
          ) : (
            matches.map((i) => (
              <button
                key={i.value}
                type="button"
                onClick={() => { onChange(i.value); setOpen(false); setQuery(""); }}
                className={cn(
                  "flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted",
                  value === i.value && "bg-muted"
                )}
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{i.label}</span>
                  {i.sublabel ? (
                    <span className="block truncate text-[10px] text-muted-foreground">{i.sublabel}</span>
                  ) : null}
                </span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
