"use client";

import { useState, useTransition, useEffect, useRef } from "react";
import type { Unit } from "@/lib/units";
import { unitLabel } from "@/lib/units";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { logProduction, logUsage, logProductionWastage, getProductionAvailable, sendToPackaging, type DispatchPreview } from "@/app/(dashboard)/inventory/production/actions";
import { productionFormSchema } from "@/lib/validators/production";
import { quantityProblem, stepForUnit } from "@/lib/quantity";
import { todayPKTString } from "@/lib/pkt";
import { Milk, Save, Baby, ChefHat, Lock, Truck, Trash2 } from "lucide-react";

type Product = {
  id: string;
  name: string;
  unit: Unit;
};


// Measured products take up to two decimals (10.55 L); counted ones (eggs) are
// whole units. Both rules live in lib/quantity so this form and the server action
// behind it decide identically.
const stepFor = stepForUnit;

/** First product whose typed quantity breaks the rule, with the message to show. */
function firstQuantityProblem(
  products: { id: string; name: string; unit: string }[],
  qtyOf: (id: string) => number
): string | null {
  for (const p of products) {
    const problem = quantityProblem(p.name, p.unit, qtyOf(p.id));
    if (problem) return problem;
  }
  return null;
}


/**
 * What was typed, as a number. The boxes hold text, not numbers, so an empty box
 * stays empty: a box holding 0 cannot be cleared with backspace, because every
 * keystroke that empties it puts the 0 straight back.
 */
const num = (s: string | undefined) => {
  const n = Number(s);
  return s && !Number.isNaN(n) ? n : 0;
};

export function ProductionForm({ products }: { products: Product[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [date, setDate] = useState(todayPKTString());
  const lastDay = useRef(todayPKTString());
  useEffect(() => {
    const id = setInterval(() => {
      const today = todayPKTString();
      if (today !== lastDay.current) {
        setDate((prev) => (prev === lastDay.current ? today : prev));
        lastDay.current = today;
      }
    }, 30_000);
    return () => clearInterval(id);
  }, []);
  const [notes, setNotes] = useState("");

  const [quantities, setQuantities] = useState<Record<string, string>>({});

  const setQty = (id: string, q: number) =>
    setQuantities((prev) => ({ ...prev, [id]: q ? String(q) : "" }));
  const setRaw = (id: string, s: string) =>
    setQuantities((prev) => ({ ...prev, [id]: s }));

  const total = products.reduce((a, p) => a + num(quantities[p.id]), 0);
  const filledCount = products.filter((p) => num(quantities[p.id]) > 0).length;

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    const lines = products.map((p) => ({
      productId: p.id,
      quantity: num(quantities[p.id]),
    }));

    const problem = firstQuantityProblem(products, (id) => num(quantities[id]));
    if (problem) {
      toast.error(problem);
      return;
    }

    const parsed = productionFormSchema.safeParse({ date, notes, lines });

    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "Invalid form");
      return;
    }

    startTransition(async () => {
      const res = await logProduction(parsed.data);
      if (res.ok) {
        toast.success(`Logged ${res.count} product${res.count === 1 ? "" : "s"}`);
        setQuantities({});
        setNotes("");
        router.refresh();
        window.dispatchEvent(new CustomEvent("milk:inventory-changed"));
      } else {
        toast.error(res.error);
      }
    });
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Milk className="size-4" /> Production Entry
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <Label>Date *</Label>
              <Input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="mt-1"
              />
            </div>
            <div>
              <Label>Summary</Label>
              <div className="mt-1 flex h-9 items-center gap-2 rounded-md border border-border bg-muted/40 px-3 text-sm">
                <Badge variant="secondary" className="text-xs">
                  {filledCount} item{filledCount === 1 ? "" : "s"}
                </Badge>
                <span className="text-muted-foreground">
                  Total: <strong className="text-foreground">{total}</strong>{" "}
                  units
                </span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Quantities Produced</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {products.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No products configured.
              </p>
            ) : (
              products.map((p) => (
                <div
                  key={p.id}
                  className="rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary/50"
                >
                  <div className="flex items-center justify-between">
                    <Label className="text-sm font-medium">{p.name}</Label>
                    <Badge variant="outline" className="text-[10px]">
                      {unitLabel(p.unit)}
                    </Badge>
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <Input
                      type="number"
                      step={stepFor(p.unit)}
                      min={0}
                      placeholder="0"
                      value={quantities[p.id] ?? ""}
                      onChange={(e) => setRaw(p.id, e.target.value)}
                      className="text-lg font-semibold"
                    />
                    <span className="text-sm text-muted-foreground">
                      {unitLabel(p.unit)}
                    </span>
                  </div>
                  {/* Quick buttons */}
                  <div className="mt-2 flex flex-wrap gap-1">
                    {[5, 10, 20, 50].map((v) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => setQty(p.id, num(quantities[p.id]) + v)}
                        className="rounded border border-border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        +{v}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => setQty(p.id, 0)}
                      className="rounded border border-border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      reset
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Notes</CardTitle>
        </CardHeader>
        <CardContent>
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Anything noteworthy — sick animal, weather, equipment issue..."
            rows={3}
          />
        </CardContent>
      </Card>

      <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center justify-between gap-3 border-t border-border bg-background/95 px-4 py-4 backdrop-blur sm:-mx-6 sm:px-6">
        <p className="text-sm text-muted-foreground">
          Logging will also create a <code>PRODUCED</code> entry in the
          inventory ledger.
        </p>
        <Button type="submit" disabled={isPending || total === 0}>
          <Save className="size-4" />
          {isPending ? "Saving..." : "Save Production"}
        </Button>
      </div>
    </form>
  );
}

// ── Calf / Kitchen Use Form ──────────────────────────────────────────────────

export function UsageForm({
  type,
  products,
  locked = false,
}: {
  type: "CALF_USE" | "KITCHEN_USE";
  products: Product[];
  locked?: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [date, setDate] = useState(todayPKTString());
  const lastDayUsage = useRef(todayPKTString());
  useEffect(() => {
    const id = setInterval(() => {
      const today = todayPKTString();
      if (today !== lastDayUsage.current) {
        setDate((prev) => (prev === lastDayUsage.current ? today : prev));
        lastDayUsage.current = today;
      }
    }, 30_000);
    return () => clearInterval(id);
  }, []);
  const [quantities, setQuantities] = useState<Record<string, string>>({});

  const setQty = (id: string, q: number) =>
    setQuantities((prev) => ({ ...prev, [id]: q ? String(q) : "" }));
  const setRaw = (id: string, s: string) =>
    setQuantities((prev) => ({ ...prev, [id]: s }));

  const total = products.reduce((a, p) => a + num(quantities[p.id]), 0);
  const filledCount = products.filter((p) => num(quantities[p.id]) > 0).length;

  const isCalf = type === "CALF_USE";
  const title = isCalf ? "Calf Use" : "Kitchen Use";
  const Icon = isCalf ? Baby : ChefHat;

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const problem = firstQuantityProblem(products, (id) => num(quantities[id]));
    if (problem) {
      toast.error(problem);
      return;
    }
    const items = products.map((p) => ({
      productId: p.id,
      quantity: num(quantities[p.id]),
    }));
    startTransition(async () => {
      const res = await logUsage(type, items, date);
      if (res.ok) {
        toast.success(`${title}: logged ${res.count} product${res.count === 1 ? "" : "s"}`);
        setQuantities({});
        router.refresh();
        window.dispatchEvent(new CustomEvent("milk:inventory-changed"));
      } else {
        toast.error(res.error);
      }
    });
  }

  if (locked) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Icon className="size-4" /> {title}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-10 text-center text-muted-foreground">
            <Lock className="size-5 opacity-40" />
            <p className="text-sm">Save today&apos;s production first to unlock this section.</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <form onSubmit={handleSubmit}>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Icon className="size-4" /> {title}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <Label>Date *</Label>
              <Input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="mt-1"
              />
            </div>
            <div>
              <Label>Summary</Label>
              <div className="mt-1 flex h-9 items-center gap-2 rounded-md border border-border bg-muted/40 px-3 text-sm">
                <Badge variant="secondary" className="text-xs">
                  {filledCount} item{filledCount === 1 ? "" : "s"}
                </Badge>
                <span className="text-muted-foreground">
                  Total: <strong className="text-foreground">{total}</strong> units
                </span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {products.map((p) => (
              <div
                key={p.id}
                className="rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary/50"
              >
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-medium">{p.name}</Label>
                  <Badge variant="outline" className="text-[10px]">
                    {unitLabel(p.unit)}
                  </Badge>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <Input
                    type="number"
                    step={stepFor(p.unit)}
                    min={0}
                    placeholder="0"
                    value={quantities[p.id] ?? ""}
                    onChange={(e) => setRaw(p.id, e.target.value)}
                    className="text-lg font-semibold"
                  />
                  <span className="text-sm text-muted-foreground">
                    {unitLabel(p.unit)}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {[5, 10, 20, 50].map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setQty(p.id, num(quantities[p.id]) + v)}
                      className="rounded border border-border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      +{v}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setQty(p.id, 0)}
                    className="rounded border border-border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    reset
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="flex justify-end">
            <Button type="submit" disabled={isPending || total === 0}>
              <Save className="size-4" />
              {isPending ? "Saving…" : `Save ${title}`}
            </Button>
          </div>
        </CardContent>
      </Card>
    </form>
  );
}

// ── Production Wastage Form ───────────────────────────────────────────────────

export function ProductionWastageForm({
  products,
  locked = false,
}: {
  products: Product[];
  locked?: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [date, setDate] = useState(todayPKTString());
  const lastDayW = useRef(todayPKTString());
  useEffect(() => {
    const id = setInterval(() => {
      const today = todayPKTString();
      if (today !== lastDayW.current) {
        setDate((prev) => (prev === lastDayW.current ? today : prev));
        lastDayW.current = today;
      }
    }, 30_000);
    return () => clearInterval(id);
  }, []);

  // Quantity LOST per product. Strings so fields start blank; the operator only
  // fills the products that actually had wastage.
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(products.map((p) => [p.id, ""]))
  );
  const setValue = (id: string, v: string) => setValues((prev) => ({ ...prev, [id]: v }));

  // Available quantities per product fetched from server
  const [availability, setAvailability] = useState<Record<string, number>>({});
  async function refreshAvail(d: string) {
    const rows = await getProductionAvailable(d);
    setAvailability(Object.fromEntries(rows.map((r) => [r.productId, r.available])));
  }
  useEffect(() => { refreshAvail(date); }, [date]);
  useEffect(() => {
    const handler = () => refreshAvail(date);
    window.addEventListener("milk:inventory-changed", handler);
    return () => window.removeEventListener("milk:inventory-changed", handler);
  }, [date]);

  const filledCount = Object.values(values).filter((v) => v !== "").length;
  const fmtN = (n: number) => n % 1 === 0 ? n.toFixed(0) : n.toFixed(1);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const items = products
      .filter((p) => values[p.id] !== "")
      .map((p) => ({ productId: p.id, lost: parseFloat(values[p.id]) || 0 }));
    if (items.length === 0) {
      toast.error("Enter the quantity lost for at least one product.");
      return;
    }
    const overAvailable = products.find((p) => {
      if (values[p.id] === "") return false;
      const avail = availability[p.id];
      const lost = parseFloat(values[p.id]);
      return avail !== undefined && !isNaN(lost) && lost > avail + 0.001;
    });
    if (overAvailable) {
      toast.error(
        `${overAvailable.name}: cannot lose ${values[overAvailable.id]} ${unitLabel(overAvailable.unit)} — only ${fmtN(availability[overAvailable.id] ?? 0)} ${unitLabel(overAvailable.unit)} is available.`
      );
      return;
    }
    const problem = firstQuantityProblem(
      products.filter((p) => values[p.id] !== ""),
      (id) => parseFloat(values[id]) || 0
    );
    if (problem) {
      toast.error(problem);
      return;
    }
    startTransition(async () => {
      const res = await logProductionWastage(items, date);
      if (res.ok) {
        toast.success(`Wastage logged for ${res.count} product${res.count === 1 ? "" : "s"}`);
        setValues(Object.fromEntries(products.map((p) => [p.id, ""])));
        router.refresh();
        window.dispatchEvent(new CustomEvent("milk:inventory-changed"));
      } else {
        toast.error(res.error);
      }
    });
  }

  if (locked) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Trash2 className="size-4" /> Log Wastage
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-10 text-center text-muted-foreground">
            <Lock className="size-5 opacity-40" />
            <p className="text-sm">Save today&apos;s production first to unlock this section.</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <form onSubmit={handleSubmit}>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Trash2 className="size-4 text-rose-500" /> Log Wastage
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground rounded-md bg-rose-50/60 border border-rose-100 px-3 py-2">
            Enter how much was <strong className="text-rose-700">lost</strong> for any product with wastage — not what is left. Leave blank if nothing was lost. The remaining stock is worked out for you.
          </p>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <Label>Date *</Label>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="mt-1" />
            </div>
            <div>
              <Label>Summary</Label>
              <div className="mt-1 flex h-9 items-center gap-2 rounded-md border border-border bg-muted/40 px-3 text-sm">
                <Badge variant="secondary" className="text-xs">{filledCount} item{filledCount === 1 ? "" : "s"} entered</Badge>
              </div>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {products.map((p) => {
              const avail = availability[p.id] ?? null;
              const entered = values[p.id] !== "" ? parseFloat(values[p.id]) : null;
              // The operator types the loss; show what that leaves behind.
              const remaining = avail !== null && entered !== null && !isNaN(entered)
                ? Math.round((avail - entered) * 1000) / 1000 : null;
              return (
                <div key={p.id} className="rounded-lg border border-border bg-card p-4 transition-colors hover:border-rose-400/50">
                  <div className="flex items-center justify-between gap-2">
                    <Label className="text-sm font-medium">{p.name}</Label>
                    {avail !== null ? (
                      <span className="text-[11px] text-muted-foreground whitespace-nowrap">
                        avail: <span className="font-semibold text-foreground">{fmtN(avail)} {unitLabel(p.unit)}</span>
                      </span>
                    ) : (
                      <Badge variant="outline" className="text-[10px]">{unitLabel(p.unit)}</Badge>
                    )}
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <Input
                      type="number"
                      step={stepFor(p.unit)}
                      min={0}
                      max={avail ?? undefined}
                      placeholder="0"
                      value={values[p.id]}
                      onChange={(e) => setValue(p.id, e.target.value)}
                      className="text-lg font-semibold"
                    />
                    <span className="text-sm text-muted-foreground">{unitLabel(p.unit)}</span>
                  </div>
                  {remaining !== null && entered !== null && entered > 0.001 && (
                    <p
                      className={`mt-1.5 text-xs font-medium ${remaining < -0.001 ? "text-rose-600" : "text-muted-foreground"}`}
                    >
                      {remaining < -0.001
                        ? `Only ${fmtN(avail ?? 0)} ${unitLabel(p.unit)} available`
                        : `Remaining: ${fmtN(remaining)} ${unitLabel(p.unit)}`}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
          <div className="flex justify-end">
            <Button type="submit" variant="destructive" disabled={isPending || filledCount === 0}>
              <Trash2 className="size-4" />
              {isPending ? "Saving…" : "Log Wastage"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </form>
  );
}

// ── Dispatch to Packaging ─────────────────────────────────────────────────────

function fmt(n: number) {
  return n % 1 === 0 ? n.toFixed(0) : n.toFixed(1);
}

export function DispatchCard({
  preview,
  locked,
}: {
  preview: DispatchPreview[];
  locked: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const hasNet = preview.some((p) => p.net > 0);

  if (locked) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Truck className="size-4" /> Dispatch to Packaging
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-10 text-center text-muted-foreground">
            <Lock className="size-5 opacity-40" />
            <p className="text-sm">Save today&apos;s production first to unlock this section.</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  function handleDispatch() {
    startTransition(async () => {
      const res = await sendToPackaging();
      if (res.ok) {
        toast.success("Dispatched to packaging.");
        window.dispatchEvent(new CustomEvent("milk:inventory-changed"));
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Truck className="size-4" /> Dispatch to Packaging
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Outstanding quantities not yet sent to packaging (incl. skim milk &amp; cream) — carried over until dispatched. Click to send to the packaging team.
        </p>

        {preview.length === 0 ? (
          <p className="rounded-lg border border-dashed py-6 text-center text-sm text-muted-foreground">
            Nothing produced yet.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {preview.map((item) => (
              <div key={item.productId} className="rounded-lg border border-border bg-muted/20 p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{item.productName}</p>
                <p className="mt-1 text-2xl font-bold">
                  {fmt(item.net)}{" "}
                  <span className="text-sm font-normal text-muted-foreground">{unitLabel(item.unit as keyof typeof unitLabel) ?? item.unit}</span>
                </p>
              </div>
            ))}
          </div>
        )}

        <div className="flex justify-end">
          <Button onClick={handleDispatch} disabled={isPending || !hasNet}>
            <Truck className="size-4" />
            {isPending ? "Dispatching…" : "Send to Packaging"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
