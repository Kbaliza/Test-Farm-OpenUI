"use client";

import { unitLabel } from "@/lib/units";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { useAppRefresh } from "@/lib/use-app-refresh";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { SearchCombobox, type ComboItem } from "@/components/ui/search-combobox";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Save, RotateCcw, Trash2 } from "lucide-react";
import {
  createOtcSale, deleteOtcSale, getOtcSaleContext, getOtcSaleHistory,
  type OtcSaleContext, type OtcSaleHistoryEntry,
} from "@/app/(dashboard)/over-the-counter/sale/actions";
import { OtcLineEditor, emptyLine, fmtMoney, type OtcLineRow } from "./otc-line-editor";
import { OtcInvoiceDialog, type OtcInvoiceView } from "./otc-invoice-dialog";
import { todayPKTString } from "@/lib/pkt";
import { canReceiveInto } from "@/lib/payment-heads";

const TAG_LABEL: Record<string, string> = { CASH: "Cash", REGULAR: "Regular", VENDOR: "Vendor", RETAIL: "Mart" };

type CustomerType = "CASH" | "REGULAR" | "VENDOR" | "RETAIL";

export function OtcSaleClient({
  context,
  initialHistory,
}: {
  context: OtcSaleContext;
  initialHistory: OtcSaleHistoryEntry[];
}) {
  const [isPending, startTransition] = useTransition();

  // Live context (products+onHand, customers, vendors, heads, next invoice no).
  // Seeded from the server prop, re-fetched when the topbar Refresh is pressed so
  // available-stock, head balances and the invoice number stay current.
  const [ctx, setCtx] = useState(context);

  const [date, setDate] = useState(todayPKTString());
  const [customerType, setCustomerType] = useState<CustomerType>("CASH");
  const [cashName, setCashName] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [retailVendorId, setRetailVendorId] = useState("");
  const [deliveryCharge, setDeliveryCharge] = useState(0);
  const [narration, setNarration] = useState("");
  const [paymentStatus, setPaymentStatus] = useState<"PAID" | "CREDIT">("PAID");
  // When "On Credit" is chosen, the buyer can still settle part of it now. This is
  // that amount; the remainder (grandTotal − payingNow) rides on credit.
  const [payingNow, setPayingNow] = useState(0);
  // Default the receiving account to CASH, not heads[0] (RIDER_CASH). A desk/counter
  // sale isn't rider-collected cash; depositing it into RIDER_CASH created a phantom
  // that can never be confirmed-received and permanently inflated "Cash In Hand".
  const [paymentHead, setPaymentHead] = useState("CASH");
  const [lines, setLines] = useState<OtcLineRow[]>([emptyLine()]);

  const [history, setHistory] = useState<OtcSaleHistoryEntry[]>(initialHistory);
  const [nextInvoiceNo, setNextInvoiceNo] = useState(ctx.nextInvoiceNo);
  const [viewInvoice, setViewInvoice] = useState<OtcInvoiceView | null>(null);

  useAppRefresh(() => {
    getOtcSaleContext().then((c) => { setCtx(c); setNextInvoiceNo(c.nextInvoiceNo); }).catch(() => {});
    getOtcSaleHistory().then((r) => setHistory(r.sales)).catch(() => {});
  });

  function handleDelete(t: OtcSaleHistoryEntry) {
    const cash = t.paidAmount > 0.005 ? ` and takes Rs ${fmtMoney(t.paidAmount)} back out of ${t.paymentHead}` : "";
    const owed = t.totalAmount - t.paidAmount > 0.005 ? ` and clears the Rs ${fmtMoney(t.totalAmount - t.paidAmount)} ${t.partyName} still owes for it` : "";
    if (!window.confirm(`Delete ${t.invoiceNo}? This puts the stock back${cash}${owed}.`)) return;
    startTransition(async () => {
      const res = await deleteOtcSale(t.id);
      if (!res.ok) { toast.error(res.error); return; }
      const [c, h] = await Promise.all([getOtcSaleContext(), getOtcSaleHistory()]);
      setCtx(c);
      setNextInvoiceNo(c.nextInvoiceNo);
      if (h.dbReady) setHistory(h.sales);
      toast.success(`${t.invoiceNo} deleted — stock, money and what was owed all reversed.`);
    });
  }

  function handleCustomerTypeChange(type: CustomerType) {
    setCustomerType(type);
    if (type === "CASH" && paymentStatus === "CREDIT") setPaymentStatus("PAID");
  }

  function handlePaymentStatusChange(status: "PAID" | "CREDIT") {
    setPaymentStatus(status);
    if (status === "PAID") setPayingNow(0); // Pay Now settles the full total
  }

  function handleCustomerChange(id: string) {
    setCustomerId(id);
    const c = ctx.customers.find((x) => x.customerId === id);
    setDeliveryCharge(c?.deliveryCharge ?? 0);
  }

  function resetForm() {
    setDate(todayPKTString());
    setCustomerType("CASH");
    setCashName("");
    setCustomerId("");
    setVendorId("");
    setDeliveryCharge(0);
    setNarration("");
    setPaymentStatus("PAID");
    setPayingNow(0);
    setPaymentHead("CASH");
    setLines([emptyLine()]);
  }

  const linesTotal = lines.reduce((s, l) => s + l.rate * l.quantity, 0);
  const grandTotal = linesTotal + (deliveryCharge || 0);
  // Cash settled now: the whole total when "Pay Now", else the (clamped) partial
  // amount typed under "On Credit". The credit remainder is grandTotal − paidNow.
  const paidNow = paymentStatus === "PAID" ? grandTotal : Math.min(Math.max(payingNow || 0, 0), grandTotal);
  const creditRemainder = Math.max(0, grandTotal - paidNow);
  // Display-only label mirroring the server's derivation.
  const derivedStatus: "PAID" | "PARTIAL" | "CREDIT" =
    paidNow <= 0.005 ? "CREDIT" : paidNow >= grandTotal - 0.005 ? "PAID" : "PARTIAL";

  const customerItems: ComboItem[] = ctx.customers.map((c) => ({
    value: c.customerId, label: c.name, sublabel: c.customerCode,
  }));
  const vendorItems: ComboItem[] = ctx.vendors.map((v) => ({
    value: v.vendorId, label: v.name,
  }));
  const retailItems: ComboItem[] = ctx.retailVendors.map((v) => ({
    value: v.vendorId, label: v.name,
  }));

  function handleSave() {
    const validLines = lines.filter((l) => l.productId && l.quantity > 0);
    if (!validLines.length) return toast.error("Add at least one item with a quantity.");
    if (customerType === "REGULAR" && !customerId) return toast.error("Select a customer.");
    if (customerType === "VENDOR" && !vendorId) return toast.error("Select a vendor.");
    if (customerType === "RETAIL" && !retailVendorId) return toast.error("Select a shop.");
    if (paymentStatus === "CREDIT" && payingNow > grandTotal + 0.005)
      return toast.error("Paying now can't be more than the total.");
    if (paidNow > 0.005 && !paymentHead) return toast.error("Select a payment account for the amount paid now.");

    // Client-side stock guard (the server re-checks authoritatively). Sum per
    // product across lines, then compare each against current on-hand.
    const wantByProduct = new Map<string, number>();
    for (const l of validLines) wantByProduct.set(l.productId, (wantByProduct.get(l.productId) ?? 0) + l.quantity);
    for (const [productId, want] of wantByProduct) {
      const prod = ctx.products.find((p) => p.productId === productId);
      const have = prod?.onHand ?? 0;
      if (want > have + 1e-6) {
        return toast.error(`Not enough stock for ${prod?.productName ?? "this product"}: ${have} in storage, ${want} requested.`);
      }
    }

    startTransition(async () => {
      const res = await createOtcSale({
        date,
        customerType,
        customerId: customerType === "REGULAR" ? customerId : null,
        vendorId: customerType === "VENDOR" ? vendorId : null,
        retailVendorId: customerType === "RETAIL" ? retailVendorId : null,
        cashName: customerType === "CASH" ? cashName : null,
        deliveryCharge,
        narration,
        paidAmount: paidNow,
        paymentHead: paidNow > 0.005 ? paymentHead : null,
        lines: validLines.map((l) => ({ productId: l.productId, unit: l.unit, rate: l.rate, quantity: l.quantity })),
      });
      if (!res.ok) { toast.error(res.error); return; }

      const partyName =
        customerType === "REGULAR" ? (ctx.customers.find((c) => c.customerId === customerId)?.name ?? "—")
        : customerType === "VENDOR" ? (ctx.vendors.find((v) => v.vendorId === vendorId)?.name ?? "—")
        : customerType === "RETAIL" ? (ctx.retailVendors.find((v) => v.vendorId === retailVendorId)?.name ?? "—")
        : (cashName.trim() || "Walk-in");

      const lineViews = validLines.map((l) => ({
        productId: l.productId,
        productName: ctx.products.find((p) => p.productId === l.productId)?.productName ?? "",
        unit: l.unit, rate: l.rate, quantity: l.quantity, amount: l.rate * l.quantity,
      }));

      const paidHead = paidNow > 0.005 ? paymentHead : null;
      const entry: OtcSaleHistoryEntry = {
        id: res.id, invoiceNo: res.invoiceNo, date: new Date(date + "T12:00:00").toISOString(),
        customerType, partyName, deliveryCharge, narration,
        totalAmount: grandTotal, paidAmount: paidNow, paymentStatus: derivedStatus, paymentHead: paidHead,
        lines: lineViews,
      };
      setHistory((prev) => [entry, ...prev]);
      setViewInvoice({
        kind: "sale", invoiceNo: res.invoiceNo, date: entry.date,
        partyLabel: "Billed To", partyName, tag: TAG_LABEL[customerType],
        deliveryCharge, narration, totalAmount: grandTotal, paidAmount: paidNow,
        paymentStatus: derivedStatus, paymentHead: paidHead, lines: lineViews,
      });
      resetForm();
      const n = res.invoiceNo.match(/(\d+)$/)?.[1];
      if (n) setNextInvoiceNo(`SAL-${String(Number(n) + 1).padStart(4, "0")}`);
      toast.success(`${res.invoiceNo} saved · Rs ${fmtMoney(grandTotal)}`);
    });
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardContent className="space-y-5 pt-6">
          <div className="grid grid-cols-1 gap-x-8 gap-y-4 md:grid-cols-2">
            <div className="space-y-4">
              <div className="grid grid-cols-[130px_1fr] items-center gap-3">
                <Label className="text-xs text-muted-foreground">Invoice No</Label>
                <Input
                  value={nextInvoiceNo}
                  disabled
                  className="h-9 text-sm bg-muted/40 font-mono"
                />
              </div>
              <div className="grid grid-cols-[130px_1fr] items-center gap-3">
                <Label className="text-xs text-muted-foreground">Transaction Date</Label>
                <Input type="date" value={date} max={todayPKTString()} onChange={(e) => setDate(e.target.value)} className="h-9 text-sm" />
              </div>

              <div className="grid grid-cols-[130px_1fr] items-center gap-3">
                <Label className="text-xs text-muted-foreground">Customer Type</Label>
                <div className="flex overflow-hidden rounded-md border border-border">
                  {(["CASH", "REGULAR", "VENDOR", "RETAIL"] as CustomerType[]).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => handleCustomerTypeChange(t)}
                      className={`flex-1 border-r border-border px-2 py-2 text-[11px] font-semibold uppercase tracking-wide transition-colors last:border-r-0 ${
                        customerType === t ? "bg-emerald-700 text-white" : "bg-background text-muted-foreground hover:bg-muted/50"
                      }`}
                    >
                      {TAG_LABEL[t]}
                    </button>
                  ))}
                </div>
              </div>

              {customerType === "CASH" && (
                <div className="grid grid-cols-[130px_1fr] items-center gap-3">
                  <Label className="text-xs text-muted-foreground">Customer Name</Label>
                  <Input value={cashName} onChange={(e) => setCashName(e.target.value)} placeholder="Walk-in (optional)" className="h-9 text-sm" />
                </div>
              )}
              {customerType === "REGULAR" && (
                <div className="grid grid-cols-[130px_1fr] items-center gap-3">
                  <Label className="text-xs text-muted-foreground">Customer</Label>
                  <SearchCombobox
                    items={customerItems}
                    value={customerId}
                    onChange={handleCustomerChange}
                    placeholder="Search & select customer…"
                    searchPlaceholder="Name or customer code…"
                    emptyText="No customers found."
                  />
                </div>
              )}
              {customerType === "VENDOR" && (
                <div className="grid grid-cols-[130px_1fr] items-center gap-3">
                  <Label className="text-xs text-muted-foreground">Vendor</Label>
                  <SearchCombobox
                    items={vendorItems}
                    value={vendorId}
                    onChange={setVendorId}
                    placeholder="Search & select vendor…"
                    searchPlaceholder="Vendor name…"
                    emptyText="No vendors found."
                  />
                </div>
              )}
              {/* A shop buying outright at the counter. Product left with them on
                  consignment is recorded on the Retail Marts page instead. */}
              {customerType === "RETAIL" && (
                <div className="grid grid-cols-[130px_1fr] items-center gap-3">
                  <Label className="text-xs text-muted-foreground">Mart</Label>
                  <SearchCombobox
                    items={retailItems}
                    value={retailVendorId}
                    onChange={setRetailVendorId}
                    placeholder="Search & select shop…"
                    searchPlaceholder="Shop name…"
                    emptyText="No shops found — add one on Retail Marts."
                  />
                </div>
              )}

              <div className="grid grid-cols-[130px_1fr] items-center gap-3">
                <Label className="text-xs text-muted-foreground">Delivery Charge</Label>
                <Input
                  type="number" inputMode="decimal"
                  value={deliveryCharge || ""}
                  onChange={(e) => setDeliveryCharge(parseFloat(e.target.value) || 0)}
                  placeholder="0"
                  className="h-9 text-sm font-mono"
                />
              </div>

              <div className="grid grid-cols-[130px_1fr] items-center gap-3">
                <Label className="text-xs text-muted-foreground">Payment</Label>
                <div className="flex overflow-hidden rounded-md border border-border">
                  <button
                    type="button"
                    onClick={() => handlePaymentStatusChange("PAID")}
                    className={`flex-1 border-r border-border px-2 py-2 text-[11px] font-semibold uppercase tracking-wide transition-colors ${
                      paymentStatus === "PAID" ? "bg-emerald-700 text-white" : "bg-background text-muted-foreground hover:bg-muted/50"
                    }`}
                  >
                    Pay Now
                  </button>
                  <button
                    type="button"
                    disabled={customerType === "CASH"}
                    onClick={() => handlePaymentStatusChange("CREDIT")}
                    title={customerType === "CASH" ? "Cash sales can't be on credit — there's no account to bill later" : undefined}
                    className={`flex-1 px-2 py-2 text-[11px] font-semibold uppercase tracking-wide transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                      paymentStatus === "CREDIT" ? "bg-amber-600 text-white" : "bg-background text-muted-foreground hover:bg-muted/50"
                    }`}
                  >
                    On Credit
                  </button>
                </div>
              </div>
              {/* On Credit: settle part now, leave the rest owing. */}
              {paymentStatus === "CREDIT" && (
                <div className="grid grid-cols-[130px_1fr] items-center gap-3">
                  <Label className="text-xs text-muted-foreground">Paying Now</Label>
                  <div className="flex items-center gap-3">
                    <Input
                      type="number" inputMode="decimal"
                      value={payingNow || ""}
                      onChange={(e) => setPayingNow(parseFloat(e.target.value) || 0)}
                      placeholder="0"
                      max={grandTotal || undefined}
                      className="h-9 w-32 text-sm font-mono"
                    />
                    <span className="whitespace-nowrap text-[11px] text-muted-foreground">
                      On credit:{" "}
                      <span className="font-mono font-semibold text-amber-700">₨ {fmtMoney(creditRemainder)}</span>
                    </span>
                  </div>
                </div>
              )}
              {/* Where the cash lands — whenever any amount is paid now (full or partial). */}
              {paidNow > 0.005 && (
                <div className="grid grid-cols-[130px_1fr] items-center gap-3">
                  <Label className="text-xs text-muted-foreground">Received Into</Label>
                  <Select value={paymentHead} onValueChange={setPaymentHead}>
                    <SelectTrigger className="h-9 text-sm w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {ctx.heads.filter((h) => canReceiveInto(h.head)).map((h) => (
                        <SelectItem key={h.head} value={h.head}>
                          <span className="flex w-full items-center justify-between gap-3">
                            <span>{h.label}</span>
                            <span className={`font-mono text-[11px] ${h.balance < 0 ? "text-rose-600" : "text-muted-foreground"}`}>
                              ₨ {Math.round(h.balance).toLocaleString("en-PK")}
                            </span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {paymentStatus === "CREDIT" && creditRemainder > 0.005 && customerType === "REGULAR" && (
                <p className="text-[11px] text-muted-foreground">
                  Adds ₨ {fmtMoney(creditRemainder)} to this customer&apos;s pending payments (what they owe you).
                </p>
              )}
              {paymentStatus === "CREDIT" && creditRemainder > 0.005 && customerType === "RETAIL" && (
                <p className="text-[11px] text-muted-foreground">
                  Adds ₨ {fmtMoney(creditRemainder)} to this shop&apos;s balance on the Retail Marts page.
                </p>
              )}
              {paymentStatus === "CREDIT" && creditRemainder > 0.005 && customerType === "VENDOR" && (
                <p className="text-[11px] text-muted-foreground">
                  Adds ₨ {fmtMoney(creditRemainder)} to this vendor&apos;s pending payments (what they owe you), shown in Vendor Bills.
                </p>
              )}
            </div>

            <div className="grid grid-cols-[130px_1fr] gap-3">
              <Label className="pt-2 text-xs text-muted-foreground">Narration</Label>
              <Textarea
                value={narration}
                onChange={(e) => setNarration(e.target.value)}
                placeholder="Optional note against this sale"
                className="min-h-[150px] text-sm"
              />
            </div>
          </div>

          <OtcLineEditor products={ctx.products} lines={lines} onChange={setLines} />

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <p className="text-xs text-muted-foreground">
              Unit and rate fill from the product; rate stays editable. Total is Rate × Qty.
            </p>
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={resetForm}>
                <RotateCcw className="mr-1.5 size-3.5" /> Reset
              </Button>
              <Button type="button" size="sm" onClick={handleSave} disabled={isPending} className="bg-emerald-700 hover:bg-emerald-800 text-white">
                <Save className="mr-1.5 size-3.5" /> {isPending ? "Saving…" : "Save Changes"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-sm">Sale History</CardTitle>
          <span className="font-mono text-xs text-muted-foreground">
            {history.length} sales · Rs {fmtMoney(history.reduce((s, t) => s + t.totalAmount, 0))}
          </span>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Invoice</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Payment</TableHead>
                <TableHead>Items</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.length === 0 ? (
                <TableRow><TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">No sales recorded yet.</TableCell></TableRow>
              ) : history.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-mono text-xs font-semibold text-emerald-700">{t.invoiceNo}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{new Date(t.date).toLocaleDateString("en-GB")}</TableCell>
                  <TableCell className="text-sm">
                    <span className="mr-1.5 rounded-full border border-current px-1.5 py-0.5 text-[9px] font-bold uppercase text-emerald-700">
                      {TAG_LABEL[t.customerType]}
                    </span>
                    {t.partyName}
                  </TableCell>
                  <TableCell className="text-xs">
                    {t.paymentStatus === "PAID" ? "Paid"
                      : t.paymentStatus === "PARTIAL" ? (
                        <span className="font-semibold text-amber-600" title={`Paid ₨ ${fmtMoney(t.paidAmount)} · ₨ ${fmtMoney(t.totalAmount - t.paidAmount)} on credit`}>
                          Partial
                        </span>
                      ) : <span className="font-semibold text-amber-600">Credit</span>}
                  </TableCell>
                  <TableCell className="max-w-[18rem] text-xs">
                    {/* Each item with its quantity, so the list says what was sold, not just how many lines. */}
                    {t.lines.map((l, i) => (
                      <span key={`${l.productId}-${i}`} className="mr-2 inline-block whitespace-nowrap">
                        {l.productName} <span className="font-semibold">{l.quantity} {unitLabel(l.unit)}</span>
                      </span>
                    ))}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm font-semibold">{fmtMoney(t.totalAmount)}</TableCell>
                  <TableCell>
                    <Button
                      size="sm" variant="outline" className="h-7 text-xs"
                      onClick={() => setViewInvoice({
                        kind: "sale", invoiceNo: t.invoiceNo, date: t.date,
                        partyLabel: "Billed To", partyName: t.partyName, tag: TAG_LABEL[t.customerType],
                        deliveryCharge: t.deliveryCharge, narration: t.narration, totalAmount: t.totalAmount,
                        paymentStatus: t.paymentStatus, paymentHead: t.paymentHead, lines: t.lines,
                      })}
                    >
                      View invoice
                    </Button>
                    <button
                      type="button"
                      onClick={() => handleDelete(t)}
                      disabled={isPending}
                      className="ml-1 inline-grid size-7 place-items-center rounded-md border border-border align-middle text-muted-foreground hover:border-rose-200 hover:text-rose-600 disabled:opacity-30"
                      title="Delete this sale — puts the stock back and reverses the money"
                    >
                      <Trash2 className="size-3" />
                    </button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <OtcInvoiceDialog invoice={viewInvoice} onClose={() => setViewInvoice(null)} />
    </div>
  );
}
