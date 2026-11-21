"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import {
  ArrowLeft, Download, Printer, Trash2, RefreshCw, Plus, Pencil, Check, X, Save, Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  generateInvoice, deleteInvoice, setInvoiceStatus, saveInvoiceLines, setInvoiceDueDate, setInvoiceDiscount,
  type InvoiceDetail, type InvoiceLineRow, type ProductOption,
} from "@/app/(dashboard)/billing/invoices/actions";
import { InvoiceDocument } from "@/components/billing/invoice-document";
import { useRefreshOnFocus } from "@/components/util/use-refresh-on-focus";
import { fileNameFrom, saveBlob, describeFailure } from "@/lib/download";

const STATUS_OPTIONS = [
  { value: "DRAFT", label: "Draft" },
  { value: "SENT", label: "Sent" },
  { value: "PARTIAL", label: "Partial" },
  { value: "PAID", label: "Paid" },
  { value: "OVERDUE", label: "Overdue" },
];

function fmt(n: number) {
  return Math.abs(Math.round(n)).toLocaleString("en-PK");
}
function fmtDay(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", { timeZone: "Asia/Karachi", day: "2-digit", month: "short" });
}
function round2(n: number) {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
}
// ISO → "YYYY-MM-DD" in PKT, for the <input type="date"> value.
function dueInputValue(iso: string) {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Karachi" });
}

function lineType(l: InvoiceLineRow): "delivery" | "return" | "replacement" {
  if (l.isReturn) return "return";
  if (l.isReplacement) return "replacement";
  return "delivery";
}
const TYPE_LABEL: Record<string, string> = {
  delivery: "Delivered", replacement: "Replacement", return: "Returned",
};

// ── Line editor row (buffered — mutates the draft only, no server call) ────────────

function EditRow({ line, onChange, onRemove }: {
  line: InvoiceLineRow;
  onChange: (l: InvoiceLineRow) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [qty, setQty] = useState(String(line.quantity));
  const [rate, setRate] = useState(String(line.rate));
  const [type, setType] = useState(lineType(line));

  function apply() {
    const q = parseFloat(qty) || 0;
    const r = parseFloat(rate) || 0;
    const isReturn = type === "return";
    const isReplacement = type === "replacement";
    const amount = isReplacement ? 0 : round2(q * r);
    onChange({ ...line, quantity: q, rate: r, isReturn, isReplacement, amount });
    setEditing(false);
  }

  if (!editing) {
    return (
      <tr className="border-b border-border/50">
        <td className="px-2 py-1.5 text-[11px] text-muted-foreground">{fmtDay(line.date)}</td>
        <td className="px-2 py-1.5 text-[11px]">{line.productName}</td>
        <td className="px-2 py-1.5 text-[11px]">{TYPE_LABEL[lineType(line)]}</td>
        <td className="px-2 py-1.5 text-right text-[11px] tabular-nums">{line.quantity}</td>
        <td className="px-2 py-1.5 text-right text-[11px] tabular-nums">{fmt(line.rate)}</td>
        <td className="px-2 py-1.5 text-right text-[11px] font-medium tabular-nums">{fmt(line.amount)}</td>
        <td className="px-2 py-1.5 text-right">
          <div className="flex justify-end gap-1">
            <button onClick={() => setEditing(true)} className="rounded p-1 text-muted-foreground hover:bg-muted" title="Edit"><Pencil className="size-3" /></button>
            <button onClick={onRemove} className="rounded p-1 text-muted-foreground hover:bg-rose-50 hover:text-rose-600" title="Delete"><Trash2 className="size-3" /></button>
          </div>
        </td>
      </tr>
    );
  }

  return (
    <tr className="border-b border-border/50 bg-muted/20">
      <td className="px-2 py-1.5 text-[11px] text-muted-foreground">{fmtDay(line.date)}</td>
      <td className="px-2 py-1.5 text-[11px]">{line.productName}</td>
      <td className="px-2 py-1.5">
        <select value={type} onChange={(e) => setType(e.target.value as typeof type)} className="h-7 rounded border border-border bg-background px-1 text-[11px]">
          <option value="delivery">Delivered</option>
          <option value="return">Returned</option>
          <option value="replacement">Replacement</option>
        </select>
      </td>
      <td className="px-2 py-1.5"><Input value={qty} onChange={(e) => setQty(e.target.value)} className="h-7 w-16 text-right text-[11px]" /></td>
      <td className="px-2 py-1.5"><Input value={rate} onChange={(e) => setRate(e.target.value)} className="h-7 w-20 text-right text-[11px]" /></td>
      <td className="px-2 py-1.5 text-right text-[11px] text-muted-foreground">{type === "replacement" ? "0" : fmt((parseFloat(qty) || 0) * (parseFloat(rate) || 0))}</td>
      <td className="px-2 py-1.5 text-right">
        <div className="flex justify-end gap-1">
          <button onClick={apply} className="rounded p-1 text-emerald-600 hover:bg-emerald-50" title="Apply"><Check className="size-3.5" /></button>
          <button onClick={() => setEditing(false)} className="rounded p-1 text-muted-foreground hover:bg-muted" title="Cancel"><X className="size-3.5" /></button>
        </div>
      </td>
    </tr>
  );
}

// ── Main ────────────────────────────────────────────────────────────────────────

export function InvoiceDetailClient({ invoice: initialInvoice, products, canEdit }: { invoice: InvoiceDetail; products: ProductOption[]; canEdit: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [showEditor, setShowEditor] = useState(false);
  const tmpId = useRef(0);

  // `invoice` holds the last-saved server state; `draftLines` holds the working
  // copy the user edits. Nothing is persisted until "Save changes" is clicked.
  const [invoice, setInvoice] = useState<InvoiceDetail>(initialInvoice);
  const [draftLines, setDraftLines] = useState<InvoiceLineRow[]>(initialInvoice.lines);
  const [dirty, setDirty] = useState(false);

  // Pull in deliveries recorded after this bill was opened — but never while the
  // manager has an unsaved edit or the line editor open, so a refresh can't wipe
  // their draft. getInvoiceDetail rebuilds the lines live on each load.
  useRefreshOnFocus(!dirty && !showEditor);

  // Re-seed when the server sends a fresh invoice (navigation / refresh / reset).
  const [syncedFrom, setSyncedFrom] = useState(initialInvoice);
  if (syncedFrom !== initialInvoice) {
    setSyncedFrom(initialInvoice);
    setInvoice(initialInvoice);
    setDraftLines(initialInvoice.lines);
    setDirty(false);
  }

  // Add-line form — default to the period's first day (timezone-safe).
  const [adding, setAdding] = useState(false);
  const [nDate, setNDate] = useState(
    `${invoice.year}-${String(invoice.month).padStart(2, "0")}-${String(invoice.half === 1 ? 1 : 16).padStart(2, "0")}`
  );
  const [nProduct, setNProduct] = useState(products[0]?.id ?? "");
  const [nQty, setNQty] = useState("1");
  const [nRate, setNRate] = useState(String(products[0]?.defaultRate ?? 0));
  const [nType, setNType] = useState<"delivery" | "return" | "replacement">("delivery");
  const [discountInput, setDiscountInput] = useState(String(initialInvoice.discount || ""));

  // Live preview — line edits only affect deliveries/returns/total; the
  // payment-driven figures stay from the server snapshot. Mirrors getInvoiceDetail.
  const deliveriesAmt = draftLines.reduce((s, l) => s + (l.isReturn || l.isReplacement ? 0 : l.amount), 0);
  const returnsAmt = draftLines.reduce((s, l) => s + (l.isReturn ? l.amount : 0), 0);
  const totalDue = invoice.prevBalance + deliveriesAmt - returnsAmt + invoice.deliveryCharge + invoice.otcAmt - invoice.discount - invoice.paymentsAmt;
  const previewInvoice: InvoiceDetail = { ...invoice, lines: draftLines, deliveriesAmt, returnsAmt, totalDue };

  function updateDraft(updated: InvoiceLineRow) {
    setDraftLines((prev) => prev.map((l) => (l.id === updated.id ? updated : l)));
    setDirty(true);
  }
  function removeDraft(id: string) {
    setDraftLines((prev) => prev.filter((l) => l.id !== id));
    setDirty(true);
  }

  function handleAdd() {
    if (!nProduct) { toast.error("Pick a product."); return; }
    const p = products.find((x) => x.id === nProduct);
    const q = parseFloat(nQty) || 0;
    const r = parseFloat(nRate) || 0;
    const isReturn = nType === "return";
    const isReplacement = nType === "replacement";
    const newLine: InvoiceLineRow = {
      id: `tmp-${tmpId.current++}`,
      // No delivery behind it yet — saving turns this into one.
      deliveryEntryId: null,
      // A line added by hand is one the office is asserting; there is no skipped
      // stop behind it.
      notDelivered: false,
      date: new Date(nDate + "T08:00:00").toISOString(),
      productId: nProduct,
      productName: p?.name ?? "",
      unit: p?.unit ?? "LITER",
      quantity: q,
      rate: r,
      amount: isReplacement ? 0 : round2(q * r),
      isReturn,
      isReplacement,
    };
    setDraftLines((prev) => [...prev, newLine].sort((a, b) => a.date.localeCompare(b.date)));
    setDirty(true);
    setAdding(false);
    setNQty("1");
  }

  function handleSave() {
    start(async () => {
      const res = await saveInvoiceLines(invoice.id, draftLines.map((l) => ({
        // Which delivery this line came from, so the edit reaches it rather than
        // being overwritten when the bill is rebuilt. A line added here has none
        // yet, and becomes a new delivery.
        deliveryEntryId: l.deliveryEntryId ?? null,
        date: l.date,
        productId: l.productId,
        quantity: l.quantity,
        rate: l.rate,
        isReturn: l.isReturn,
        isReplacement: l.isReplacement,
      })));
      if (res.ok) {
        setInvoice(res.invoice);
        setDraftLines(res.invoice.lines);
        setDirty(false);
        toast.success("Invoice saved.");
      } else toast.error(res.error);
    });
  }

  // Saved on its own, not with the lines: it is an allowance against the bill
  // rather than a correction to what was delivered, and the two should not be
  // able to half-succeed together.
  function handleDiscount() {
    const v = discountInput.trim() === "" ? 0 : parseFloat(discountInput);
    if (Number.isNaN(v)) { toast.error("Enter a discount amount, or leave it blank for none."); return; }
    start(async () => {
      const res = await setInvoiceDiscount(invoice.id, v);
      if (res.ok) {
        setInvoice(res.invoice);
        setDiscountInput(String(res.invoice.discount || ""));
        toast.success(v > 0 ? "Discount applied to this bill." : "Discount removed.");
        router.refresh();
      } else toast.error(res.error);
    });
  }

  function handleDiscard() {
    setDraftLines(invoice.lines);
    setDirty(false);
    toast.message("Changes discarded.");
  }

  function handleStatus(v: string) {
    start(async () => {
      const res = await setInvoiceStatus(invoice.id, v);
      if (res.ok) { setInvoice((prev) => ({ ...prev, status: res.invoice.status })); toast.success("Status updated."); }
      else toast.error(res.error);
    });
  }

  function handleDueDate(v: string) {
    if (!v) return;
    start(async () => {
      const res = await setInvoiceDueDate(invoice.id, v);
      if (res.ok) { setInvoice((prev) => ({ ...prev, dueDate: res.invoice.dueDate })); toast.success("Last date updated."); }
      else toast.error(res.error);
    });
  }

  function handleReset() {
    if (!window.confirm("Reset this invoice to the subscription defaults? This overwrites all manual line edits and removes any discount on it.")) return;
    start(async () => {
      const res = await generateInvoice(invoice.customer.id, invoice.year, invoice.month, invoice.half);
      if (res.ok) { toast.success("Invoice reset from subscriptions."); router.refresh(); }
      else toast.error(res.error);
    });
  }

  function handleDelete() {
    if (!window.confirm("Delete this invoice permanently?")) return;
    start(async () => {
      const res = await deleteInvoice(invoice.id);
      if (res.ok) { toast.success("Invoice deleted."); router.push("/billing/invoices"); }
      else toast.error(res.error);
    });
  }

  function handlePrint() {
    window.open(`/print/invoice/${invoice.id}`, "_blank");
  }

  const [downloading, setDownloading] = useState(false);

  /**
   * Download the bill as a PDF, named after the customer.
   *
   * Fetched rather than linked so a failure can be reported. A plain link to the
   * endpoint would replace the page with raw JSON on any error \u2014 and the whole
   * point of this button is that nobody has to think about it.
   */
  async function handleDownload() {
    setDownloading(true);
    try {
      const res = await fetch(`/api/bills/pdf?id=${encodeURIComponent(invoice.id)}`);
      if (!res.ok) {
        // Read the body whatever it turns out to be: a JSON message when the
        // server managed one, otherwise the status, so what goes wrong can be
        // reported rather than guessed at.
        const said = await describeFailure(res);
        toast.error(said ?? "The bill could not be turned into a PDF.");
        return;
      }
      const blob = await res.blob();
      // The server already worked out the name; take it from the header rather
      // than building a second version of it here that could disagree.
      const name = fileNameFrom(res.headers.get("content-disposition")) ?? "Bill.pdf";
      saveBlob(blob, name);
      toast.success("Bill downloaded.");
    } catch {
      toast.error("The bill could not be downloaded.");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="min-h-dvh bg-[#ECE3CC] px-3 py-6">
      {/* Toolbar */}
      <div className="mx-auto mb-4 flex max-w-[680px] flex-wrap items-center gap-2">
        <Link href={`/billing/invoices?m=${invoice.year}-${String(invoice.month).padStart(2, "0")}&h=${invoice.half}`} className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-muted/50">
          <ArrowLeft className="size-3.5" /> Bills
        </Link>
        <Select value={invoice.status} onValueChange={handleStatus}>
          <SelectTrigger className="h-8 w-28 bg-card text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((s) => <SelectItem key={s.value} value={s.value} className="text-xs">{s.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <label className="flex items-center gap-1 rounded-md border border-border bg-card px-2 text-[11px] text-muted-foreground">
          Last date
          <input
            type="date"
            value={dueInputValue(invoice.dueDate)}
            onChange={(e) => handleDueDate(e.target.value)}
            disabled={pending}
            className="h-8 border-0 bg-transparent text-xs text-foreground focus:outline-none"
            title="Last date to pay (shown on the bill)"
          />
        </label>
        {canEdit && (
          <Button variant="outline" size="sm" className="h-8 bg-card text-xs" onClick={() => setShowEditor((v) => !v)}>
            <Pencil className="mr-1 size-3.5" /> {showEditor ? "Hide editor" : "Edit lines"}
          </Button>
        )}
        <Button variant="outline" size="sm" className="h-8 bg-card text-xs" onClick={handleReset} disabled={pending}>
          <RefreshCw className={pending ? "mr-1 size-3.5 animate-spin" : "mr-1 size-3.5"} /> Reset to subscriptions
        </Button>
        <Button variant="outline" size="sm" className="h-8 bg-card text-xs text-rose-600 hover:bg-rose-50" onClick={handleDelete} disabled={pending}>
          <Trash2 className="mr-1 size-3.5" /> Delete
        </Button>

        <div className="ml-auto flex items-center gap-2">
          {dirty && (
            <Button variant="outline" size="sm" className="h-8 bg-card text-xs" onClick={handleDiscard} disabled={pending}>
              <Undo2 className="mr-1 size-3.5" /> Discard
            </Button>
          )}
          <Button size="sm" className="h-8 text-xs" onClick={handleSave} disabled={pending || !dirty}>
            <Save className="mr-1 size-3.5" /> {dirty ? "Save changes" : "Saved"}
          </Button>
          <Button size="sm" className="h-8 text-xs" onClick={handleDownload} disabled={downloading}>
            {downloading ? <RefreshCw className="mr-1 size-3.5 animate-spin" /> : <Download className="mr-1 size-3.5" />}
            {downloading ? "Making PDF\u2026" : "Download PDF"}
          </Button>
          <Button variant="outline" size="sm" className="h-8 bg-card text-xs" onClick={handlePrint}>
            <Printer className="mr-1 size-3.5" /> Print
          </Button>
        </div>
      </div>

      {dirty && (
        <div className="mx-auto mb-4 max-w-[680px] rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] font-medium text-amber-800">
          Unsaved changes — click <span className="font-semibold">Save changes</span> to keep them.
        </div>
      )}

      {/* Line editor */}
      {showEditor && (
        <div className="mx-auto mb-4 max-w-[680px] rounded-xl border border-border bg-card p-4">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-semibold">Edit line items</p>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setAdding((v) => !v)}>
              <Plus className="mr-1 size-3" /> Add line
            </Button>
          </div>

          {adding && (
            <div className="mb-3 grid grid-cols-2 gap-2 rounded-lg border border-border bg-muted/20 p-3 sm:grid-cols-6">
              <input type="date" value={nDate} onChange={(e) => setNDate(e.target.value)} className="h-8 rounded border border-border bg-background px-2 text-[11px]" />
              <select value={nProduct} onChange={(e) => { setNProduct(e.target.value); const p = products.find((x) => x.id === e.target.value); if (p) setNRate(String(p.defaultRate)); }} className="h-8 rounded border border-border bg-background px-2 text-[11px]">
                {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <select value={nType} onChange={(e) => setNType(e.target.value as typeof nType)} className="h-8 rounded border border-border bg-background px-2 text-[11px]">
                <option value="delivery">Delivered</option>
                <option value="return">Returned</option>
                <option value="replacement">Replacement</option>
              </select>
              <Input value={nQty} onChange={(e) => setNQty(e.target.value)} placeholder="Qty" className="h-8 text-right text-[11px]" />
              <Input value={nRate} onChange={(e) => setNRate(e.target.value)} placeholder="Rate" className="h-8 text-right text-[11px]" />
              <Button size="sm" className="h-8 text-xs" onClick={handleAdd}>Add</Button>
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-[10px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-2 py-1.5 text-left">Date</th>
                  <th className="px-2 py-1.5 text-left">Item</th>
                  <th className="px-2 py-1.5 text-left">Type</th>
                  <th className="px-2 py-1.5 text-right">Qty</th>
                  <th className="px-2 py-1.5 text-right">Rate</th>
                  <th className="px-2 py-1.5 text-right">Amount</th>
                  <th className="px-2 py-1.5"></th>
                </tr>
              </thead>
              <tbody>
                {draftLines.length === 0 ? (
                  <tr><td colSpan={7} className="py-6 text-center text-muted-foreground">No lines. Use “Add line” or “Reset to subscriptions”.</td></tr>
                ) : draftLines.map((l) => (
                  <EditRow
                    key={`${l.id}:${l.quantity}:${l.rate}:${l.isReturn}:${l.isReplacement}`}
                    line={l}
                    onChange={updateDraft}
                    onRemove={() => removeDraft(l.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>

          {/* A one-off allowance on this bill only. For a delivery that went wrong
              and cannot be put right — the amount comes off this total and is never
              carried into the next fortnight's bill. */}
          {canEdit && <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/20 p-3">
            <div className="mr-auto">
              <p className="text-xs font-semibold">Discount on this bill</p>
              <p className="text-[10px] text-muted-foreground">
                Taken off this bill&rsquo;s total only. It does not carry into the next one. Leave blank for none.
              </p>
            </div>
            <Input
              value={discountInput}
              onChange={(e) => setDiscountInput(e.target.value)}
              placeholder="0"
              inputMode="decimal"
              className="h-8 w-28 text-right text-[11px]"
            />
            <Button size="sm" className="h-8 text-xs" onClick={handleDiscount} disabled={pending}>
              Apply
            </Button>
          </div>}
        </div>
      )}

      {/* Printable invoice (live preview reflects unsaved edits) */}
      <InvoiceDocument invoice={previewInvoice} />
    </div>
  );
}
