"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Unit } from "@/lib/units";
import { unitLabel } from "@/lib/units";
import { qtyText } from "@/lib/quantity";
import { toast } from "sonner";
import { fmtTimePKT, fmtDatePKT } from "@/lib/pkt";
import { forwardableWithAdditions, loadLoss } from "@/lib/mix-allocation";
import {
  CheckCircle2,
  AlertTriangle,
  Clock,
  Check,
  Diff,
  Warehouse,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  confirmArrival,
  type DispatchItem,
  type DispatchRecord,
} from "@/app/(dashboard)/inventory/farm-arrival/actions";


const DISPUTE_REASONS = [
  "Spillage during transport",
  "Incorrect loading at farm",
  "Packaging damage",
  "Short supply from farm",
  "Packet leaked",
  "During packaging",
  "Van To Retail",
  "Yogurt Making",
  "Freezer",
  "Spoiled",
  "Human Error",
  "Packaging Seal",
  "Chiller Failure",
  "Other",
];

// ── Diff (dispute) panel ─────────────────────────────────────────────────────

function DiffPanel({
  dispatch,
  mixMilkProduct,
  mixMilkUsage,
  mixMilkMade,
  onCancel,
  onConfirmed,
}: {
  dispatch: DispatchRecord;
  mixMilkProduct: { id: string; name: string; unit: Unit } | null;
  mixMilkUsage: Record<string, number>;
  mixMilkMade: number;
  onCancel: () => void;
  onConfirmed: () => void;
}) {
  const takenAt = (productId: string) =>
    (mixMilkUsage[productId] ?? 0) + (dispatch.dilutionOut[productId] ?? 0);
  const addedAt = (productId: string) => dispatch.dilutionIn[productId] ?? 0;
  const adjustedDefaults: Record<string, string> = Object.fromEntries(
    dispatch.declaredItems.map((i) => [
      i.productId,
      String(forwardableWithAdditions(i.quantity, takenAt(i.productId), addedAt(i.productId))),
    ])
  );
  if (mixMilkProduct && mixMilkMade > 0) adjustedDefaults[mixMilkProduct.id] = String(mixMilkMade);
  // Same rule as the card: state holds only edits, so a mix milk batch logged
  // while this panel is open changes what gets sent, not just what is drawn.
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const qtyOf = (productId: string) => quantities[productId] ?? adjustedDefaults[productId] ?? "";
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();

  function handleConfirm() {
    if (!reason) {
      toast.error("Select a reason for the quantity difference.");
      return;
    }
    const exceeded = dispatch.declaredItems.find((di) => {
      const entered = parseFloat(qtyOf(di.productId) || "0") || 0;
      const adjMax = forwardableWithAdditions(di.quantity, takenAt(di.productId), addedAt(di.productId));
      return entered > adjMax;
    });
    if (exceeded) {
      const entered = parseFloat(qtyOf(exceeded.productId) || "0") || 0;
      const adjMax = forwardableWithAdditions(exceeded.quantity, takenAt(exceeded.productId), addedAt(exceeded.productId));
      toast.error(
        `${exceeded.productName}: ${entered} ${exceeded.unit === "LITER" ? "L" : exceeded.unit === "KG" ? "kg" : "pc"} cannot be forwarded — ${adjMax} is what this load can send on after what packaging took from it and stirred into it.`
      );
      return;
    }
    const receivedItems: DispatchItem[] = dispatch.declaredItems.map((di) => ({
      ...di,
      quantity: parseFloat(qtyOf(di.productId) || "0") || 0,
    }));
    if (mixMilkProduct && mixMilkMade > 0) {
      const enteredMix = Math.max(0, parseFloat(qtyOf(mixMilkProduct.id) || String(mixMilkMade)) || 0);
      if (enteredMix > 0) {
        receivedItems.push({ productId: mixMilkProduct.id, productName: mixMilkProduct.name, unit: mixMilkProduct.unit, quantity: enteredMix });
      }
    }

    startTransition(async () => {
      const res = await confirmArrival(dispatch.id, receivedItems, reason);
      if (res.ok) {
        toast.success("Accepted with your quantities — now at packaging.");
        onConfirmed();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <div className="space-y-4 rounded-lg border border-amber-200 bg-amber-50/60 p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">
        Enter actual quantities dispatched
      </p>
      {(Object.values(mixMilkUsage).some((v) => v > 0) ||
        Object.values(dispatch.dilutionOut).some((v) => v > 0) ||
        Object.values(dispatch.dilutionIn).some((v) => v > 0)) && (
        <p className="-mt-2 text-[11px] leading-snug text-amber-800">
          Milk used here — for mix milk, or stirred into the buffalo milk — cannot be
          sent on as well, and milk stirred in adds to its line. Enter what is{" "}
          <strong>left to forward</strong>; the mix milk goes on as its own line.
        </p>
      )}
      <div className="grid grid-cols-2 gap-3">
        {dispatch.declaredItems.map((di) => {
          const adjMax = forwardableWithAdditions(di.quantity, takenAt(di.productId), addedAt(di.productId));
          return (
            <div key={di.productId} className="rounded-md border border-amber-200 bg-white p-2.5">
              <p className="mb-1.5 text-[10px] font-medium uppercase text-amber-700">
                {di.productName} ({unitLabel(di.unit)})
              </p>
              <Input
                type="number"
                min="0"
                max={adjMax}
                step="0.1"
                value={qtyOf(di.productId)}
                onChange={(e) =>
                  setQuantities((q) => ({ ...q, [di.productId]: e.target.value }))
                }
                className="border-amber-200 bg-transparent text-base font-semibold text-amber-900 focus-visible:ring-amber-400"
                placeholder={String(adjMax)}
              />
              {(takenAt(di.productId) > 0 || addedAt(di.productId) > 0) && (
                <p className="mt-1 text-[10px] leading-tight text-amber-700">
                  {di.quantity} dispatched
                  {(mixMilkUsage[di.productId] ?? 0) > 0 && <> − {mixMilkUsage[di.productId]} for mix milk</>}
                  {(dispatch.dilutionOut[di.productId] ?? 0) > 0 && <> − {dispatch.dilutionOut[di.productId]} into buffalo milk</>}
                  {addedAt(di.productId) > 0 && <> + {addedAt(di.productId)} cow milk stirred in</>}
                  {" = "}<strong>{adjMax}</strong> to forward
                </p>
              )}
            </div>
          );
        })}
        {mixMilkProduct && mixMilkMade > 0 && (
          <div className="rounded-md border border-amber-200 bg-white p-2.5">
            <p className="mb-1.5 text-[10px] font-medium uppercase text-amber-700">
              {mixMilkProduct.name} ({unitLabel(mixMilkProduct.unit)})
            </p>
            <Input
              type="number"
              min="0"
              max={mixMilkMade}
              step="0.1"
              value={qtyOf(mixMilkProduct.id)}
              onChange={(e) =>
                setQuantities((q) => ({ ...q, [mixMilkProduct.id]: e.target.value }))
              }
              className="border-amber-200 bg-transparent text-base font-semibold text-amber-900 focus-visible:ring-amber-400"
              placeholder={String(mixMilkMade)}
            />
          </div>
        )}
      </div>

      <Select value={reason} onValueChange={setReason}>
        <SelectTrigger className="border-amber-200 bg-white text-sm text-amber-900">
          <SelectValue placeholder="— select reason for difference —" />
        </SelectTrigger>
        <SelectContent>
          {DISPUTE_REASONS.map((r) => (
            <SelectItem key={r} value={r}>
              {r}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="flex gap-2">
        <Button
          className="flex-1 bg-amber-600 hover:bg-amber-700 text-white"
          onClick={handleConfirm}
          disabled={pending}
        >
          {pending ? "Confirming…" : "Confirm with actual quantities"}
        </Button>
        <Button variant="outline" onClick={onCancel} disabled={pending}>
          Back
        </Button>
      </div>
    </div>
  );
}

// ── Trip Card ────────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: DispatchRecord["status"] }) {
  if (status === "CONFIRMED")
    return (
      <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">
        <CheckCircle2 className="mr-1 size-3" /> Confirmed
      </Badge>
    );
  if (status === "DISPUTED")
    return (
      <Badge className="bg-amber-100 text-amber-700 hover:bg-amber-100">
        <AlertTriangle className="mr-1 size-3" /> Disputed
      </Badge>
    );
  return (
    <Badge className="bg-slate-100 text-slate-600 hover:bg-slate-100">
      <Clock className="mr-1 size-3" /> Awaiting
    </Badge>
  );
}

function TripCard({
  dispatch,
  mixMilkProduct,
  mixMilkMade,
}: {
  dispatch: DispatchRecord;
  mixMilkProduct: { id: string; name: string; unit: Unit } | null;
  mixMilkMade: number;
}) {
  // What THIS load gave up to mix milk. The server charges it per load, so two
  // loads waiting at once are never both docked for the same litres.
  const mixMilkUsage = dispatch.mixMilkDeductions ?? {};
  const [mode, setMode] = useState<"view" | "diff">("view");
  const [confirmed, setConfirmed] = useState(false);
  // Accepting unlocks the buffalo, mix milk and Send to Retail sections below,
  // which read what is at packaging — so the page is re-read once it is done.
  const router = useRouter();
  const [showWastage, setShowWastage] = useState(false);

  // Packaging works on this load in both directions: milk leaves it (mix milk, or
  // stirred into the buffalo milk) and milk joins it (cow milk stirred in). What
  // it can send on is dispatched − taken + added.
  const takenAt = (productId: string) =>
    (mixMilkUsage[productId] ?? 0) + (dispatch.dilutionOut[productId] ?? 0);
  const addedAt = (productId: string) => dispatch.dilutionIn[productId] ?? 0;
  const adjustedItems = dispatch.declaredItems.map((di) => ({
    ...di,
    quantity: forwardableWithAdditions(di.quantity, takenAt(di.productId), addedAt(di.productId)),
  }));
  // Only what the operator actually typed for wastage. Anything untouched falls
  // back to the live figure at read time — a mix milk batch logged while this
  // card is on screen must move the quantity we submit, not just the one we
  // draw. (Seeding state up front froze the pre-mix number and confirmed it.)
  const [actualQty, setActualQty] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();

  const isSettled =
    confirmed ||
    dispatch.status === "CONFIRMED" ||
    dispatch.status === "DISPUTED";

  // Settled dispatches show receivedItems; pending shows adjusted declared + mix milk created
  const displayItems = isSettled && dispatch.receivedItems && dispatch.receivedItems.length > 0
    ? dispatch.receivedItems
    : (() => {
        const items = [...adjustedItems];
        if (!isSettled && mixMilkProduct && mixMilkMade > 0) {
          items.push({
            productId: mixMilkProduct.id,
            productName: mixMilkProduct.name,
            unit: mixMilkProduct.unit,
            quantity: mixMilkMade,
          });
        }
        return items;
      })();

  const milkTotal = displayItems
    .filter((i) => i.unit === "LITER")
    .reduce((s, i) => s + i.quantity, 0);

  const wastageItems = dispatch.receivedItems
    ? dispatch.declaredItems
        .map((di) => {
          const received = dispatch.receivedItems!.find(
            (ri) => ri.productId === di.productId
          );
          // Only real loss counts: mix milk, milk given to the buffalo and milk
          // stirred in are all accounted for first, or ordinary processing would
          // show up here as wastage.
          const loss = loadLoss(di.quantity, received?.quantity ?? di.quantity, {
            mixUsed: dispatch.mixMilkDeductions[di.productId] ?? 0,
            dilutionOut: dispatch.dilutionOut[di.productId] ?? 0,
            dilutionIn: dispatch.dilutionIn[di.productId] ?? 0,
          });
          return { ...di, loss };
        })
        .filter((w) => w.loss > 0.001)
    : [];

  const milkWastage = wastageItems
    .filter((w) => w.unit === "LITER")
    .reduce((s, w) => s + w.loss, 0);

  function handleSame() {
    for (const di of adjustedItems) {
      const received = parseFloat(actualQty[di.productId] ?? String(di.quantity)) || 0;
      if (received > di.quantity) {
        const declared = dispatch.declaredItems.find((d) => d.productId === di.productId)?.quantity ?? di.quantity;
        const taken = takenAt(di.productId);
        const added = addedAt(di.productId);
        toast.error(
          taken > 0 || added > 0
            ? `${di.productName}: ${qtyText(received)} cannot be forwarded — of the ${qtyText(declared)} dispatched, ${taken > 0 ? `${qtyText(taken)} was used here` : ""}${taken > 0 && added > 0 ? " and " : ""}${added > 0 ? `${qtyText(added)} was stirred in` : ""}, leaving ${qtyText(di.quantity)}.`
            : `${di.productName}: received (${received}) cannot exceed available quantity (${di.quantity}).`
        );
        return;
      }
      if (received < 0) {
        toast.error(`${di.productName}: quantity cannot be negative.`);
        return;
      }
    }
    const items: DispatchItem[] = adjustedItems.map((di) => ({
      ...di,
      quantity: Math.max(0, parseFloat(actualQty[di.productId] ?? String(di.quantity)) || 0),
    }));
    const hasWastage = items.some((item) => {
      const adj = adjustedItems.find((a) => a.productId === item.productId);
      return adj ? Math.abs(item.quantity - adj.quantity) > 0.001 : false;
    });
    if (mixMilkProduct && mixMilkMade > 0) {
      const enteredMix = Math.max(0, parseFloat(actualQty[mixMilkProduct.id] ?? String(mixMilkMade)) || 0);
      if (enteredMix > 0) {
        items.push({ productId: mixMilkProduct.id, productName: mixMilkProduct.name, unit: mixMilkProduct.unit, quantity: enteredMix });
      }
    }
    startTransition(async () => {
      const res = await confirmArrival(dispatch.id, items, null, hasWastage);
      if (res.ok) {
        toast.success("Load accepted — now at packaging.");
        setConfirmed(true);
        router.refresh();
        // The buffalo and mix milk sections keep their own copy of what is in
        // inventory; tell them it changed so they unlock without a reload.
        window.dispatchEvent(new Event("milk:inventory-changed"));
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Card className="overflow-hidden border-border shadow-none">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 border-b border-border py-3 px-4">
        <div>
          <p className="text-sm font-medium">
            {fmtTimePKT(dispatch.date)} — Farm → Packaging
          </p>
          <p className="text-xs text-muted-foreground">
            {fmtDatePKT(dispatch.date)}
          </p>
        </div>
        <StatusBadge status={confirmed ? "CONFIRMED" : dispatch.status} />
      </CardHeader>

      <CardContent className="p-4 space-y-4">
        {/* Product grid */}
        <div>
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {isSettled && dispatch.receivedItems
              ? "Accepted quantities"
              : "From production"}
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {displayItems.map((item) => {
              const usedForMix = isSettled ? 0 : mixMilkUsage[item.productId] ?? 0;
              const toBuffalo = isSettled ? 0 : dispatch.dilutionOut[item.productId] ?? 0;
              const stirredIn = isSettled ? 0 : dispatch.dilutionIn[item.productId] ?? 0;
              const declared =
                dispatch.declaredItems.find((d) => d.productId === item.productId)?.quantity ?? 0;
              return (
                <div key={item.productId} className="rounded-md bg-muted/50 p-2.5">
                  <p className="text-[10px] text-muted-foreground">{item.productName}</p>
                  <p className="mt-0.5 text-base font-semibold">
                    {qtyText(item.quantity)}
                    <span className="ml-0.5 text-xs font-normal text-muted-foreground">
                      {unitLabel(item.unit)}
                    </span>
                  </p>
                  {(usedForMix > 0 || toBuffalo > 0 || stirredIn > 0) && (
                    <p className="mt-1 text-[10px] leading-tight text-sky-700">
                      {qtyText(declared)} dispatched
                      {usedForMix > 0 && <> − {qtyText(usedForMix)} for mix milk</>}
                      {toBuffalo > 0 && <> − {qtyText(toBuffalo)} into buffalo milk</>}
                      {stirredIn > 0 && <> + {qtyText(stirredIn)} cow milk stirred in</>}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Total milk */}
        {milkTotal > 0 && (
          <div className="flex items-center justify-between rounded-md bg-sky-50 px-3 py-2 ring-1 ring-sky-100">
            <span className="text-xs font-medium text-sky-700">Total milk</span>
            <span className="text-sm font-bold text-sky-700">{qtyText(milkTotal)} L</span>
          </div>
        )}

        {/* Wastage */}
        {wastageItems.length > 0 && (
          <div className="space-y-2">
            {milkWastage > 0 && (
              <div className="flex items-center justify-between rounded-md bg-rose-50 px-3 py-2 ring-1 ring-rose-100">
                <span className="text-xs font-medium text-rose-700">Milk wastage</span>
                <span className="text-sm font-bold text-rose-700">−{qtyText(milkWastage)} L</span>
              </div>
            )}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {wastageItems.map((w) => (
                <div key={w.productId} className="rounded-md bg-rose-50/70 p-2.5 ring-1 ring-rose-100">
                  <p className="text-[10px] text-rose-500">{w.productName} (loss)</p>
                  <p className="mt-0.5 text-base font-semibold text-rose-700">
                    −{w.loss}
                    <span className="ml-0.5 text-xs font-normal text-rose-400">
                      {unitLabel(w.unit)}
                    </span>
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Dispute reason */}
        {isSettled && dispatch.status === "DISPUTED" && dispatch.reason && (
          <div className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-200">
            <span className="font-medium">Dispute reason: </span>
            {dispatch.reason}
          </div>
        )}

        {/* Pending actions */}
        {!isSettled && mode === "view" && (
          <div className="space-y-3">
            <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              Verify quantities against production before accepting. Accepted milk goes to
              packaging, where it is prepared and then sent to Retail at the bottom of the page.
            </div>
            {/* Wastage section */}
            <div>
              <button
                type="button"
                onClick={() => setShowWastage((v) => !v)}
                className="flex items-center gap-1.5 text-xs text-rose-600 hover:text-rose-800 transition-colors"
              >
                <Trash2 className="size-3" />
                {showWastage ? "Hide wastage log" : "Adjust for wastage (optional)"}
              </button>
              {showWastage && (
                <div className="mt-2 rounded-md border border-rose-200 bg-rose-50/40 p-3 space-y-2">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-rose-700">
                    Actual quantity received after wastage
                  </p>
                  <p className="text-[10px] text-rose-500">
                    Reduce any product that had wastage — the difference is logged automatically.
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    {adjustedItems.map((di) => (
                      <div key={di.productId} className="rounded-md border border-rose-100 bg-white p-2">
                        <p className="mb-1 text-[10px] text-rose-500">
                          {di.productName} ({unitLabel(di.unit)})
                        </p>
                        <Input
                          type="number"
                          min="0"
                          max={di.quantity}
                          step="0.1"
                          value={actualQty[di.productId] ?? String(di.quantity)}
                          onChange={(e) =>
                            setActualQty((q) => ({ ...q, [di.productId]: e.target.value }))
                          }
                          className="border-rose-100 text-sm font-semibold focus-visible:ring-rose-300"
                        />
                      </div>
                    ))}
                    {mixMilkProduct && mixMilkMade > 0 && (
                      <div className="rounded-md border border-rose-100 bg-white p-2">
                        <p className="mb-1 text-[10px] text-rose-500">
                          {mixMilkProduct.name} ({unitLabel(mixMilkProduct.unit)})
                        </p>
                        <Input
                          type="number"
                          min="0"
                          max={mixMilkMade}
                          step="0.1"
                          value={actualQty[mixMilkProduct.id] ?? String(mixMilkMade)}
                          onChange={(e) =>
                            setActualQty((q) => ({ ...q, [mixMilkProduct.id]: e.target.value }))
                          }
                          className="border-rose-100 text-sm font-semibold focus-visible:ring-rose-300"
                        />
                      </div>
                    )}
                  </div>
                  {(() => {
                    const wastedL = adjustedItems
                      .filter((di) => di.unit === "LITER")
                      .reduce((s, di) => {
                        const received = parseFloat(actualQty[di.productId] ?? String(di.quantity)) || 0;
                        return s + Math.max(0, di.quantity - received);
                      }, 0);
                    return wastedL > 0.001 ? (
                      <p className="text-right text-xs font-medium text-rose-700">
                        Milk wastage: −{Math.round(wastedL * 10) / 10} L
                      </p>
                    ) : null;
                  })()}
                </div>
              )}
            </div>
            <p className="text-center text-sm font-medium">
              Are the quantities correct?
            </p>
            <div className="grid grid-cols-2 gap-3">
              <Button
                className="h-14 flex-col gap-1 bg-emerald-50 text-emerald-700 ring-1 ring-emerald-300 hover:bg-emerald-100"
                variant="ghost"
                onClick={handleSame}
                disabled={pending}
              >
                <Check className="size-5" />
                <span className="text-xs">{pending ? "Confirming…" : "Yes, confirm"}</span>
              </Button>
              <Button
                className="h-14 flex-col gap-1 bg-amber-50 text-amber-700 ring-1 ring-amber-300 hover:bg-amber-100"
                variant="ghost"
                onClick={() => setMode("diff")}
                disabled={pending}
              >
                <Diff className="size-5" />
                <span className="text-xs">Different qty</span>
              </Button>
            </div>
          </div>
        )}

        {/* Diff panel */}
        {!isSettled && mode === "diff" && (
          <DiffPanel
            dispatch={dispatch}
            mixMilkProduct={mixMilkProduct}
            mixMilkUsage={mixMilkUsage}
            mixMilkMade={mixMilkMade}
            onCancel={() => setMode("view")}
            onConfirmed={() => {
              setConfirmed(true);
              router.refresh();
              // The buffalo and mix milk sections keep their own copy of what is in
              // inventory; tell them it changed so they unlock without a reload.
              window.dispatchEvent(new Event("milk:inventory-changed"));
              setMode("view");
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}

// ── Main client ──────────────────────────────────────────────────────────────

export function FarmArrivalClient({
  initialDispatches,
  mixMilkProduct,
  mixMilkMade,
}: {
  initialDispatches: DispatchRecord[];
  mixMilkProduct: { id: string; name: string; unit: Unit } | null;
  mixMilkMade: number;
}) {
  let accepted = 0, disputed = 0, pending = 0;
  for (const d of initialDispatches) {
    if (d.status === "CONFIRMED") accepted++;
    else if (d.status === "DISPUTED") disputed++;
    else pending++;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Accept from Production</h3>
        <div className="flex gap-2 text-xs">
          <span className="rounded-full bg-muted px-2 py-0.5 font-medium">{initialDispatches.length} loads today</span>
          <span className="rounded-full bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700">{accepted + disputed} accepted</span>
          <span className={`rounded-full px-2 py-0.5 font-medium ${pending > 0 ? "bg-amber-50 text-amber-700" : "bg-muted text-muted-foreground"}`}>{pending} waiting</span>
        </div>
      </div>

      {/* Dispute count banner */}
      {disputed > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
          <AlertTriangle className="size-4 shrink-0" />
          {disputed} load{disputed > 1 ? "s" : ""} accepted with a different quantity today.
        </div>
      )}

      {/* Dispatch cards */}
      {initialDispatches.length === 0 ? (
        <div className="flex h-24 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-border text-muted-foreground">
          <Warehouse className="size-5 opacity-40" />
          <p className="text-sm">No production loads recorded today.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {initialDispatches.map((d) => (
            <TripCard key={d.id} dispatch={d} mixMilkProduct={mixMilkProduct} mixMilkMade={mixMilkMade} />
          ))}
        </div>
      )}
    </div>
  );
}
