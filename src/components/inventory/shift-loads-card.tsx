"use client";

import { useEffect, useState } from "react";
import { Truck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { unitLabel, type Unit } from "@/lib/units";
import { milkLoadOrder } from "@/lib/product-names";
import { roundQty } from "@/lib/quantity";
import type { PackagingLoadNeeds } from "@/app/(dashboard)/customers/pre-delivery/actions";

const fmt = (n: number) => (n % 1 === 0 ? n.toFixed(0) : n.toFixed(1));

// What the shifts need, today and tomorrow — the same totals the Shift Editor's
// load preview shows (customers, samples and extras). A shift is only assigned
// once Retail holds its whole load, so "Still to send" is what packaging has to
// get to Retail for every shift to go out.
export function ShiftLoadsCard({ today, tomorrow }: { today: PackagingLoadNeeds; tomorrow: PackagingLoadNeeds }) {
  const [tab, setTab] = useState<"today" | "tomorrow">("today");
  // What the packer is typing into the Send to Retail boxes below, so this card
  // counts it down with him rather than waiting for the send.
  const [typing, setTyping] = useState<Record<string, number>>({});
  useEffect(() => {
    const onTyping = (e: Event) => setTyping((e as CustomEvent<Record<string, number>>).detail ?? {});
    window.addEventListener("packaging:typing", onTyping);
    return () => window.removeEventListener("packaging:typing", onTyping);
  }, []);
  const view = tab === "today" ? today : tomorrow;
  const lines = [...view.lines].sort((a, b) => milkLoadOrder(a.name) - milkLoadOrder(b.name) || a.name.localeCompare(b.name));
  const left = (l: PackagingLoadNeeds["lines"][number]) =>
    Math.max(0, roundQty(l.stillToSend - (view.isToday ? typing[l.productId] ?? 0 : 0)));
  const allSent = view.isToday && lines.length > 0 && lines.every((l) => left(l) <= 0);

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Truck className="size-4" /> Shift loads
        </CardTitle>
        <div className="inline-flex rounded-md border border-border p-0.5 text-xs">
          {(["today", "tomorrow"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn(
                "rounded px-3 py-1 font-medium",
                tab === t ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t === "today" ? "Today" : "Tomorrow"}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-xs text-muted-foreground">
          {view.isToday
            ? "Everything the riders take today — customers and extras. A shift can only be assigned once Retail holds its load, so send what is still needed."
            : "Tomorrow's load as planned so far. It can still change until each shift is saved."}
        </p>
        {view.error ? (
          <p className="rounded-lg border border-dashed px-4 py-4 text-sm text-rose-700">{view.error}</p>
        ) : lines.length === 0 ? (
          <p className="rounded-lg border border-dashed px-4 py-4 text-sm text-muted-foreground">
            No shift load {view.isToday ? "today" : "for tomorrow"} yet.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-1.5 text-left font-medium">Product</th>
                  <th className="px-3 py-1.5 text-right font-medium">Needed</th>
                  {view.isToday && (
                    <>
                      <th className="px-3 py-1.5 text-right font-medium">Sent to Retail</th>
                      <th className="px-3 py-1.5 text-right font-medium">In Retail now</th>
                      <th className="px-3 py-1.5 text-right font-medium">Still to send</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => {
                  const u = unitLabel(l.unit as Unit);
                  return (
                    <tr key={l.productId} className="border-t border-border/60">
                      <td className="px-3 py-1.5 font-medium">{l.name}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{fmt(l.needed)} {u}</td>
                      {view.isToday && (
                        <>
                          <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{fmt(l.sent)} {u}</td>
                          <td className={cn("px-3 py-1.5 text-right tabular-nums", l.inRetail < 0 ? "text-rose-700" : "text-muted-foreground")}>
                            {fmt(l.inRetail)} {u}
                          </td>
                          <td className={cn("px-3 py-1.5 text-right font-semibold tabular-nums", left(l) > 0 ? "text-amber-700" : "text-emerald-700")}>
                            {left(l) > 0 ? `${fmt(left(l))} ${u}` : "Done"}
                            {(typing[l.productId] ?? 0) > 0 && (
                              <span className="block text-[10px] font-normal text-muted-foreground">once this send goes</span>
                            )}
                          </td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {allSent && (
          <p className="text-xs font-medium text-emerald-700">
            {Object.keys(typing).length > 0
              ? "This send covers everything the shifts need today."
              : "Retail has everything the shifts need today."}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
