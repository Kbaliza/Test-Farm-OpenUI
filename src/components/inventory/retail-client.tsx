"use client";

import { useState, useTransition } from "react";
import { qtyText } from "@/lib/quantity";
import { unitLabel } from "@/lib/units";
import { toast } from "sonner";
import { fmtTimePKT, fmtDatePKT } from "@/lib/pkt";
import {
  CheckCircle2,
  AlertTriangle,
  Clock,
  Check,
  Diff,
  Store,
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
  confirmRetailArrival,
  type RetailDispatchItem,
  type RetailDispatchRecord,
} from "@/app/(dashboard)/inventory/retail/actions";


const DISPUTE_REASONS = [
  "Spillage during transport",
  "Incorrect loading at packaging",
  "Packaging damage",
  "Short supply from packaging",
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
  onCancel,
  onConfirmed,
}: {
  dispatch: RetailDispatchRecord;
  onCancel: () => void;
  onConfirmed: () => void;
}) {
  const [quantities, setQuantities] = useState<Record<string, string>>(
    Object.fromEntries(
      dispatch.declaredItems.map((i) => [i.productId, String(i.quantity)])
    )
  );
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();

  function handleConfirm() {
    if (!reason) {
      toast.error("Select a reason for the quantity difference.");
      return;
    }
    const exceeded = dispatch.declaredItems.find((di) => {
      const entered = parseFloat(quantities[di.productId] || "0") || 0;
      return entered > di.quantity;
    });
    if (exceeded) {
      const entered = parseFloat(quantities[exceeded.productId] || "0") || 0;
      toast.error(
        `${exceeded.productName}: ${entered} ${exceeded.unit === "LITER" ? "L" : exceeded.unit === "KG" ? "kg" : "pc"} exceeds declared quantity of ${exceeded.quantity}. Actual received cannot be more than what was dispatched.`
      );
      return;
    }
    const receivedItems: RetailDispatchItem[] = dispatch.declaredItems.map(
      (di) => ({
        ...di,
        quantity: parseFloat(quantities[di.productId] || "0") || 0,
      })
    );

    startTransition(async () => {
      const res = await confirmRetailArrival(dispatch.id, receivedItems, reason);
      if (res.ok) {
        toast.success("Dispute logged — actual quantities recorded.");
        onConfirmed();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <div className="space-y-4 rounded-lg border border-amber-200 bg-amber-50/60 p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">
        Enter actual quantities received at retail
      </p>
      <div className="grid grid-cols-2 gap-3">
        {dispatch.declaredItems.map((di) => (
          <div
            key={di.productId}
            className="rounded-md border border-amber-200 bg-white p-2.5"
          >
            <p className="mb-1.5 text-[10px] font-medium uppercase text-amber-700">
              {di.productName} ({unitLabel(di.unit)})
            </p>
            <Input
              type="number"
              min="0"
              max={di.quantity}
              step="0.1"
              value={quantities[di.productId] ?? ""}
              onChange={(e) =>
                setQuantities((q) => ({
                  ...q,
                  [di.productId]: e.target.value,
                }))
              }
              className="border-amber-200 bg-transparent text-base font-semibold text-amber-900 focus-visible:ring-amber-400"
              placeholder={String(di.quantity)}
            />
          </div>
        ))}
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

function StatusBadge({ status }: { status: RetailDispatchRecord["status"] }) {
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

function TripCard({ dispatch }: { dispatch: RetailDispatchRecord }) {
  const [mode, setMode] = useState<"view" | "diff">("view");
  const [confirmed, setConfirmed] = useState(false);
  const [showWastage, setShowWastage] = useState(false);
  const [actualQty, setActualQty] = useState<Record<string, string>>(
    Object.fromEntries(dispatch.declaredItems.map((di) => [di.productId, String(di.quantity)]))
  );
  const [pending, startTransition] = useTransition();

  const displayItems =
    dispatch.receivedItems && dispatch.receivedItems.length > 0
      ? dispatch.receivedItems
      : dispatch.declaredItems;

  const milkTotal = displayItems
    .filter((i) => i.unit === "LITER")
    .reduce((s, i) => s + i.quantity, 0);

  const wastageItems = dispatch.receivedItems
    ? dispatch.declaredItems
        .map((di) => {
          const received = dispatch.receivedItems!.find(
            (ri) => ri.productId === di.productId
          );
          const loss =
            Math.round(
              (di.quantity - (received?.quantity ?? di.quantity)) * 1000
            ) / 1000;
          return { ...di, loss };
        })
        .filter((w) => w.loss > 0.001)
    : [];

  const milkWastage = wastageItems
    .filter((w) => w.unit === "LITER")
    .reduce((s, w) => s + w.loss, 0);

  function handleSame() {
    for (const di of dispatch.declaredItems) {
      const received = parseFloat(actualQty[di.productId] ?? String(di.quantity)) || 0;
      if (received > di.quantity) {
        toast.error(`${di.productName}: received (${received}) cannot exceed declared quantity (${di.quantity}).`);
        return;
      }
      if (received < 0) {
        toast.error(`${di.productName}: quantity cannot be negative.`);
        return;
      }
    }
    const items: RetailDispatchItem[] = dispatch.declaredItems.map((di) => ({
      ...di,
      quantity: Math.max(0, parseFloat(actualQty[di.productId] ?? String(di.quantity)) || 0),
    }));
    const hasWastage = items.some((item, i) =>
      Math.abs(item.quantity - dispatch.declaredItems[i].quantity) > 0.001
    );
    startTransition(async () => {
      const res = await confirmRetailArrival(dispatch.id, items, null, hasWastage);
      if (res.ok) {
        toast.success("Retail load confirmed — recorded as handed over.");
        setConfirmed(true);
      } else {
        toast.error(res.error);
      }
    });
  }

  const isSettled =
    confirmed ||
    dispatch.status === "CONFIRMED" ||
    dispatch.status === "DISPUTED";

  return (
    <Card className="overflow-hidden border-border shadow-none">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 border-b border-border py-3 px-4">
        <div>
          <p className="text-sm font-medium">
            {fmtTimePKT(dispatch.date)} — Packaging → Retail
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
              ? "Received at retail"
              : "From packaging"}
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {displayItems.map((item) => (
              <div key={item.productId} className="rounded-md bg-muted/50 p-2.5">
                <p className="text-[10px] text-muted-foreground">
                  {item.productName}
                </p>
                <p className="mt-0.5 text-base font-semibold">
                  {qtyText(item.quantity)}
                  <span className="ml-0.5 text-xs font-normal text-muted-foreground">
                    {unitLabel(item.unit)}
                  </span>
                </p>
              </div>
            ))}
          </div>
        </div>

        {/* Total milk */}
        {milkTotal > 0 && (
          <div className="flex items-center justify-between rounded-md bg-sky-50 px-3 py-2 ring-1 ring-sky-100">
            <span className="text-xs font-medium text-sky-700">Total milk</span>
            <span className="text-sm font-bold text-sky-700">{milkTotal} L</span>
          </div>
        )}

        {/* Wastage */}
        {wastageItems.length > 0 && (
          <div className="space-y-2">
            {milkWastage > 0 && (
              <div className="flex items-center justify-between rounded-md bg-rose-50 px-3 py-2 ring-1 ring-rose-100">
                <span className="text-xs font-medium text-rose-700">
                  Milk wastage
                </span>
                <span className="text-sm font-bold text-rose-700">
                  −{milkWastage} L
                </span>
              </div>
            )}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {wastageItems.map((w) => (
                <div
                  key={w.productId}
                  className="rounded-md bg-rose-50/70 p-2.5 ring-1 ring-rose-100"
                >
                  <p className="text-[10px] text-rose-500">
                    {w.productName} (loss)
                  </p>
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
              Verify quantities physically before confirming. Confirmed loads are
              recorded as handed over in inventory.
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
                    {dispatch.declaredItems.map((di) => (
                      <div key={di.productId} className="rounded-md border border-rose-100 bg-white p-2">
                        <p className="mb-1 text-[10px] text-rose-500">
                          {di.productName} ({unitLabel(di.unit)})
                        </p>
                        <Input
                          type="number"
                          min="0"
                          max={di.quantity}
                          step="0.1"
                          value={actualQty[di.productId] ?? ""}
                          onChange={(e) =>
                            setActualQty((q) => ({ ...q, [di.productId]: e.target.value }))
                          }
                          className="border-rose-100 text-sm font-semibold focus-visible:ring-rose-300"
                        />
                      </div>
                    ))}
                  </div>
                  {(() => {
                    const wastedL = dispatch.declaredItems
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
              Did retail receive this exact load?
            </p>
            <div className="grid grid-cols-2 gap-3">
              <Button
                className="h-14 flex-col gap-1 bg-emerald-50 text-emerald-700 ring-1 ring-emerald-300 hover:bg-emerald-100"
                variant="ghost"
                onClick={handleSame}
                disabled={pending}
              >
                <Check className="size-5" />
                <span className="text-xs">
                  {pending ? "Confirming…" : "Yes, confirm"}
                </span>
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
            onCancel={() => setMode("view")}
            onConfirmed={() => {
              setConfirmed(true);
              setMode("view");
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}

// ── Main client ──────────────────────────────────────────────────────────────

export function RetailClient({
  initialDispatches,
}: {
  initialDispatches: RetailDispatchRecord[];
}) {
  let confirmed = 0, disputed = 0, pending = 0;
  for (const d of initialDispatches) {
    if (d.status === "CONFIRMED") confirmed++;
    else if (d.status === "DISPUTED") disputed++;
    else pending++;
  }

  return (
    <div className="space-y-5 p-4 sm:p-6">
      {/* Summary bar */}
      <div className="grid grid-cols-3 overflow-hidden rounded-xl border border-border bg-card shadow-none">
        <div className="border-r border-border px-4 py-3 text-center">
          <p className="text-2xl font-bold">{initialDispatches.length}</p>
          <p className="mt-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">
            Loads today
          </p>
        </div>
        <div className="border-r border-border px-4 py-3 text-center">
          <p className="text-2xl font-bold text-emerald-600">{confirmed}</p>
          <p className="mt-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">
            Confirmed
          </p>
        </div>
        <div className="px-4 py-3 text-center">
          <p
            className={`text-2xl font-bold ${pending > 0 ? "text-amber-600" : "text-muted-foreground"}`}
          >
            {pending}
          </p>
          <p className="mt-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">
            Pending
          </p>
        </div>
      </div>

      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
        Today&apos;s Loads
      </h3>

      {/* Dispute banner */}
      {disputed > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
          <AlertTriangle className="size-4 shrink-0" />
          {disputed} dispute{disputed > 1 ? "s" : ""} logged today — adjusted
          quantities have been recorded.
        </div>
      )}

      {/* Cards */}
      {initialDispatches.length === 0 ? (
        <div className="flex h-40 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border text-muted-foreground">
          <Store className="size-6 opacity-40" />
          <p className="text-sm">No loads forwarded today.</p>
          <p className="text-xs">
            Loads sent from Packaging appear here for you to confirm. They are already in inventory.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {initialDispatches.map((d) => (
            <TripCard key={d.id} dispatch={d} />
          ))}
        </div>
      )}
    </div>
  );
}
