"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Egg, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { todayPKTString } from "@/lib/pkt";
import { addEggs, deleteEggEntry, type EggContext } from "@/app/(dashboard)/inventory/farm-arrival/egg-actions";

function fmtDay(ds: string) {
  return new Date(`${ds}T12:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short" });
}

// Eggs are entered here rather than on Production: they are collected, not made
// from milk. Adding them puts them into inventory; they go to Retail from the
// "Send to Retail" section below, like every other product.
export function EggsCard({ ctx }: { ctx: EggContext }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [quantity, setQuantity] = useState("");

  const qty = Number(quantity);
  const valid = Number.isInteger(qty) && qty > 0;
  const name = ctx.productName ?? "Desi Eggs";

  function submit() {
    if (!valid) return;
    start(async () => {
      const res = await addEggs({ quantity: qty });
      if (res.ok) {
        toast.success(`${qty} ${name} added to inventory.`);
        setQuantity("");
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  function remove(id: string) {
    start(async () => {
      const res = await deleteEggEntry(id);
      if (res.ok) { toast.success("Entry removed."); router.refresh(); }
      else toast.error(res.error);
    });
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Egg className="size-4" /> {name}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Eggs collected at the farm go into inventory when added. Send them to Retail from &ldquo;Send to Retail&rdquo; below.
        </p>
      </CardHeader>
      <CardContent className="grid gap-6 lg:grid-cols-[minmax(0,20rem)_1fr]">
        {ctx.productName === null ? (
          <p className="text-sm text-muted-foreground">
            No egg product in the catalogue. Add one under Inventory &gt; Products first.
          </p>
        ) : (
          <div className="space-y-3">
            <div>
              <Label className="text-xs">How many eggs</Label>
              <Input
                type="number" min="0" step="1" inputMode="numeric"
                className="mt-1" placeholder="0"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
              />
              {quantity !== "" && !valid && (
                <p className="mt-1 text-[11px] text-rose-600">Enter a whole number of eggs.</p>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground">
              Recorded for today, {fmtDay(todayPKTString())}.
            </p>
            <Button className="w-full" onClick={submit} disabled={!valid || pending}>
              <Egg className="mr-1.5 size-4" />
              {pending ? "Saving…" : "Add eggs"}
            </Button>
          </div>
        )}

        <div className="min-w-0">
          <p className="mb-2 text-sm font-medium">Last 14 days</p>
          {ctx.entries.length === 0 ? (
            <p className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
              No eggs entered here yet.
            </p>
          ) : (
            <div className="max-h-[20rem] overflow-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-muted/60 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Added</th>
                    <th className="px-3 py-2 text-right font-medium">Eggs</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {ctx.entries.map((e, i) => {
                    return (
                      <tr key={e.id} className={i % 2 ? "bg-muted/20" : ""}>
                        <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                          {fmtDay(e.date)} · {new Date(e.at).toLocaleTimeString("en-GB", { timeZone: "Asia/Karachi", hour: "2-digit", minute: "2-digit" })}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-right font-medium">{e.quantity}</td>
                        <td className="px-3 py-2 text-right">
                          {e.removable && (
                            <button
                              type="button"
                              onClick={() => remove(e.id)}
                              disabled={pending}
                              className="text-muted-foreground hover:text-destructive disabled:opacity-40"
                              aria-label="Remove entry"
                              title="Remove this entry"
                            >
                              <Trash2 className="size-3.5" />
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
