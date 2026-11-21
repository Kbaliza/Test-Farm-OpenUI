"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * One section of the Packaging page, folded away until it is wanted.
 *
 * The page is the whole packaging day on one screen — accept, prepare buffalo, mix
 * milk, eggs, wastage, what the shifts need, send to Retail — and open all at once it
 * is minutes of scrolling to reach the part you came for.
 *
 * Two details that matter more than they look:
 *
 * The bar REPLACES the section's own card header while folded, rather than sitting
 * above it. Each section is already a Card with its own title, so a permanent bar
 * would show every title twice.
 *
 * The children stay mounted and are hidden with CSS, never unmounted. Several of these
 * sections are data entry — a part-typed wastage line, a quantity waiting on a
 * confirmation — and unmounting would throw that away the moment somebody folded the
 * section to look at something else.
 */
export function FoldableSection({
  title,
  note,
  defaultOpen = false,
  children,
}: {
  title: string;
  /** A word on what is inside, shown only while folded. */
  note?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex w-full items-center gap-2.5 rounded-xl border border-border bg-card px-4 py-3 text-left transition-colors hover:bg-muted/40"
        >
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0">
            <span className="block text-base font-semibold">{title}</span>
            {note && <span className="block text-xs text-muted-foreground">{note}</span>}
          </span>
          <span className="ml-auto shrink-0 text-xs font-medium text-muted-foreground">Open</span>
        </button>
      )}

      {/* Hidden, not removed — see the note above about part-finished entry. */}
      <div className={cn(open ? "block" : "hidden")}>
        <div className="mb-1 flex justify-end">
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          >
            <ChevronDown className="size-3.5" /> Hide {title}
          </button>
        </div>
        {children}
      </div>
    </section>
  );
}
