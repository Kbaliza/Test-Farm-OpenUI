"use client";

import React, { useState, useTransition, useRef, useMemo, useEffect } from "react";
import { toast } from "sonner";
import {
  Save, Users, Milk, Package, BadgeDollarSign,
  ChevronUp, ChevronDown, X, GripVertical,
  Bike, CalendarDays, UserRound, Boxes, Search,
  UserPlus, AlertTriangle, ArrowRight, Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  getShiftCustomers, saveRoute, saveRoutePlan, saveShiftExtras, saveDeliveryOrder, searchCustomersForRoute, getOnCallCustomersForShift,
  takeSampleOffShift,
  type ShiftOption, type CustomerStop,
  type StopProduct, type CatalogProduct, type CustomerSearchResult,
  type ShiftExtra, type SettledExtra, type LoadedFor,
} from "@/app/(dashboard)/customers/pre-delivery/actions";
import { todayPKTString, addDaysToDateStr, fmtTimePKT } from "@/lib/pkt";
import { milkLoadOrder } from "@/lib/product-names";
import { unitLabel } from "@/lib/units";
import { isShiftLockedOnDateStr } from "@/lib/schedule";

// Mobile-owned route lifecycle, read-only on the web. null = no saved route yet.
type RouteStatusValue = "PENDING" | "IN_PROGRESS" | "COMPLETED" | null;

// ── helpers ───────────────────────────────────────────────────────────────────

const AVATARS = [
  { bg: "bg-blue-100",    tc: "text-blue-700"    },
  { bg: "bg-rose-100",    tc: "text-rose-700"    },
  { bg: "bg-emerald-100", tc: "text-emerald-700" },
  { bg: "bg-violet-100",  tc: "text-violet-700"  },
  { bg: "bg-amber-100",   tc: "text-amber-700"   },
  { bg: "bg-teal-100",    tc: "text-teal-700"    },
  { bg: "bg-orange-100",  tc: "text-orange-700"  },
  { bg: "bg-pink-100",    tc: "text-pink-700"    },
];

function initials(name: string) {
  return name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
}

function fmtQty(products: StopProduct[]) {
  return products
    .filter((p) => p.quantity > 0)
    .map((p) => `${p.quantity}${p.unit === "LITER" ? "L" : p.unit === "KG" ? "kg" : "pc"} ${p.productName}`)
    .join(" · ") || "No order";
}

function computeStats(stops: CustomerStop[]) {
  let milk = 0, pieces = 0, billing = 0;
  for (const s of stops) {
    for (const p of s.products) {
      if (p.unit === "LITER") milk += p.quantity;
      if (p.unit === "PIECE") pieces += p.quantity;
      billing += p.quantity * p.rate;
    }
  }
  return { milk, pieces, billing };
}

// ── Stat pill ─────────────────────────────────────────────────────────────────

function StatPill({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
      <Icon className="size-4 text-muted-foreground" />
      <div>
        <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</p>
        <p className="text-sm font-semibold leading-tight">{value}</p>
      </div>
    </div>
  );
}

// ── Add customer dialog ───────────────────────────────────────────────────────

function AddCustomerDialog({
  open,
  currentShiftId,
  currentShiftName,
  date,
  existingIds,
  onAdd,
  onClose,
}: {
  open: boolean;
  currentShiftId: string;
  currentShiftName: string;
  date: string;
  existingIds: Set<string>;
  onAdd: (customer: CustomerSearchResult) => void;
  onClose: () => void;
}) {
  const [query,       setQuery]       = useState("");
  const [results,     setResults]     = useState<CustomerSearchResult[]>([]);
  const [searching,   setSearching]   = useState(false);
  // ID of the customer currently showing a cross-shift confirmation
  const [confirmId,   setConfirmId]   = useState<string | null>(null);
  // This shift's on-call customers — shown up-front so they can be added without
  // searching, which is the whole point of an on-call customer.
  const [onCall,      setOnCall]      = useState<CustomerSearchResult[]>([]);
  const [loadingOnCall, setLoadingOnCall] = useState(false);

  // Reset when dialog opens/closes
  useEffect(() => {
    if (!open) { setQuery(""); setResults([]); setConfirmId(null); }
  }, [open]);

  // Load the shift's on-call list each time the dialog opens.
  useEffect(() => {
    if (!open || !currentShiftId) { setOnCall([]); return; }
    let cancelled = false;
    setLoadingOnCall(true);
    getOnCallCustomersForShift(currentShiftId)
      .then((r) => { if (!cancelled) setOnCall(r); })
      .catch(() => { if (!cancelled) setOnCall([]); })
      .finally(() => { if (!cancelled) setLoadingOnCall(false); });
    return () => { cancelled = true; };
  }, [open, currentShiftId]);

  // Debounced search
  useEffect(() => {
    const q = query.trim();
    if (!q) { setResults([]); setSearching(false); return; }
    setSearching(true);
    const t = setTimeout(async () => {
      const res = await searchCustomersForRoute(q, date);
      setResults(res);
      setSearching(false);
    }, 350);
    return () => clearTimeout(t);
  }, [query, date]);

  function handleAdd(c: CustomerSearchResult, force = false) {
    const diffShift = c.shiftId && c.shiftId !== currentShiftId;

    // Different shift — first click shows confirmation, second click confirms
    if (diffShift && !force) {
      setConfirmId(c.customerId);
      return;
    }

    onAdd(c);
    // Keep dialog open so manager can add more if needed
    setConfirmId(null);
    // Remove from results so it shows "In route" on re-search
    setResults((prev) => prev.filter((r) => r.customerId !== c.customerId));
    setOnCall((prev) => prev.filter((r) => r.customerId !== c.customerId));
    toast.success(`${c.name} added to route.`);
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm font-semibold">Add customer to route</DialogTitle>
          <DialogDescription className="text-xs">
            Search any active customer. Adding them today only — their regular shift assignment won&apos;t change.
          </DialogDescription>
        </DialogHeader>

        {/* Search */}
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <Input
            autoFocus
            placeholder="Name, phone or customer code…"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setConfirmId(null); }}
            className="pl-9 h-9 text-sm"
          />
          {searching && (
            <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 size-3.5 animate-spin text-muted-foreground" />
          )}
        </div>

        {/* Results */}
        <div className="max-h-80 overflow-y-auto space-y-2 pr-1">
          {/* On-call customers for this shift — the default view, so they can be
              added the moment they phone in without searching. Hidden while the
              manager is actively searching. */}
          {!query.trim() && (
            loadingOnCall ? (
              <p className="py-4 text-center text-xs text-muted-foreground">Loading on-call customers…</p>
            ) : onCall.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No on-call customers on {currentShiftName}. Search above to add anyone else.
              </p>
            ) : (
              <>
                <p className="px-0.5 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  On call · {currentShiftName}
                </p>
                {onCall.map((c) => {
                  const inRoute = existingIds.has(c.customerId);
                  return (
                    <div
                      key={c.customerId}
                      className={cn(
                        "rounded-xl border p-3 transition-colors",
                        inRoute ? "border-border bg-muted/30 opacity-60" : "border-sky-200 bg-sky-50/40 hover:bg-sky-50"
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold leading-tight">{c.name}</p>
                          <p className="mt-0.5 text-[10px] text-muted-foreground">
                            {c.customerCode} · {c.phone}
                          </p>
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            {c.products.length
                              ? c.products.map((p) => `${p.productName} ${p.quantity}${uLabel(p.unit)}`).join(" · ")
                              : "No saved products"}
                          </p>
                        </div>
                        <div className="shrink-0">
                          {inRoute ? (
                            <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-[10px] font-semibold text-emerald-700">
                              In route ✓
                            </span>
                          ) : (
                            <Button size="sm" className="h-7 text-xs" onClick={() => handleAdd(c)}>
                              Add
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </>
            )
          )}

          {!searching && query.trim() && results.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">No active customers found.</p>
          )}

          {results.map((c) => {
            const inRoute     = existingIds.has(c.customerId);
            const diffShift   = !!(c.shiftId && c.shiftId !== currentShiftId);
            const noShift     = !c.shiftId;
            const isConfirming = confirmId === c.customerId;

            return (
              <div
                key={c.customerId}
                className={cn(
                  "rounded-xl border p-3 transition-colors",
                  inRoute       ? "border-border bg-muted/30 opacity-60" :
                  isConfirming  ? "border-amber-300 bg-amber-50" :
                  diffShift     ? "border-border bg-background hover:bg-muted/20" :
                                  "border-border bg-background hover:bg-muted/20"
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  {/* Info */}
                  <div className="min-w-0">
                    <p className="text-sm font-semibold leading-tight truncate">{c.name}</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      {c.customerCode} · {c.phone}
                    </p>

                    {/* Shift badge */}
                    <div className="mt-1.5">
                      {noShift ? (
                        <span className="inline-block rounded-full bg-slate-100 text-slate-500 px-2 py-0.5 text-[9px] font-medium">
                          No shift assigned
                        </span>
                      ) : diffShift ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-700 px-2 py-0.5 text-[9px] font-semibold">
                          <AlertTriangle className="size-2.5" />
                          {c.shiftName}
                        </span>
                      ) : (
                        <span className="inline-block rounded-full bg-emerald-100 text-emerald-700 px-2 py-0.5 text-[9px] font-semibold">
                          {c.shiftName ?? currentShiftName}
                        </span>
                      )}
                    </div>

                    {/* Cross-shift warning */}
                    {isConfirming && (
                      <p className="mt-2 text-[11px] text-amber-700 leading-tight">
                        This customer belongs to <strong>{c.shiftName}</strong>, not <strong>{currentShiftName}</strong>.
                        Adding for today only — their shift won&apos;t change.
                      </p>
                    )}
                  </div>

                  {/* Action */}
                  <div className="flex flex-col items-end gap-1.5 shrink-0">
                    {inRoute ? (
                      <span className="rounded-full bg-emerald-100 text-emerald-700 px-2.5 py-1 text-[10px] font-semibold">
                        In route ✓
                      </span>
                    ) : isConfirming ? (
                      <div className="flex gap-1.5">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          onClick={() => setConfirmId(null)}
                        >
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          className="h-7 text-xs bg-amber-600 hover:bg-amber-700 text-white border-0"
                          onClick={() => handleAdd(c, true)}
                        >
                          Add anyway
                        </Button>
                      </div>
                    ) : diffShift ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs border-amber-300 text-amber-700 hover:bg-amber-50"
                        onClick={() => handleAdd(c)}
                      >
                        <AlertTriangle className="mr-1 size-3" />
                        Add
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => handleAdd(c)}
                      >
                        <UserPlus className="mr-1 size-3" />
                        Add
                      </Button>
                    )}

                    {/* Products preview */}
                    {!inRoute && c.products.length > 0 && (
                      <p className="text-[9px] text-muted-foreground text-right max-w-[120px] truncate">
                        {c.products.filter(p => p.quantity > 0).map(p =>
                          `${p.quantity}${p.unit === "LITER" ? "L" : p.unit === "KG" ? "kg" : "pc"} ${p.productName}`
                        ).join(", ") || "No regular order"}
                      </p>
                    )}
                  </div>
                </div>

                {/* Suggest alternate shift */}
                {diffShift && !isConfirming && (
                  <p className="mt-2 flex items-center gap-1 text-[10px] text-muted-foreground">
                    <ArrowRight className="size-3" />
                    Normally on <strong>{c.shiftName}</strong> — switch there to manage their regular route
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Customer editor panel ─────────────────────────────────────────────────────

function CustomerEditor({
  stop,
  allProducts,
  allStops,
  readOnly = false,
  onUpdate,
  onClose,
}: {
  stop: CustomerStop;
  allProducts: CatalogProduct[];
  allStops: CustomerStop[];
  readOnly?: boolean;
  onUpdate: (updated: CustomerStop) => void;
  onClose: () => void;
}) {
  // Captured once on mount — not affected by subsequent handleApply calls which
  // write all-catalog products back into stop.products.
  const initialSubscribedIds = useRef(
    new Set(stop.products.filter((p) => p.quantity > 0).map((p) => p.productId))
  );

  const mergedProducts = useMemo((): StopProduct[] =>
    allProducts.map((ap) => {
      const sub = stop.products.find((p) => p.productId === ap.productId);
      return sub ?? { productId: ap.productId, productName: ap.productName, unit: ap.unit, quantity: 0, rate: ap.defaultRate };
    }),
    [allProducts, stop.products]
  );

  const [quantities, setQuantities] = useState<Record<string, string>>(() =>
    Object.fromEntries(mergedProducts.map((p) => [p.productId, String(p.quantity)]))
  );

  function setQty(productId: string, val: string) {
    setQuantities((q) => ({ ...q, [productId]: val }));
  }

  function handleApply() {
    const updatedProducts: StopProduct[] = mergedProducts.map((p) => ({
      ...p,
      quantity: parseFloat(quantities[p.productId] ?? "0") || 0,
    }));
    onUpdate({ ...stop, products: updatedProducts });
  }

  const hasEdited = mergedProducts.some(
    (p) => (parseFloat(quantities[p.productId] ?? "0") || 0) !== p.quantity
  );

  return (
    <div className="flex flex-col lg:h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
        <div>
          <p className="font-semibold text-sm">{stop.name}</p>
          <p className="text-[10px] text-muted-foreground">{stop.customerCode}</p>
        </div>
        <button onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-muted transition-colors">
          <X className="size-4" />
        </button>
      </div>

      <div className="p-4 space-y-4 lg:flex-1 lg:overflow-y-auto">
        <div className="text-xs text-muted-foreground space-y-0.5">
          {stop.address && <p>{stop.address}</p>}
          <p>{stop.phone} · {stop.billingType.toLowerCase()} billing</p>
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Today&apos;s quantities
            </p>
            <p className="text-[10px] text-muted-foreground">Shift-only — won&apos;t change regular order</p>
          </div>

          {mergedProducts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No products in catalog.</p>
          ) : (
            mergedProducts.map((p) => {
              const isSubscribed = initialSubscribedIds.current.has(p.productId);
              const currentQty   = parseFloat(quantities[p.productId] ?? "0") || 0;
              const changed      = currentQty !== p.quantity;
              return (
                <div
                  key={p.productId}
                  className={cn(
                    "flex items-center gap-3 rounded-lg px-3 py-2",
                    isSubscribed ? "bg-muted/40" : "bg-transparent"
                  )}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-xs font-medium truncate">{p.productName}</span>
                      {isSubscribed && (
                        <span className="shrink-0 rounded-full bg-primary/10 px-1.5 text-[9px] font-semibold text-primary">
                          regular
                        </span>
                      )}
                      {changed && (
                        <span className="shrink-0 rounded-full bg-amber-100 px-1.5 text-[9px] font-semibold text-amber-700">
                          edited
                        </span>
                      )}
                    </div>
                  </div>
                  <Input
                    type="number"
                    min="0"
                    step="0.5"
                    disabled={readOnly}
                    className="w-20 h-7 text-sm text-right disabled:opacity-60"
                    value={quantities[p.productId] ?? "0"}
                    onChange={(e) => setQty(p.productId, e.target.value)}
                  />
                  <span className="text-xs text-muted-foreground w-6 shrink-0">
                    {p.unit === "LITER" ? "L" : p.unit === "KG" ? "kg" : "pc"}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="px-4 py-3 border-t border-border flex-shrink-0 space-y-2">
        {readOnly ? (
          <p className="text-[10px] text-muted-foreground text-center">This shift has started/been delivered — quantities can no longer be changed.</p>
        ) : (
          <>
            {hasEdited && (
              <p className="text-[10px] text-amber-600 text-center">Unsaved — click Apply to save</p>
            )}
            <Button size="sm" className="w-full" onClick={handleApply}>
              Apply changes
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

// ── Shift summary panel ───────────────────────────────────────────────────────

const UNIT_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
  LITER: { bg: "bg-sky-50",    text: "text-sky-800",    dot: "bg-sky-400"    },
  KG:    { bg: "bg-amber-50",  text: "text-amber-800",  dot: "bg-amber-400"  },
  PIECE: { bg: "bg-violet-50", text: "text-violet-800", dot: "bg-violet-400" },
};

type ProductTotal = { productId: string; name: string; qty: number; unit: string };

// ── Extra items for the shift's rider ─────────────────────────────────────────
// Spare items the rider takes for on-the-spot customer requests, edited with the
// rest of the shift and saved by Save route / Save plan. Leftovers are received
// back on Rider Item Returns.
let extraSeq = 0;
const extraKey = () => `x${extraSeq++}`;
const toDrafts = (extras: ShiftExtra[]): ExtraDraft[] =>
  extras.map((e) => ({ key: extraKey(), productId: e.productId, qty: String(e.qty) }));
const uLabel = (u: string) => (u === "LITER" ? "L" : u === "KG" ? "kg" : "pc");
const xQty = (n: number) => (n % 1 === 0 ? n.toFixed(0) : n.toFixed(1));

type ExtraDraft = { key: string; productId: string; qty: string };

/** The extras as the server wants them: product and a quantity above 0. */
function extrasPayload(rows: ExtraDraft[]): { productId: string; qty: number }[] {
  return rows
    .map((r) => ({ productId: r.productId, qty: Number(r.qty) }))
    .filter((l) => l.productId && Number.isFinite(l.qty) && l.qty > 0);
}

// Extra items the rider takes on top of the customers' orders. An open list — no
// stock ceiling here: whatever is entered counts in the shift's total load and is
// saved with Save route / Save plan, where the whole load is checked against Retail.
function ExtrasEditor({
  rows,
  onChange,
  settled,
  products,
  riderId,
  riderName,
  editable,
  dirty,
  saving,
  onSave,
}: {
  rows: ExtraDraft[];
  onChange: (rows: ExtraDraft[]) => void;
  settled: SettledExtra[];
  products: CatalogProduct[];
  riderId: string | null;
  riderName: string | null;
  editable: boolean;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
}) {
  const setRow = (key: string, patch: Partial<ExtraDraft>) =>
    onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const addRow = () => onChange([...rows, { key: extraKey(), productId: "", qty: "" }]);
  const removeRow = (key: string) => onChange(rows.filter((r) => r.key !== key));
  const unitOf = (pid: string) => products.find((p) => p.productId === pid)?.unit ?? "PIECE";
  const nameOf = (pid: string) => products.find((p) => p.productId === pid)?.productName ?? "Item";
  const shown = rows.filter((r) => r.productId && Number(r.qty) > 0);

  return (
    <div className="mt-4 rounded-xl border border-border bg-card p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          <Boxes className="size-3.5" /> Extra items for the rider
        </div>
        {dirty && editable && <span className="text-[10px] font-medium text-amber-700">Not saved yet</span>}
      </div>
      {(
        <>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Spare items {riderName ?? "the rider"} takes for on-the-spot requests. Saving them only adds them to the
            shift&apos;s total load, so packaging can get them ready and send them to Retail — it does not hand the
            shift to the rider. Leftovers are received back on Rider Item Returns.
          </p>
          {!riderId && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              No rider is on this shift yet — the load is still saved, and it goes to whoever is assigned.
            </p>
          )}
          {editable ? (
            <>
              <div className="mt-2 space-y-1.5">
                {rows.map((r, i) => (
                  <div key={r.key} className="flex items-center gap-1.5">
                    <Select value={r.productId} onValueChange={(v) => setRow(r.key, { productId: v })}>
                      <SelectTrigger className="h-8 flex-1 text-xs"><SelectValue placeholder={`Item ${i + 1}`} /></SelectTrigger>
                      <SelectContent>
                        {products.map((p) => (
                          <SelectItem key={p.productId} value={p.productId}>{p.productName}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      type="number" min="0" step="any" inputMode="decimal"
                      className="h-8 w-20 text-xs" placeholder="Qty"
                      value={r.qty} onChange={(e) => setRow(r.key, { qty: e.target.value })}
                    />
                    <span className="w-5 text-[11px] text-muted-foreground">{r.productId ? uLabel(unitOf(r.productId)) : ""}</span>
                    <button type="button" onClick={() => removeRow(r.key)}
                      className="grid size-8 shrink-0 place-items-center rounded-md border border-border text-muted-foreground hover:border-rose-200 hover:text-rose-600" title="Remove">
                      <X className="size-3.5" />
                    </button>
                  </div>
                ))}
              </div>
              <div className="mt-2 flex items-center justify-between gap-2">
                <button type="button" onClick={addRow} className="text-[11px] font-medium text-muted-foreground hover:text-foreground">
                  + Add item
                </button>
                {/* Saves the whole shift — the same write as Save route / Save plan —
                    so the extras reach the load summary and the packaging page. */}
                <Button size="sm" className="h-7 text-xs" onClick={onSave} disabled={saving}>
                  <Save className="mr-1.5 size-3.5" />
                  {saving ? "Saving…" : "Save extra load"}
                </Button>
              </div>
            </>
          ) : shown.length > 0 ? (
            <div className="mt-2 space-y-1">
              {shown.map((r) => (
                <div key={r.key} className="flex items-center justify-between text-[11px]">
                  <span className="font-medium">{nameOf(r.productId)}</span>
                  <span className="text-muted-foreground">{xQty(Number(r.qty))} {uLabel(unitOf(r.productId))}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-2 text-[11px] text-muted-foreground">No extra items.</p>
          )}
          {settled.length > 0 && (
            <div className="mt-3 space-y-1 border-t border-border pt-2">
              {settled.map((e, i) => (
                <div key={`${e.productId}-${i}`} className="flex items-center justify-between text-[11px] text-emerald-700">
                  <span className="font-medium">{e.productName}</span>
                  <span>given {xQty(e.qty)} · returned {xQty(e.returnedQty)} {uLabel(e.unit)}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ShiftSummaryPanel({ stops, riderName, shiftName, riderId, products, extras }: {
  stops: CustomerStop[];
  riderName: string | null;
  shiftName: string;
  riderId: string | null;
  products: CatalogProduct[];
  extras: Omit<React.ComponentProps<typeof ExtrasEditor>, "products" | "riderId" | "riderName">;
}) {
  const totalsMap: Record<string, ProductTotal> = {};
  for (const stop of stops) {
    for (const p of stop.products) {
      if (p.quantity <= 0) continue;
      if (!totalsMap[p.productId]) totalsMap[p.productId] = { productId: p.productId, name: p.productName, qty: 0, unit: p.unit };
      totalsMap[p.productId].qty += p.quantity;
    }
  }
  // Cow, then mix, then buffalo, then everything else — the order the van is
  // actually loaded in. Within "everything else" the old unit order is kept, so
  // eggs and yoghurt still fall out the same way they did.
  const totals = Object.values(totalsMap).sort((a, b) => {
    const byMilk = milkLoadOrder(a.name) - milkLoadOrder(b.name);
    if (byMilk !== 0) return byMilk;
    const order = { LITER: 0, KG: 1, PIECE: 2 };
    return (order[a.unit as keyof typeof order] ?? 3) - (order[b.unit as keyof typeof order] ?? 3);
  });
  const totalMilk = totals.filter((t) => t.unit === "LITER").reduce((s, t) => s + t.qty, 0);

  if (stops.length === 0) {
    return (
      <div className="flex min-h-[200px] flex-col items-center justify-center gap-3 p-6 text-muted-foreground lg:h-full lg:min-h-0">
        <CalendarDays className="size-10 opacity-20" />
        <p className="text-sm font-medium">Select a shift with active customers</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col lg:h-full lg:overflow-y-auto">
      <div className="border-b border-border px-5 py-4 flex-shrink-0">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-0.5">Shift load summary</p>
            <p className="font-semibold text-sm">{shiftName}</p>
            {riderName && (
              <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
                <UserRound className="size-3" /> {riderName}
              </p>
            )}
          </div>
          <div className="text-right flex-shrink-0">
            <p className="text-2xl font-bold">{stops.length}</p>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">customers</p>
          </div>
        </div>
      </div>

      <div className="flex-1 p-4 space-y-3">
        {totals.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">No products assigned yet.</div>
        ) : (
          <>
            <p className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground mb-2">Items to deliver</p>
            <div className="flex flex-wrap gap-2">
              {totals.map((t) => {
                const col = UNIT_COLORS[t.unit] ?? UNIT_COLORS.PIECE;
                const label = unitLabel(t.unit);
                return (
                  <div key={t.productId} className={`rounded-lg border border-border px-3 py-2 ${col.bg}`}>
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className={`size-1.5 rounded-full flex-shrink-0 ${col.dot}`} />
                      <p className={`text-[10px] font-semibold uppercase tracking-wide ${col.text}`}>{t.name}</p>
                    </div>
                    <p className={`text-xl font-bold leading-none ${col.text}`}>
                      {t.qty % 1 === 0 ? t.qty : t.qty.toFixed(1)}
                      <span className={`text-xs font-medium ml-1 opacity-70 ${col.text}`}>{label}</span>
                    </p>
                  </div>
                );
              })}
            </div>
            {totalMilk > 0 && (
              <div className="mt-3 rounded-xl border border-border bg-card px-4 py-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Milk className="size-4 text-sky-600" />
                  <span className="text-xs font-medium text-muted-foreground">Total milk</span>
                </div>
                <span className="text-base font-bold text-sky-700">{totalMilk} L</span>
              </div>
            )}
            <div className="rounded-xl border border-border bg-card px-4 py-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Boxes className="size-4 text-muted-foreground" />
                <span className="text-xs font-medium text-muted-foreground">Products total</span>
              </div>
              <span className="text-base font-bold">{totals.length} types</span>
            </div>
          </>
        )}

        <ExtrasEditor {...extras} products={products} riderId={riderId} riderName={riderName} />
      </div>

      <p className="px-5 py-3 border-t border-border text-[10px] text-muted-foreground flex-shrink-0">
        Click any customer to edit their quantities for today
      </p>
    </div>
  );
}

/** The list's customers in stop order, as the delivery order is saved. */
function orderedIds(stops: CustomerStop[]): string[] {
  return [...stops].filter((s) => !s.isSample).sort((a, b) => a.stopNumber - b.stopNumber).map((s) => s.customerId);
}

// ── Main component ────────────────────────────────────────────────────────────

export function PreDeliveryClient({
  shifts,
  products,
  initialShiftId,
  initialDate,
  initialStops,
  initialAvailable = {},
  initialTracked = [],
  initialFromRetail = [],
  initialExtras = [],
  initialSettledExtras = [],
  initialStatus = null,
  initialStartedAt = null,
  initialCompletedAt = null,
  isAdmin,
}: {
  shifts: ShiftOption[];
  products: CatalogProduct[];
  initialShiftId: string;
  initialDate?: string;
  initialStops: CustomerStop[];
  initialAvailable?: Record<string, number>;
  initialTracked?: string[];
  initialFromRetail?: string[];
  initialExtras?: ShiftExtra[];
  initialSettledExtras?: SettledExtra[];
  initialStatus?: RouteStatusValue;
  initialStartedAt?: string | null;
  initialCompletedAt?: string | null;
  isAdmin: boolean;
}) {
  const [isPending, startTransition] = useTransition();

  const [selectedShiftId,  setSelectedShiftId]  = useState(initialShiftId);
  const [date,             setDate]             = useState(initialDate ?? todayPKTString());
  const [showAllShifts,    setShowAllShifts]    = useState(false);
  const [stops,            setStops]            = useState<CustomerStop[]>(initialStops);
  const [available,        setAvailable]        = useState<Record<string, number>>(initialAvailable);
  const [tracked,          setTracked]          = useState<string[]>(initialTracked);
  const [fromRetail,       setFromRetail]       = useState<string[]>(initialFromRetail);
  // The shift's extra items: an open list, saved with the route / plan.
  const [extraRows,        setExtraRows]        = useState<ExtraDraft[]>(() => toDrafts(initialExtras));
  const [settledExtras,    setSettledExtras]    = useState<SettledExtra[]>(initialSettledExtras);
  const [extrasDirty,      setExtrasDirty]      = useState(false);
  const [routeStatus,      setRouteStatus]      = useState<RouteStatusValue>(initialStatus);
  const [startedAt,        setStartedAt]        = useState<string | null>(initialStartedAt);
  const [onRoadSince,      setOnRoadSince]      = useState<string | null>(null);
  const [completedAt,      setCompletedAt]      = useState<string | null>(initialCompletedAt);
  const [selectedCustId,   setSelectedCustId]   = useState<string | null>(null);
  const [loadingStops,     setLoadingStops]     = useState(false);
  // The shift and day the list on screen was loaded for. Picking another shift
  // changes selectedShiftId at once, but its customers arrive seconds later —
  // until they do, nothing may be saved, or the old shift's customers are saved
  // under the new one (28 Oct: the CBR round became a copy of Bahria Phase 1-6).
  const [loadedFor,        setLoadedFor]        = useState<LoadedFor | null>(() => ({ shiftId: initialShiftId, date: initialDate ?? todayPKTString() }));
  // Only the newest load may fill the list; a slower, older one is dropped.
  const loadSeq = useRef(0);
  const [search,           setSearch]           = useState("");
  const [addDialogOpen,    setAddDialogOpen]    = useState(false);

  const currentShift = shifts.find((s) => s.id === selectedShiftId);

  // Once the rider has started (IN_PROGRESS) or finished (COMPLETED) the run, the route
  // is frozen — the rider is already working off these quantities. Editing is only
  // allowed while PENDING. The server enforces the same in saveRoute (defence in depth).
  // Loaded by the rider but not yet started counts as on the road too.
  const routeReadOnly = routeStatus === "IN_PROGRESS" || routeStatus === "COMPLETED" || !!onRoadSince;
  // The list on screen is the selected shift's and day's — saving is safe.
  const listReady = !loadingStops && loadedFor?.shiftId === selectedShiftId && loadedFor?.date === date;


  const dragId = useRef<string | null>(null);

  // The delivery order is a standing decision, not a per-day one, so a reorder
  // saves itself — a manager dragging a stop and moving on should not lose it to
  // a forgotten "Save route" click. Bumped by every move; the effect below writes
  // once the moves stop, so dragging three stops in a row is one save, not three.
  const [orderTick, setOrderTick] = useState(0);
  const stopsRef = useRef<CustomerStop[]>([]);
  // True between a move and the write that follows it, so leaving the page before
  // the write lands flushes rather than losing the reorder.
  const orderSavePending = useRef(false);
  // A write is in flight / another move happened while it was. Moves are collapsed
  // rather than fired in parallel: two overlapping saves rebuild the same route's
  // stops and the slower one would win, putting the order back.
  const orderSaving = useRef(false);
  const orderQueued = useRef(false);
  // Which shift/date the list (and so any pending order) belongs to. The unmount
  // flush runs from an effect that mounted once, so reading these from its closure
  // would post the order to whichever shift happened to be open when the page
  // first loaded.
  const loadedRef = useRef<LoadedFor | null>(null);

  // ── Delivery-day gating ───────────────────────────────────────────────────
  // A shift is locked on dates that fall outside every linked area's
  // predefined delivery days (Areas / Shifts tab). Shifts with no area
  // configured yet are never locked (fail open, not fail closed). This is
  // the single source of truth for what's shown/enabled below — content and
  // actions are gated on `locked` directly, not on whatever `stops` happens
  // to hold, so a stale fetch can never slip locked-shift data past the gate.
  function isShiftLocked(s: ShiftOption) {
    return isShiftLockedOnDateStr(s.schedules, date);
  }
  const shiftLockActive = !showAllShifts;
  const locked = shiftLockActive && !!currentShift && isShiftLocked(currentShift);

  // ── Planning a day that has not arrived ───────────────────────────────────
  // Tomorrow can be prepared, but not handed out. "Save route" writes the row the
  // rider's app reads — and rider access to routes is scoped by shift, not by date,
  // so a route dated tomorrow can reach a phone today. On a future day that button
  // is not offered at all; everything saves to a plan the riders cannot see, and the
  // day itself is still assigned by pressing Save route on it.
  const tomorrow = addDaysToDateStr(todayPKTString(), 1);
  const isFutureDay = date > todayPKTString();
  // Extras are set for today and tomorrow, while the route can still change.
  const extrasEditable = listReady && date >= todayPKTString() && !routeReadOnly && !locked;

  // ── Load customers ────────────────────────────────────────────────────────

  // Keep the selected shift + date in the URL (without a navigation/refetch) so a
  // browser refresh or a return to this page reopens the SAME shift/date — and
  // therefore shows the saved route for it, instead of snapping back to today's
  // first shift and looking like the edit was lost.
  function syncUrl(shiftId: string, d: string) {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams();
    if (shiftId) params.set("shift", shiftId);
    if (d) params.set("date", d);
    // Relative query form + PRESERVE the existing history.state: the App Router keeps
    // its navigation tree in history.state, so replacing it with `null` (or a full
    // path) can corrupt the router and blank out the shell/menu on the next render.
    window.history.replaceState(window.history.state, "", `?${params.toString()}`);
  }

  // The sidebar "Shift Editor" link carries no query string, so history.replaceState
  // alone can't survive a nav-away-and-back. Persist the selected shift in a cookie the
  // server page reads (pd_shift), so reopening restores this shift (on today's date).
  function rememberShift(shiftId: string) {
    if (typeof document === "undefined" || !shiftId) return;
    document.cookie = `pd_shift=${encodeURIComponent(shiftId)}; path=/; max-age=${60 * 60 * 24 * 30}; SameSite=Lax`;
  }

  // A reorder not yet written belongs to the list on screen; write it for THAT
  // shift before the list is replaced by another one.
  function flushOrder() {
    const ctx = loadedRef.current;
    if (!orderSavePending.current || !ctx) return;
    orderSavePending.current = false;
    void saveDeliveryOrder({ ...ctx, loadedFor: ctx, customerIds: orderedIds(stopsRef.current) });
  }

  async function loadCustomers(shiftId: string, d: string, override: boolean) {
    const seq = ++loadSeq.current;
    const switching = loadedRef.current?.shiftId !== shiftId || loadedRef.current?.date !== d;
    if (switching) {
      flushOrder();
      // Never show (or save) the previous shift's customers under this one.
      setStops([]);
      setExtraRows([]);
      setSettledExtras([]);
      setLoadedFor(null);
      loadedRef.current = null;
    }
    setLoadingStops(true);
    setSelectedCustId(null);
    setSearch("");
    let res: Awaited<ReturnType<typeof getShiftCustomers>>;
    try {
      res = await getShiftCustomers(shiftId, d, override);
    } catch {
      if (seq === loadSeq.current) {
        setLoadingStops(false);
        toast.error("Could not load this shift's customers — choose the shift again.");
      }
      return;
    }
    if (seq !== loadSeq.current) return; // another shift or day was chosen meanwhile
    setStops(res.stops);
    setLoadedFor({ shiftId, date: d });
    setAvailable(res.available);
    setTracked(res.tracked);
    setFromRetail(res.fromRetail);
    setExtraRows(toDrafts(res.extras));
    setSettledExtras(res.settledExtras);
    setExtrasDirty(false);
    setRouteStatus(res.status);
    setStartedAt(res.startedAt);
    setOnRoadSince(res.onRoadSince);
    setCompletedAt(res.completedAt);
    setLoadingStops(false);
  }

  function handleShiftChange(shiftId: string) {
    setSelectedShiftId(shiftId);
    syncUrl(shiftId, date);
    rememberShift(shiftId);
    loadCustomers(shiftId, date, showAllShifts);
  }

  function handleDateChange(d: string) {
    if (!d) return;
    // The date box's `max` is only drawn on a computer — phone pickers show every
    // day. So a day beyond tomorrow is refused here; the box snaps back because
    // `date` never changed.
    if (d > addDaysToDateStr(todayPKTString(), 1)) {
      toast.error("Only today and tomorrow can be opened here.");
      return;
    }
    setDate(d);
    syncUrl(selectedShiftId, d);
    loadCustomers(selectedShiftId, d, showAllShifts);
  }

  // On mobile the editor panel renders ABOVE the customer list, so tapping a stop
  // far down the list would open the editor off-screen. Jump to the top so it's
  // visible. (Desktop is a side-by-side split — no scroll needed.)
  function selectCustomer(customerId: string | null) {
    setSelectedCustId(customerId);
    // The dashboard scroll container is <main>, not the window, so scroll that.
    if (customerId && typeof document !== "undefined" && window.innerWidth < 1024) {
      document.querySelector("main")?.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  // Toggling the admin override should immediately reveal (or re-hide) the
  // real route for the currently selected shift/date. Skips the first run —
  // initialStops already covers the mount case.
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return; }
    loadCustomers(selectedShiftId, date, showAllShifts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAllShifts]);

  // ── Add customer from dialog ──────────────────────────────────────────────

  function handleAddCustomer(c: CustomerSearchResult) {
    if (stops.some((s) => s.customerId === c.customerId)) return; // already present
    const maxStop = stops.length > 0 ? Math.max(...stops.map((s) => s.stopNumber)) : 0;
    setStops((prev) => [
      ...prev,
      {
        customerId:   c.customerId,
        name:         c.name,
        customerCode: c.customerCode,
        phone:        c.phone,
        address:      c.address,
        billingType:  c.billingType,
        stopNumber:   maxStop + 1,
        products:     c.products,
      },
    ]);
  }

  // ── Stop ordering ─────────────────────────────────────────────────────────

  // Flag that the ORDER changed (not the quantities) so the effect persists it.
  function orderChanged() {
    orderSavePending.current = true;
    setOrderTick((t) => t + 1);
  }

  function moveUp(custId: string) {
    let moved = false;
    setStops((prev) => {
      const sorted = [...prev].sort((a, b) => a.stopNumber - b.stopNumber);
      const idx = sorted.findIndex((s) => s.customerId === custId);
      if (idx <= 0) return prev;
      const above = sorted[idx - 1], current = sorted[idx];
      moved = true;
      return prev.map((s) => {
        if (s.customerId === above.customerId)   return { ...s, stopNumber: current.stopNumber };
        if (s.customerId === current.customerId) return { ...s, stopNumber: above.stopNumber };
        return s;
      });
    });
    if (moved) orderChanged();
  }

  function moveDown(custId: string) {
    let moved = false;
    setStops((prev) => {
      const sorted = [...prev].sort((a, b) => a.stopNumber - b.stopNumber);
      const idx = sorted.findIndex((s) => s.customerId === custId);
      if (idx === sorted.length - 1) return prev;
      const below = sorted[idx + 1], current = sorted[idx];
      moved = true;
      return prev.map((s) => {
        if (s.customerId === below.customerId)   return { ...s, stopNumber: current.stopNumber };
        if (s.customerId === current.customerId) return { ...s, stopNumber: below.stopNumber };
        return s;
      });
    });
    if (moved) orderChanged();
  }

  // A sample is not part of the saved route — it rides every run of its shift
  // until delivered — so removing it means taking it off the shift for good.
  function removeSample(stop: CustomerStop) {
    if (!listReady) return;
    if (!window.confirm(`Take the sample for ${stop.name} off this shift? It goes back to the Samples page with no shift, and can be sent again from there.`)) return;
    const sampleId = stop.customerId.replace(/^sample:/, "");
    startTransition(async () => {
      const res = await takeSampleOffShift({ sampleId, shiftId: selectedShiftId, date });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setStops((prev) => prev.filter((s) => s.customerId !== stop.customerId));
      if (selectedCustId === stop.customerId) setSelectedCustId(null);
      toast.success(`${stop.name}'s sample is off this shift.`);
    });
  }

  function removeStop(custId: string) {
    const stop = stops.find((s) => s.customerId === custId);
    if (stop?.isSample) {
      removeSample(stop);
      return;
    }
    setStops((prev) => {
      const removed = prev.find((s) => s.customerId === custId)!;
      return prev
        .filter((s) => s.customerId !== custId)
        .map((s) => ({
          ...s,
          stopNumber: s.stopNumber > removed.stopNumber ? s.stopNumber - 1 : s.stopNumber,
        }));
    });
    if (selectedCustId === custId) setSelectedCustId(null);
  }

  // ── Drag and drop ─────────────────────────────────────────────────────────

  function handleDragStart(e: React.DragEvent, custId: string) {
    dragId.current = custId;
    e.dataTransfer.effectAllowed = "move";
  }

  function handleDragOver(e: React.DragEvent) { e.preventDefault(); }

  function handleDrop(e: React.DragEvent, targetId: string) {
    e.preventDefault();
    const fromId = dragId.current;
    if (!fromId || fromId === targetId) return;
    setStops((prev) => {
      const from = prev.find((s) => s.customerId === fromId)!;
      const to   = prev.find((s) => s.customerId === targetId)!;
      return prev.map((s) => {
        if (s.customerId === fromId)   return { ...s, stopNumber: to.stopNumber };
        if (s.customerId === targetId) return { ...s, stopNumber: from.stopNumber };
        return s;
      });
    });
    dragId.current = null;
    orderChanged();
  }

  function handleDragEnd() { dragId.current = null; }

  // ── Stop update from editor ───────────────────────────────────────────────

  function mergeStop(prev: CustomerStop[], updated: CustomerStop): CustomerStop[] {
    const oldStop = prev.find((s) => s.customerId === updated.customerId)!;
    const newNum = updated.stopNumber, oldNum = oldStop.stopNumber;
    if (newNum === oldNum) return prev.map((s) => s.customerId === updated.customerId ? updated : s);
    return prev.map((s) => {
      if (s.customerId === updated.customerId) return updated;
      if (newNum < oldNum && s.stopNumber >= newNum && s.stopNumber < oldNum) return { ...s, stopNumber: s.stopNumber + 1 };
      if (newNum > oldNum && s.stopNumber <= newNum && s.stopNumber > oldNum) return { ...s, stopNumber: s.stopNumber - 1 };
      return s;
    });
  }

  // "Apply changes" in the customer editor lands here. It updates the local plan AND
  // persists it right away, so a manager's quantity edit is saved without also having
  // to click Save Route. The route stays PENDING (the same write Save Route does) —
  // the rider only receives it when they start the shift.
  function handleStopUpdate(updated: CustomerStop) {
    const merged = mergeStop(stops, updated);
    setStops(merged);
    if (locked || routeReadOnly) return; // a locked/started route can't be persisted from here
    startTransition(async () => {
      if (await saveStops(merged)) toast.success("Saved.");
    });
  }

  // ── Save ──────────────────────────────────────────────────────────────────

  // Persist a plan to the route — the write the rider app later reads. Shared by
  // Save Route and by the customer editor's "Apply changes", so both save the same
  // way. Returns whether it succeeded (caller shows the success toast).
  async function saveStops(stopsToSave: CustomerStop[]): Promise<boolean> {
    if (!listReady || !loadedFor) {
      toast.error("This shift's customers are still loading — wait a moment, then save.");
      return false;
    }
    // Free-sample stops are display-only (managed in the Free Samples tab) —
    // never saved into the route.
    const payload = stopsToSave.filter((s) => !s.isSample).map((s) => ({
      customerId: s.customerId,
      stopNumber: s.stopNumber,
      products: s.products.map((p) => ({ productId: p.productId, quantity: p.quantity })),
    }));
    // A future day goes to the plan table instead of the route — including from
    // "Apply changes", which saves on its own and would otherwise quietly create
    // tomorrow's route behind the manager's back.
    // Extras belong to today and tomorrow; a past day's are left as they are.
    const extras = extrasEditable ? extrasPayload(extraRows) : undefined;
    const res = isFutureDay
      ? await saveRoutePlan({ shiftId: selectedShiftId, date, stops: payload, extras, override: showAllShifts, loadedFor })
      : await saveRoute({ shiftId: selectedShiftId, date, stops: payload, extras, override: showAllShifts, loadedFor });
    if (!res.ok) {
      toast.error(res.error);
      return false;
    }
    if (extras) setExtrasDirty(false);
    // Pin the URL to this shift/date so a later refresh reopens this exact view
    // and shows the just-saved quantities, and remember the shift (cookie) so the
    // param-less sidebar link reopens it too.
    syncUrl(selectedShiftId, date);
    rememberShift(selectedShiftId);
    return true;
  }

  // Extras are saved on their own: they add to what the shift will carry so
  // packaging can prepare it. Assigning the shift is still Save route's job, and
  // that is where the stock is checked.
  function handleSaveExtras() {
    if (!extrasEditable) return;
    startTransition(async () => {
      const res = await saveShiftExtras({ shiftId: selectedShiftId, date, extras: extrasPayload(extraRows) });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setExtrasDirty(false);
      toast.success("Extra load saved — it is in the shift's total load for packaging.");
      loadCustomers(selectedShiftId, date, showAllShifts);
    });
  }

  function handleSave() {
    // Stock is checked against TODAY's stock, so it gates today's route only — a
    // plan for tomorrow is not spending today's milk.
    if (overStockActive && !isFutureDay) {
      toast.error("Retail has not accepted this whole load yet — packaging sends it, Retail accepts it, then save. Or reduce the quantities.");
      return;
    }
    if (locked || routeReadOnly) return; // the buttons are disabled too
    startTransition(async () => {
      if (await saveStops(stops)) {
        toast.success(isFutureDay ? "Plan saved — the rider has not been given it." : "Route saved.");
      }
    });
  }

  // ── Derived ───────────────────────────────────────────────────────────────

  // What the auto-save reads — always the stops, shift and date as they stand now.
  stopsRef.current = stops;
  loadedRef.current = loadedFor;

  const sorted = [...stops].sort((a, b) => a.stopNumber - b.stopNumber);

  const visibleStops = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return sorted;
    return sorted.filter((s) =>
      s.name.toLowerCase().includes(q) ||
      s.customerCode.toLowerCase().includes(q) ||
      s.phone.includes(q)
    );
  }, [sorted, search]);

  const existingIds = useMemo(() => new Set(stops.map((s) => s.customerId)), [stops]);
  const stats        = computeStats(stops);
  const selectedStop = stops.find((s) => s.customerId === selectedCustId) ?? null;

  // ── Stock guard (live) ────────────────────────────────────────────────────
  // The shift's whole load — customers plus extras — per product; flag any
  // stock-tracked product whose total exceeds what's available: RETAIL for today
  // (packaging sends it there), storage for a retail product or a past day. The
  // server re-checks on save; this just shows it up front and blocks the button.
  // The shift's samples are counted too: they ride this round and need the
  // stock, as on the server. Untracked products never block.
  const overStock = useMemo(() => {
    const trackedSet = new Set(tracked);
    const retailSet = new Set(fromRetail);
    const planned: Record<string, number> = {};
    for (const s of stops) {
      for (const p of s.products) if (p.quantity > 0) planned[p.productId] = (planned[p.productId] ?? 0) + p.quantity;
    }
    if (extrasEditable) for (const e of extrasPayload(extraRows)) planned[e.productId] = (planned[e.productId] ?? 0) + e.qty;
    const out: { name: string; planned: number; avail: number; unit: string; retail: boolean }[] = [];
    for (const [pid, plan] of Object.entries(planned)) {
      if (!trackedSet.has(pid)) continue;
      const avail = available[pid] ?? 0;
      if (plan > avail + 1e-6) {
        const prod = products.find((p) => p.productId === pid);
        out.push({
          name: prod?.productName ?? "Product",
          planned: Math.round(plan * 1000) / 1000,
          avail: Math.max(0, Math.round(avail * 1000) / 1000),
          unit: prod?.unit === "LITER" ? "L" : prod?.unit === "KG" ? "kg" : "pc",
          retail: retailSet.has(pid),
        });
      }
    }
    return out;
  }, [stops, available, tracked, fromRetail, products, extraRows, extrasEditable]);
  const overStockActive = overStock.length > 0 && !locked;

  // Write the order as soon as a move lands. This runs in an effect rather than
  // inside the move handler because the handler fires BEFORE React re-renders —
  // reading the stops there would send the order as it was a move ago.
  //
  // Ordering is saved on its own, never through the route re-plan: moving a
  // customer changes no quantity, so the stock ceiling and the delivery-day lock
  // have nothing to say about it. It just gets kept.
  const persistOrder = async () => {
    if (orderSaving.current) {
      orderQueued.current = true; // collapse into the write already running
      return;
    }
    // The order is the list's, so it goes to the shift the list was loaded for.
    // Mid-load there is no list; the switch already wrote the old one's order.
    const ctx = loadedRef.current;
    if (!ctx) return;
    orderSaving.current = true;
    try {
      const res = await saveDeliveryOrder({ ...ctx, loadedFor: ctx, customerIds: orderedIds(stopsRef.current) });
      if (res.ok) {
        orderSavePending.current = false;
        toast.success("Delivery order saved.");
      } else {
        toast.error(res.error);
      }
    } finally {
      orderSaving.current = false;
      if (orderQueued.current) {
        orderQueued.current = false;
        void persistOrder(); // pick up whatever moved while we were writing
      }
    }
  };

  useEffect(() => {
    if (orderTick === 0) return; // nothing has been reordered yet
    void persistOrder();
    // Keyed on the reorder counter alone: re-running on every `stops` change would
    // also fire after a quantity edit, which saves itself already.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderTick]);

  // Leaving the page (or switching shift) before the write lands still saves it.
  useEffect(() => {
    return () => flushOrder();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────

  if (shifts.length === 0) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3 p-6 text-muted-foreground">
        <Bike className="size-8 opacity-40" />
        <p className="text-sm">No shifts found. Create shifts first in Areas / Shifts.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col lg:h-[calc(100dvh-120px)]">

      {/* ── Controls bar ── */}
      <div className="flex flex-wrap items-end gap-3 border-b border-border bg-card px-4 py-3 flex-shrink-0">
        <div>
          <Label className="text-xs text-muted-foreground">Date</Label>
          <div className="mt-1 flex items-center gap-1.5">
            <Input
              type="date"
              className="h-8 w-36 text-sm"
              value={date}
              max={tomorrow}
              onChange={(e) => handleDateChange(e.target.value)}
            />
            {/* Two taps instead of a calendar — on a phone the picker cannot hide the
                days that aren't allowed, so these are the easy, safe way in. */}
            {[
              { label: "Today", day: todayPKTString() },
              { label: "Tomorrow", day: tomorrow },
            ].map((b) => (
              <button
                key={b.label}
                type="button"
                onClick={() => handleDateChange(b.day)}
                className={cn(
                  "h-8 rounded-md border px-2.5 text-xs font-medium transition",
                  date === b.day
                    ? "border-emerald-700 bg-emerald-700 text-white"
                    : "border-border bg-background hover:bg-muted"
                )}
              >
                {b.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <Label className="text-xs text-muted-foreground">Shift</Label>
          <Select value={selectedShiftId} onValueChange={handleShiftChange}>
            <SelectTrigger className="mt-1 h-8 w-48 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              {shifts.map((s) => {
                const locked = shiftLockActive && isShiftLocked(s);
                return (
                  <SelectItem key={s.id} value={s.id} disabled={locked}>
                    {s.name}
                    {locked && " (not scheduled today)"}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
          {locked && (
            <p className="mt-1 text-[10px] text-amber-600">
              {currentShift?.name} doesn&apos;t deliver on the selected date.
            </p>
          )}
        </div>

        {isAdmin && (
          <label className="flex items-center gap-1.5 pb-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={showAllShifts}
              onChange={(e) => setShowAllShifts(e.target.checked)}
              className="size-3.5"
            />
            Show all shifts (admin override)
          </label>
        )}

        <div>
          <Label className="text-xs text-muted-foreground">Rider</Label>
          <div className="mt-1 flex h-8 w-40 items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2.5 text-sm text-muted-foreground">
            <UserRound className="size-3.5 shrink-0" />
            <span className="truncate">
              {currentShift?.riderName ?? "No rider assigned"}
            </span>
          </div>
        </div>

        <div className="flex gap-2 flex-wrap ml-auto">
          <StatPill icon={Users}           label="Customers"    value={String(stops.length)} />
          <StatPill icon={Milk}            label="Total milk"   value={`${stats.milk} L`} />
          <StatPill icon={Package}         label="Pieces"       value={String(stats.pieces)} />
          <StatPill icon={BadgeDollarSign} label="Est. billing" value={`Rs ${Math.round(stats.billing).toLocaleString("en-PK")}`} />
        </div>

        {/* Save route IS the assignment — it writes the row the rider app reads — so
            it is not offered for a day that has not arrived. Tomorrow saves from the
            bar at the bottom instead. */}
        {!isFutureDay && (
          <Button
            size="sm"
            onClick={handleSave}
            disabled={isPending || !listReady || stops.length === 0 || locked || routeReadOnly || overStockActive}
            className="h-8 bg-emerald-700 hover:bg-emerald-800 text-white"
          >
            <Save className="mr-1.5 size-3.5" />
            {isPending ? "Saving…" : "Save route"}
          </Button>
        )}
      </div>

      {/* Route lifecycle banner — the rider app owns start/finish; once started the
          route is frozen. Only shown when a saved route exists (routeStatus != null). */}
      {routeStatus && !locked && (
        <div
          className={cn(
            "mx-3 mt-2 rounded-md border px-3 py-2 text-[12px]",
            routeStatus === "COMPLETED" ? "border-emerald-300 bg-emerald-50 text-emerald-800"
              : routeStatus === "IN_PROGRESS" || onRoadSince ? "border-amber-300 bg-amber-50 text-amber-800"
              : "border-border bg-muted/30 text-muted-foreground"
          )}
        >
          {routeStatus === "COMPLETED" ? (
            <span className="font-medium">Delivered{completedAt ? ` at ${fmtTimePKT(completedAt)}` : ""} — this shift is done. Its route is locked.</span>
          ) : routeStatus === "IN_PROGRESS" ? (
            <span className="font-medium">The rider has started this shift{startedAt ? ` at ${fmtTimePKT(startedAt)}` : ""} — the route can no longer be changed.</span>
          ) : onRoadSince ? (
            <span className="font-medium">The rider confirmed the load at {fmtTimePKT(onRoadSince)} — this shift is on the road and cannot be changed until the round is finished.</span>
          ) : (
            <span>Not started — you can still adjust today&apos;s quantities.</span>
          )}
        </div>
      )}

      {/* Inventory over-commit warning — blocks saving until quantities fit stock. */}
      {isFutureDay && !locked && (
        <div className="mx-3 mt-2 rounded-md border border-sky-300 bg-sky-50 px-3 py-2 text-[12px] text-sky-800">
          <span className="font-medium">
            Planning {date === tomorrow ? "tomorrow" : date} — the rider has not been given this.
          </span>{" "}
          Change quantities and order, then press <span className="font-medium">Save plan</span> at the bottom.
          On the day itself, open this page and press <span className="font-medium">Save route</span> to hand it to the rider.
        </div>
      )}

      {overStockActive && (
        <div className="mx-3 mt-2 rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-[12px] text-rose-800">
          <p className="font-semibold">
            {overStock.some((o) => o.retail) ? "Not enough in Retail to assign this shift:" : "Not enough stock to send this route:"}
          </p>
          <ul className="mt-1 list-disc pl-4">
            {overStock.map((o) => (
              <li key={o.name}>
                {o.name}: {o.planned}{o.unit} needed, only {o.avail}{o.unit} {o.retail ? "in Retail" : "in storage"}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-rose-700/80">
            {isFutureDay
              ? "That is today's stock — a plan for a later day can still be saved."
              : overStock.some((o) => o.retail)
                ? "Only what Retail has accepted counts. Packaging sends it, Retail accepts it on the Retail page — then save the route. Or reduce quantities."
                : "Reduce quantities or add stock before saving."}
          </p>
        </div>
      )}

      {/* ── Main area ── */}
      {locked ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground">
          <CalendarDays className="size-8 opacity-40" />
          <p className="text-sm font-medium text-foreground">
            {currentShift?.name} doesn&apos;t deliver on the selected date.
          </p>
          <p className="max-w-sm text-xs">
            This shift isn&apos;t scheduled for the selected date, so there&apos;s nothing to
            show or save. {isAdmin && "Check “Show all shifts” above to view or edit it anyway."}
          </p>
        </div>
      ) : (
      <div className="flex flex-1 flex-col lg:flex-row lg:overflow-hidden">

        {/* Master–detail. Below lg the two panes STACK and the WHOLE PAGE scrolls
            normally (no fixed height, no nested scroll regions) — the fixed-height
            + inner-scroll layout is lg-only, since on a phone it squeezed the
            customer list off-screen. Desktop (lg+) unchanged. */}

        {/* Left — customer list. On mobile it sits BELOW the summary (order-2) so the
            shift load / items-to-deliver aren't buried under a long customer list. */}
        <div className="order-2 w-full flex-shrink-0 flex flex-col lg:order-1 lg:w-[380px] lg:border-r lg:overflow-hidden">

          {/* Inventory strip */}
          {stops.length > 0 && (
            <div className="border-b border-border bg-muted/30 px-4 py-2 flex-shrink-0">
              <p className="text-[9px] uppercase tracking-wider text-muted-foreground mb-1.5">
                Total load rider takes
              </p>
              <div className="flex flex-wrap gap-1.5">
                {(() => {
                  // Customers plus the extras the rider takes.
                  const totals: Record<string, { qty: number; unit: string }> = {};
                  const addLine = (name: string, unit: string, qty: number) => {
                    if (qty <= 0) return;
                    if (!totals[name]) totals[name] = { qty: 0, unit };
                    totals[name].qty += qty;
                  };
                  for (const s of stops) for (const p of s.products) addLine(p.productName, p.unit, p.quantity);
                  for (const e of extrasPayload(extraRows)) {
                    const prod = products.find((p) => p.productId === e.productId);
                    if (prod) addLine(prod.productName, prod.unit, e.qty);
                  }
                  for (const e of settledExtras) addLine(e.productName, e.unit, e.qty);
                  return Object.entries(totals).map(([name, { qty, unit }]) => (
                    <span key={name} className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2.5 py-0.5 text-[11px] font-medium">
                      <span className="text-muted-foreground">{name}</span>
                      <span>{Math.round(qty * 1000) / 1000}{unit === "LITER" ? "L" : unit === "KG" ? "kg" : "pc"}</span>
                    </span>
                  ));
                })()}
              </div>
            </div>
          )}

          {/* Search + Add button */}
          <div className="border-b border-border px-3 py-2 flex-shrink-0 space-y-2">
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
                <Input
                  placeholder="Search in route…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="h-7 pl-8 text-xs"
                />
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1 text-xs shrink-0"
                disabled={routeReadOnly}
                onClick={() => setAddDialogOpen(true)}
              >
                <UserPlus className="size-3.5" />
                Add
              </Button>
            </div>
            {search && (
              <p className="text-[10px] text-muted-foreground">
                {visibleStops.length} of {sorted.length} shown — <button className="underline" onClick={() => setSearch("")}>clear</button>
              </p>
            )}
          </div>

          {/* Customer list — flows at full length on mobile (the page scrolls);
              fills + scrolls within the pane on desktop. */}
          <div className="lg:flex-1 lg:overflow-y-auto">
            {loadingStops ? (
              <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
                <Loader2 className="mr-2 size-4 animate-spin" /> Loading…
              </div>
            ) : sorted.length === 0 ? (
              <div className="flex h-40 flex-col items-center justify-center gap-3 text-muted-foreground">
                <Users className="size-6 opacity-40" />
                <p className="text-sm">No customers in this route.</p>
                <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" disabled={routeReadOnly} onClick={() => setAddDialogOpen(true)}>
                  <UserPlus className="size-3.5" /> Add customer
                </Button>
              </div>
            ) : visibleStops.length === 0 ? (
              <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
                No customers match &quot;{search}&quot;
              </div>
            ) : (
              visibleStops.map((stop, idx) => {
                const av        = AVATARS[idx % AVATARS.length];
                const isSelected = stop.customerId === selectedCustId;
                const isFirst    = stop.stopNumber === sorted[0]?.stopNumber;
                const isLast     = stop.stopNumber === sorted[sorted.length - 1]?.stopNumber;
                return (
                  <div
                    key={stop.customerId}
                    draggable={!routeReadOnly}
                    onDragStart={(e) => !routeReadOnly && handleDragStart(e, stop.customerId)}
                    onDragOver={(e) => !routeReadOnly && handleDragOver(e)}
                    onDrop={(e) => !routeReadOnly && handleDrop(e, stop.customerId)}
                    onDragEnd={handleDragEnd}
                    onClick={() => selectCustomer(isSelected ? null : stop.customerId)}
                    className={`flex items-center gap-0 px-3 py-2.5 border-b border-border cursor-pointer select-none transition-colors ${
                      isSelected ? "bg-blue-50 border-l-[3px] border-l-primary" : "hover:bg-muted/30"
                    }`}
                  >
                    {/* Stop number + grip */}
                    <div className="flex flex-col items-center w-9 flex-shrink-0 gap-1">
                      <div className="size-6 rounded-full bg-primary flex items-center justify-center text-[10px] font-medium text-primary-foreground">
                        {stop.stopNumber}
                      </div>
                      <GripVertical className="size-3.5 text-muted-foreground/40" />
                    </div>

                    {/* Avatar */}
                    <div className={`size-8 rounded-full flex items-center justify-center text-[11px] font-semibold mx-2 flex-shrink-0 ${av.bg} ${av.tc}`}>
                      {initials(stop.name)}
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <p className="flex items-center gap-1.5 text-xs font-semibold truncate">
                        <span className="truncate">{stop.name}</span>
                        {stop.isSample && (
                          <span className="shrink-0 rounded-full bg-violet-100 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wide text-violet-700">
                            Sample
                          </span>
                        )}
                      </p>
                      <p className="text-[10px] text-muted-foreground truncate">
                        {fmtQty(stop.products)}
                        {stop.isSample && (() => {
                          const amt = stop.products.reduce((s, p) => s + p.quantity * p.rate, 0);
                          return amt > 0 ? <span className="font-semibold text-violet-700"> · Rs {Math.round(amt).toLocaleString("en-PK")} to collect</span> : null;
                        })()}
                      </p>
                    </div>

                    {/* Reorder + remove buttons */}
                    <div className="flex items-center gap-0.5 ml-2 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => moveUp(stop.customerId)}
                        disabled={isFirst || routeReadOnly}
                        className="size-6 flex items-center justify-center rounded border border-border bg-muted/40 text-muted-foreground hover:bg-emerald-50 hover:text-emerald-700 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                        title="Move up"
                      >
                        <ChevronUp className="size-3" />
                      </button>
                      <button
                        onClick={() => moveDown(stop.customerId)}
                        disabled={isLast || routeReadOnly}
                        className="size-6 flex items-center justify-center rounded border border-border bg-muted/40 text-muted-foreground hover:bg-emerald-50 hover:text-emerald-700 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                        title="Move down"
                      >
                        <ChevronDown className="size-3" />
                      </button>
                      <button
                        onClick={() => removeStop(stop.customerId)}
                        disabled={routeReadOnly}
                        className="size-6 flex items-center justify-center rounded border border-border bg-muted/40 text-muted-foreground hover:bg-rose-50 hover:text-rose-600 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                        title="Remove from route"
                      >
                        <X className="size-3" />
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right — editor or shift summary. On mobile it shows FIRST (order-1) so the
            shift load summary / items to deliver are visible without scrolling the list. */}
        <div className="order-1 border-b border-border lg:order-2 lg:flex-1 lg:border-b-0 lg:overflow-hidden">
          {selectedStop ? (
            <CustomerEditor
              key={selectedStop.customerId}
              stop={selectedStop}
              allProducts={products}
              allStops={stops}
              readOnly={routeReadOnly}
              onUpdate={handleStopUpdate}
              onClose={() => setSelectedCustId(null)}
            />
          ) : (
            <ShiftSummaryPanel
              stops={stops}
              riderName={currentShift?.riderName ?? null}
              shiftName={currentShift?.name ?? ""}
              riderId={currentShift?.riderId ?? null}
              products={products}
              extras={{
                rows: extraRows,
                onChange: (rows) => { setExtraRows(rows); setExtrasDirty(true); },
                settled: settledExtras,
                editable: extrasEditable,
                dirty: extrasDirty,
                saving: isPending,
                onSave: handleSaveExtras,
              }}
            />
          )}
        </div>
      </div>
      )}

      {/* Saving a future day. Deliberately its own button, and deliberately not the
          green one above: this writes a plan, which no rider can see. */}
      {isFutureDay && !locked && (
        <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 border-t border-border bg-card/95 px-4 py-3 backdrop-blur">
          <p className="text-[11px] text-muted-foreground">
            Saved as a plan for {date}. The rider only gets it when you open that day and press{" "}
            <span className="font-medium text-foreground">Save route</span>.
          </p>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={isPending || !listReady || stops.length === 0 || locked || routeReadOnly}
            className="h-8 bg-sky-700 text-white hover:bg-sky-800"
          >
            <Save className="mr-1.5 size-3.5" />
            {isPending ? "Saving…" : "Save plan"}
          </Button>
        </div>
      )}

      {/* Add customer dialog */}
      <AddCustomerDialog
        open={addDialogOpen}
        currentShiftId={selectedShiftId}
        currentShiftName={currentShift?.name ?? "this shift"}
        date={date}
        existingIds={existingIds}
        onAdd={handleAddCustomer}
        onClose={() => setAddDialogOpen(false)}
      />
    </div>
  );
}
