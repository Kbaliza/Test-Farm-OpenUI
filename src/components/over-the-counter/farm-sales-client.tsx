"use client";

import { useState, useMemo, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Plus, Trash2, Save, RotateCcw, Eye, Tractor } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { SearchCombobox, type ComboItem } from "@/components/ui/search-combobox";
import { useAppRefresh } from "@/lib/use-app-refresh";
import { todayPKTString } from "@/lib/pkt";
import {
  FARM_SALE_CATEGORIES, unitsFor, itemsFor, detailFieldsFor, categoryHasTag,
} from "@/lib/farm-sale-catalog";
import {
  createFarmSale, deleteFarmSale, getFarmSalesContext, getFarmSalesHistory,
  type FarmSalesContext, type FarmSaleView,
} from "@/app/(dashboard)/over-the-counter/farm-sales/actions";
import { FarmSaleInvoiceDialog } from "./farm-sale-invoice-dialog";
import { canReceiveInto } from "@/lib/payment-heads";

const money = (n: number) => Math.round(n).toLocaleString("en-PK");

// A line's own editing state. `details` is the free-form answers for whatever fields
// the chosen category asks for; it is filtered down to that category on save, so
// switching category never smuggles a stale field through.
type Line = {
  key: string;
  category: string;
  item: string;
  unit: string;
  rate: number;
  quantity: number;
  animalTag: string;
  details: Record<string, string>;
};

function emptyLine(): Line {
  return {
    key: Math.random().toString(36).slice(2),
    category: "", item: "", unit: "", rate: 0, quantity: 0, animalTag: "", details: {},
  };
}

export function FarmSalesClient({
  context,
  initialHistory,
}: {
  context: FarmSalesContext;
  initialHistory: FarmSaleView[];
}) {
  const router = useRouter();
  const [ctx, setCtx] = useState(context);
  const [history, setHistory] = useState(initialHistory);
  const [pending, start] = useTransition();

  const [date, setDate] = useState(context.today);
  const [buyerType, setBuyerType] = useState<"VENDOR" | "CASH">("VENDOR");
  const [vendorId, setVendorId] = useState("");
  const [cashName, setCashName] = useState("");
  const [transport, setTransport] = useState(0);
  const [gatePass, setGatePass] = useState("");
  const [narration, setNarration] = useState("");
  // Never heads[0] — that is Rider Cash, and money must not default into the riders'
  // box from a desk screen. (The server refuses it outright; this keeps the UI honest.)
  const [paymentHead, setPaymentHead] = useState("CASH");
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const [viewSale, setViewSale] = useState<FarmSaleView | null>(null);

  // Keeps the head list and the next invoice number current when the topbar refresh
  // fires, the same way the OTC screens do.
  useAppRefresh(async () => {
    const [c, h] = await Promise.all([getFarmSalesContext(), getFarmSalesHistory()]);
    if (c.dbReady) setCtx(c);
    if (h.dbReady) setHistory(h.sales);
  });

  const linesTotal = lines.reduce((s, l) => s + l.rate * l.quantity, 0);
  const grandTotal = linesTotal + (transport || 0);

  const vendorItems: ComboItem[] = useMemo(
    () => ctx.vendors.map((v) => ({ value: v.id, label: v.name, sublabel: v.phone ?? undefined })),
    [ctx.vendors]
  );
  // Money coming in: not Rider Cash, not Meezan (the owners' account).
  const headItems = ctx.heads.filter((h) => canReceiveInto(h.head));

  function patchLine(key: string, patch: Partial<Line>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function pickCategory(key: string, category: string) {
    // A unit only belongs to one category, so switching resets it (and the details,
    // which are a different set of questions entirely).
    const units = unitsFor(category);
    patchLine(key, {
      category,
      unit: units[0] ?? "",
      details: {},
      animalTag: "",
      quantity: category === "animal" ? 1 : 0,
    });
  }

  function resetForm() {
    setDate(todayPKTString());
    setBuyerType("VENDOR"); setVendorId(""); setCashName("");
    setTransport(0); setGatePass(""); setNarration("");
    setPaymentHead("CASH");
    setLines([emptyLine()]);
  }

  function handleSave() {
    const filled = lines.filter((l) => l.category && l.item.trim() && l.rate > 0 && l.quantity > 0);
    if (!filled.length) { toast.error("Add at least one item with a rate and quantity."); return; }
    if (buyerType === "VENDOR" && !vendorId) { toast.error("Select the vendor this was sold to."); return; }
    if (!paymentHead) { toast.error("Select the account this money was received into."); return; }

    start(async () => {
      const res = await createFarmSale({
        date, buyerType, vendorId: vendorId || null, cashName: cashName || null,
        transportCharge: transport || 0, gatePassNo: gatePass || null, narration: narration || null,
        paymentHead,
        lines: filled.map((l) => ({
          category: l.category, item: l.item.trim(), unit: l.unit,
          rate: l.rate, quantity: l.quantity,
          animalTag: l.animalTag || null, details: l.details,
        })),
      });
      if (!res.ok) { toast.error(res.error); return; }
      const [c, h] = await Promise.all([getFarmSalesContext(), getFarmSalesHistory()]);
      if (c.dbReady) setCtx(c);
      if (h.dbReady) {
        setHistory(h.sales);
        setViewSale(h.sales.find((s) => s.id === res.id) ?? null);
      }
      resetForm();
      toast.success(`Sale saved · ${res.invoiceNo}`);
      router.refresh();
    });
  }

  function handleDelete(sale: FarmSaleView) {
    if (!window.confirm(`Delete ${sale.invoiceNo}? This also removes the Rs ${money(sale.totalAmount)} it put into ${sale.paymentHead}.`)) return;
    start(async () => {
      const res = await deleteFarmSale(sale.id);
      if (!res.ok) { toast.error(res.error); return; }
      const [c, h] = await Promise.all([getFarmSalesContext(), getFarmSalesHistory()]);
      if (c.dbReady) setCtx(c);
      if (h.dbReady) setHistory(h.sales);
      toast.success("Sale deleted and the money reversed.");
      router.refresh();
    });
  }

  const historyTotal = history.reduce((s, h) => s + h.totalAmount, 0);

  return (
    <div className="space-y-5">
      {/* ── Form ─────────────────────────────────────────────────────────── */}
      <Card>
        <CardContent className="pt-6">
          <div className="grid gap-4 md:grid-cols-2 md:gap-x-8">
            <div className="space-y-4">
              <Field label="Invoice No">
                <Input value={ctx.nextInvoiceNo} readOnly className="h-9 bg-muted/50 font-mono text-sm" />
              </Field>
              <Field label="Sale Date">
                <Input type="date" value={date} max={todayPKTString()} onChange={(e) => setDate(e.target.value)} className="h-9 text-sm" />
              </Field>
              <Field label="Buyer Type">
                <div className="flex overflow-hidden rounded-md border border-border">
                  {(["VENDOR", "CASH"] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => { setBuyerType(t); setVendorId(""); setCashName(""); }}
                      className={cn(
                        "flex-1 border-r border-border px-3 py-2 text-[11px] font-semibold uppercase tracking-wide last:border-r-0 transition-colors",
                        buyerType === t ? "bg-emerald-700 text-white" : "bg-background text-muted-foreground hover:bg-muted/50"
                      )}
                    >
                      {t === "VENDOR" ? "Vendor" : "Cash walk-in"}
                    </button>
                  ))}
                </div>
              </Field>
              {buyerType === "VENDOR" ? (
                <Field label="Vendor">
                  <SearchCombobox
                    items={vendorItems}
                    value={vendorId}
                    onChange={setVendorId}
                    placeholder="Search vendors…"
                  />
                </Field>
              ) : (
                <Field label="Buyer name">
                  <Input value={cashName} onChange={(e) => setCashName(e.target.value)} placeholder="Walk-in (optional)" className="h-9 text-sm" />
                </Field>
              )}
              <Field label="Received Into">
                <Select value={paymentHead} onValueChange={setPaymentHead}>
                  <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {headItems.map((h) => (
                      <SelectItem key={h.head} value={h.head} className="text-xs">
                        {h.label} <span className="text-muted-foreground">· Rs {money(h.balance)}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>

            <div className="space-y-4">
              <Field label="Transport Charge">
                <Input
                  type="number" inputMode="decimal" min={0}
                  value={transport || ""}
                  onChange={(e) => setTransport(parseFloat(e.target.value) || 0)}
                  placeholder="0" className="h-9 font-mono text-sm"
                />
              </Field>
              <Field label="Gate Pass No">
                <Input value={gatePass} onChange={(e) => setGatePass(e.target.value)} placeholder="For animals and machinery leaving the farm" className="h-9 text-sm" />
              </Field>
              <div className="grid grid-cols-[130px_1fr] items-start gap-3">
                <Label className="pt-2 text-xs text-muted-foreground">Narration</Label>
                <Textarea value={narration} onChange={(e) => setNarration(e.target.value)} rows={4} placeholder="Optional note against this sale" className="min-h-[104px] text-sm" />
              </div>
            </div>
          </div>

          {/* ── Line items ─────────────────────────────────────────────── */}
          <div className="mt-5 rounded-lg border border-border">
            <div className="flex items-center justify-between border-b border-border bg-muted/40 px-3 py-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Sale Items</p>
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setLines((p) => [...p, emptyLine()])}>
                <Plus className="mr-1 size-3.5" /> Add item
              </Button>
            </div>

            <div className="divide-y divide-border">
              {lines.map((l) => {
                const fields = detailFieldsFor(l.category);
                const hasTag = categoryHasTag(l.category);
                return (
                  <div key={l.key} className="space-y-2 p-3">
                    <div className="grid grid-cols-2 items-end gap-2 sm:flex sm:flex-wrap">
                      <div className="col-span-2 sm:w-40">
                        <Label className="text-[11px] text-muted-foreground">Category</Label>
                        <Select value={l.category} onValueChange={(v) => pickCategory(l.key, v)}>
                          <SelectTrigger className="mt-1 h-9 text-sm"><SelectValue placeholder="Choose…" /></SelectTrigger>
                          <SelectContent>
                            {FARM_SALE_CATEGORIES.map((c) => (
                              <SelectItem key={c.key} value={c.key} className="text-xs">{c.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="col-span-2 min-w-0 sm:flex-1">
                        <Label className="text-[11px] text-muted-foreground">Item</Label>
                        <Input
                          list={`items-${l.key}`}
                          value={l.item}
                          disabled={!l.category}
                          onChange={(e) => patchLine(l.key, { item: e.target.value })}
                          placeholder={l.category ? "Type or pick an item" : "Choose a category first"}
                          className="mt-1 h-9 text-sm"
                        />
                        {/* Suggestions only — a farm sells things nobody listed. */}
                        <datalist id={`items-${l.key}`}>
                          {itemsFor(l.category).map((i) => <option key={i} value={i} />)}
                        </datalist>
                      </div>
                      <div className="col-span-1 sm:w-24">
                        <Label className="text-[11px] text-muted-foreground">Unit</Label>
                        <Select value={l.unit} onValueChange={(v) => patchLine(l.key, { unit: v })} disabled={!l.category}>
                          <SelectTrigger className="mt-1 h-9 text-sm"><SelectValue placeholder="—" /></SelectTrigger>
                          <SelectContent>
                            {unitsFor(l.category).map((u) => <SelectItem key={u} value={u} className="text-xs">{u}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="col-span-1 sm:w-28">
                        <Label className="text-[11px] text-muted-foreground">Rate</Label>
                        <Input type="number" inputMode="decimal" min={0} value={l.rate || ""} onChange={(e) => patchLine(l.key, { rate: parseFloat(e.target.value) || 0 })} className="mt-1 h-9 text-right font-mono text-sm" />
                      </div>
                      <div className="col-span-1 sm:w-24">
                        <Label className="text-[11px] text-muted-foreground">Qty</Label>
                        <Input type="number" inputMode="decimal" min={0} step="0.01" value={l.quantity || ""} onChange={(e) => patchLine(l.key, { quantity: parseFloat(e.target.value) || 0 })} className="mt-1 h-9 text-right font-mono text-sm" />
                      </div>
                      <div className="col-span-1 sm:w-28">
                        <Label className="text-[11px] text-muted-foreground">Total</Label>
                        <p className="mt-1 flex h-9 items-center justify-end font-mono text-sm font-semibold">{money(l.rate * l.quantity)}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setLines((p) => (p.length > 1 ? p.filter((x) => x.key !== l.key) : p))}
                        disabled={lines.length === 1}
                        className="mb-1 grid size-9 shrink-0 place-items-center justify-self-end rounded-md border border-border text-muted-foreground hover:border-rose-200 hover:text-rose-600 disabled:opacity-30"
                        title="Remove item"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>

                    {/* Whatever extra the category asks for. Animals get a tag in its
                        own field because that is the one detail stored as a column. */}
                    {(hasTag || fields.length > 0) && (
                      <div className="flex flex-wrap gap-2 rounded-md bg-muted/30 p-2">
                        {hasTag && (
                          <div className="w-28">
                            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Tag no.</Label>
                            <Input value={l.animalTag} onChange={(e) => patchLine(l.key, { animalTag: e.target.value })} className="mt-1 h-8 text-xs" />
                          </div>
                        )}
                        {fields.map((f) => (
                          <div key={f.k} className="w-36">
                            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">{f.label}</Label>
                            {f.options ? (
                              <Select
                                value={l.details[f.k] ?? ""}
                                onValueChange={(v) => patchLine(l.key, { details: { ...l.details, [f.k]: v } })}
                              >
                                <SelectTrigger className="mt-1 h-8 text-xs"><SelectValue placeholder="—" /></SelectTrigger>
                                <SelectContent>
                                  {f.options.map((o) => <SelectItem key={o} value={o} className="text-xs">{o}</SelectItem>)}
                                </SelectContent>
                              </Select>
                            ) : (
                              <Input
                                type={f.type === "number" ? "number" : "text"}
                                value={l.details[f.k] ?? ""}
                                onChange={(e) => patchLine(l.key, { details: { ...l.details, [f.k]: e.target.value } })}
                                className="mt-1 h-8 text-xs"
                              />
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="flex items-center justify-end gap-3 border-t border-border bg-muted/30 px-3 py-2.5">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Items</span>
              <span className="mr-3 font-mono text-base font-bold">Rs {money(linesTotal)}</span>
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Total</span>
              <span className="font-mono text-lg font-bold">Rs {money(grandTotal)}</span>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <p className="text-xs text-muted-foreground">
              No stock is deducted — nothing here is a catalogue product. The sale is paid in full,
              so the money lands in the chosen account straight away.
            </p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={resetForm} disabled={pending}>
                <RotateCcw className="mr-1.5 size-4" /> Reset
              </Button>
              <Button onClick={handleSave} disabled={pending}>
                <Save className="mr-1.5 size-4" /> {pending ? "Saving…" : "Save sale"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── History ──────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <Tractor className="size-4" /> Sale History
          </CardTitle>
          <span className="font-mono text-xs text-muted-foreground">
            {history.length} {history.length === 1 ? "sale" : "sales"} · Rs {money(historyTotal)}
          </span>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-xs">
              <thead className="bg-muted/40">
                <tr>
                  {["Invoice", "Date", "Buyer", "Items", "Received Into", "Amount", ""].map((h, i) => (
                    <th key={h || i} className={`border-b border-border px-3 py-2 font-medium text-muted-foreground ${i === 3 || i === 5 ? "text-right" : "text-left"}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {history.length === 0 ? (
                  <tr><td colSpan={7} className="py-10 text-center text-sm text-muted-foreground">No farm sales recorded yet.</td></tr>
                ) : history.map((h) => (
                  <tr key={h.id} className="border-b border-border/50 hover:bg-muted/20">
                    <td className="px-3 py-2 font-mono font-semibold text-emerald-700">{h.invoiceNo}</td>
                    <td className="px-3 py-2 text-muted-foreground">{new Date(h.date).toLocaleDateString("en-GB")}</td>
                    <td className="px-3 py-2">
                      <span className="mr-1.5 rounded-full border border-border px-1.5 py-0.5 text-[9px] font-bold uppercase text-muted-foreground">
                        {h.buyerType === "VENDOR" ? "Vendor" : "Cash"}
                      </span>
                      {h.buyerName}
                    </td>
                    <td className="px-3 py-2 text-right text-muted-foreground">{h.lines.length}</td>
                    <td className="px-3 py-2 text-muted-foreground">{h.paymentHead}</td>
                    <td className="px-3 py-2 text-right font-mono font-semibold">{money(h.totalAmount)}</td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-1">
                        <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={() => setViewSale(h)}>
                          <Eye className="mr-1 size-3" /> Invoice
                        </Button>
                        <button
                          type="button"
                          onClick={() => handleDelete(h)}
                          disabled={pending}
                          className="grid size-7 place-items-center rounded-md border border-border text-muted-foreground hover:border-rose-200 hover:text-rose-600 disabled:opacity-30"
                          title="Delete this sale and reverse the money"
                        >
                          <Trash2 className="size-3" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <FarmSaleInvoiceDialog sale={viewSale} onClose={() => setViewSale(null)} />
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[130px_1fr] items-center gap-3">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
