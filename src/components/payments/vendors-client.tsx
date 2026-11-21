"use client";

import { useState, useMemo, useTransition, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Trash2, Printer, X, ChevronDown, Building2, AlertCircle, Image as ImageIcon, Loader2, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { todayPKTString } from "@/lib/pkt";
import { unitLabel, type Unit } from "@/lib/units";

const PAY_HEADS = [
  { value: "CASH", label: "Cash" },
  { value: "RIDER_CASH", label: "Rider Cash" },
  { value: "HBL", label: "HBL" },
  { value: "MEEZAN", label: "Meezan" },
  { value: "JAZZCASH", label: "JazzCash" },
  { value: "EASYPAISA", label: "Easypaisa" },
];

// Paying a vendor may come out of the Rider Cash box; money received FROM a vendor
// may not go into it. Rider Cash only ever fills from a rider's confirmed handover —
// anything else would sit in no head at all. Nor into Meezan, the owners' account:
// paying a vendor through it is the owners paying, a refund is the farm's money.
// The server enforces the same rule.
const RECEIVE_HEADS = PAY_HEADS.filter((h) => canReceiveInto(h.value));

// Logo lives in /public; spaces URL-encoded.
const LOGO_URL = "/banoori%20dairy%20logo.png";
import {
  createVendor,
  createVendorBill,
  deleteVendorBill,
  getVendorBills,
  recordVendorPayment,
  getVendorReceivables,
  recordVendorReceipt,
  deleteVendorReceivable,
  settleVendorContra,
  type VendorEntry,
  type VendorBillEntry,
  type VendorReceivableEntry,
  type BillLine,
} from "@/app/(dashboard)/payments/vendors/actions";
import type { HeadBalance } from "@/lib/head-balances";
import { canReceiveInto } from "@/lib/payment-heads";

// ── constants ─────────────────────────────────────────────────────────────────

const BILL_CATEGORIES = [
  "Animal Feed",
  "Rider Fuel",
  "Medical",
  "Salary",
  "Equipment",
  "Packaging",
  "Maintenance",
  "Civil",
  "Other",
];

// ── helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number) {
  return Math.abs(Math.round(n)).toLocaleString("en-PK");
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", {
    timeZone: "Asia/Karachi",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

// ── Line item row ─────────────────────────────────────────────────────────────

function LineItem({
  line,
  onUpdate,
  onRemove,
  canRemove,
}: {
  line: BillLine & { _key: string };
  onUpdate: (field: keyof BillLine, value: string | number) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  return (
    <div className="grid grid-cols-[1fr_100px_90px_32px] gap-2 items-end sm:grid-cols-[1fr_140px_120px_32px]">
      <div>
        <Input
          placeholder="e.g. Cattle feed 50kg"
          value={line.description}
          onChange={(e) => onUpdate("description", e.target.value)}
          className="text-sm"
        />
      </div>
      <div>
        <select
          value={line.category}
          onChange={(e) => onUpdate("category", e.target.value)}
          className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
        >
          {BILL_CATEGORIES.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </div>
      <div>
        <Input
          type="number"
          min="0"
          step="1"
          placeholder="0"
          value={line.amount || ""}
          onChange={(e) => onUpdate("amount", parseFloat(e.target.value) || 0)}
          className="text-sm text-right"
        />
      </div>
      <button
        onClick={onRemove}
        disabled={!canRemove}
        className="size-8 flex items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-rose-50 hover:text-rose-600 hover:border-rose-200 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

// ── Bill print preview ────────────────────────────────────────────────────────

function PrintPreview({
  bill,
  vendorName,
  oldBalance,
  open,
  onClose,
}: {
  bill: VendorBillEntry;
  vendorName: string;
  oldBalance: number;
  open: boolean;
  onClose: () => void;
}) {
  const grandTotal = bill.amount + oldBalance;

  function handlePrint() {
    const win = window.open("", "_blank", "width=720,height=700");
    if (!win) return;
    const dateStr = fmtDate(bill.date);
    win.document.write(`<!DOCTYPE html><html><head><title>Vendor Bill – ${vendorName}</title><style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:Arial,sans-serif;padding:2.5rem;color:#111;max-width:640px;margin:0 auto}
      h2{font-size:20px;font-weight:600;margin-bottom:2px}
      .brand{display:flex;align-items:center;gap:12px;margin-bottom:1.25rem}
      .brand img{height:48px;width:auto;object-fit:contain}
      .sub{font-size:12px;color:#666}
      table{width:100%;border-collapse:collapse;font-size:13px;margin:1rem 0}
      th{text-align:left;font-size:11px;font-weight:600;color:#666;padding:7px 8px;border-bottom:1.5px solid #ddd;text-transform:uppercase;letter-spacing:.4px}
      td{padding:8px;border-bottom:0.5px solid #eee;color:#111}
      .amt{text-align:right;font-weight:500}
      .cat{font-size:11px;color:#888}
      .total-box{display:flex;justify-content:space-between;padding:12px 10px;background:#f5f5f5;border-radius:6px;font-weight:600;font-size:15px;margin-top:10px}
      .meta{display:flex;justify-content:space-between;font-size:12px;color:#555;margin-top:1.5rem;padding-top:12px;border-top:0.5px solid #ddd}
      @media print{body{padding:1rem}}
    </style></head><body>
      <div class="brand">
        <img src="${window.location.origin}${LOGO_URL}" alt="" onerror="this.style.display='none'"/>
        <div>
          <h2>${vendorName}</h2>
          <div class="sub">${bill.reference ? `Ref: ${bill.reference} · ` : ""}Date: ${dateStr}</div>
        </div>
      </div>
      <table>
        <thead><tr><th>Description</th><th>Category</th><th style="text-align:right">Qty</th><th style="text-align:right">Rate</th><th style="text-align:right">Amount (Rs)</th></tr></thead>
        <tbody>
          ${bill.lines.map((l) => `
            <tr>
              <td>${l.description || "—"}</td>
              <td class="cat">${l.category}</td>
              <td class="amt">${qtyText(l) || "—"}</td>
              <td class="amt">${l.rate === undefined ? "—" : `Rs ${fmt(l.rate)}`}</td>
              <td class="amt">Rs ${fmt(l.amount)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
      <div class="total-box"><span>Total bill</span><span>Rs ${fmt(bill.amount)}</span></div>
      <div class="meta">
        <span>Old balance: <strong>Rs ${fmt(oldBalance)}</strong></span>
        <span>Grand total: <strong>Rs ${fmt(grandTotal)}</strong></span>
      </div>
    </body></html>`);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 400);
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Bill Preview</DialogTitle>
        </DialogHeader>

        {/* Preview content */}
        <div className="rounded-lg border border-border bg-card p-5 space-y-3">
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={LOGO_URL} alt="" className="h-11 w-auto object-contain" />
            <div>
              <p className="text-base font-semibold">{vendorName}</p>
              <p className="text-xs text-muted-foreground">
                {bill.reference ? `Ref: ${bill.reference} · ` : ""}{fmtDate(bill.date)}
              </p>
            </div>
          </div>

          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="py-2 text-left text-xs font-semibold text-muted-foreground">Description</th>
                <th className="py-2 text-left text-xs font-semibold text-muted-foreground">Category</th>
                <th className="py-2 text-right text-xs font-semibold text-muted-foreground">Qty</th>
                <th className="py-2 text-right text-xs font-semibold text-muted-foreground">Rate</th>
                <th className="py-2 text-right text-xs font-semibold text-muted-foreground">Amount</th>
              </tr>
            </thead>
            <tbody>
              {bill.lines.map((l, i) => (
                <tr key={i} className="border-b border-border/60">
                  <td className="py-2 font-medium">{l.description || "—"}</td>
                  <td className="py-2 text-xs text-muted-foreground">{l.category}</td>
                  <td className="py-2 text-right tabular-nums text-muted-foreground">{qtyText(l) || "—"}</td>
                  <td className="py-2 text-right tabular-nums text-muted-foreground">{l.rate === undefined ? "—" : `Rs ${fmt(l.rate)}`}</td>
                  <td className="py-2 text-right font-medium">Rs {fmt(l.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>

          <div className="flex items-center justify-between rounded-lg bg-muted/50 px-4 py-2.5">
            <span className="font-semibold text-sm">Total bill</span>
            <span className="text-lg font-bold">Rs {fmt(bill.amount)}</span>
          </div>

          <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
            <span>Old balance: <strong className="text-foreground">Rs {fmt(oldBalance)}</strong></span>
            <span>Grand total: <strong className="text-foreground">Rs {fmt(grandTotal)}</strong></span>
          </div>

          {bill.receiptUrl && (
            <a
              href={bill.receiptUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 rounded-lg border border-border bg-muted/20 p-2"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={bill.receiptUrl} alt="Receipt" className="size-10 rounded object-cover" />
              <span className="inline-flex items-center gap-1 text-xs font-medium text-sky-700">
                <ImageIcon className="size-3.5" /> Vendor receipt attached — view
              </span>
            </a>
          )}
        </div>

        <div className="flex gap-2 justify-end">
          <Button variant="outline" onClick={onClose}>Close</Button>
          <Button onClick={handlePrint}>
            <Printer className="mr-1.5 size-4" />
            Print / Export
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Receipt image viewer ───────────────────────────────────────────────────────

function ReceiptViewer({ url, open, onClose }: { url: string; open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <ImageIcon className="size-4" /> Vendor receipt
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt="Vendor receipt" className="max-h-[70vh] w-full rounded-lg border border-border object-contain" />
          <div className="flex justify-end">
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted/50"
            >
              <ExternalLink className="size-3.5" /> Open full size
            </a>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Recent bills table ────────────────────────────────────────────────────────

function RecentBills({
  bills,
  vendorName,
  onDelete,
}: {
  bills: VendorBillEntry[];
  vendorName: string;
  onDelete: (id: string) => void;
}) {
  const [previewBill, setPreviewBill] = useState<VendorBillEntry | null>(null);
  const [viewReceipt, setViewReceipt] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  function handleSort(key: string) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  }

  // Compute old balance at the time of each bill (cumulative from oldest)
  const sorted = [...bills].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  const oldBalMap: Record<string, number> = {};
  let running = 0;
  for (const b of sorted) {
    oldBalMap[b.id] = running;
    running += b.amount - b.paid;
  }

  const sortedBills = useMemo(() => {
    if (!sortKey) return bills;
    return [...bills].sort((a, b) => {
      if (sortKey === "outstanding") {
        const av = a.amount - a.paid;
        const bv = b.amount - b.paid;
        return sortDir === "asc" ? av - bv : bv - av;
      }
      if (sortKey === "lines") {
        const av = a.lines.length;
        const bv = b.lines.length;
        return sortDir === "asc" ? av - bv : bv - av;
      }
      const av = (a as Record<string, unknown>)[sortKey];
      const bv = (b as Record<string, unknown>)[sortKey];
      if (typeof av === "number" && typeof bv === "number")
        return sortDir === "asc" ? av - bv : bv - av;
      const as_ = String(av ?? ""), bs_ = String(bv ?? "");
      return sortDir === "asc" ? as_.localeCompare(bs_) : bs_.localeCompare(as_);
    });
  }, [bills, sortKey, sortDir]);

  if (bills.length === 0) {
    return (
      <div className="flex h-28 items-center justify-center text-sm text-muted-foreground rounded-xl border border-dashed">
        No bills for this vendor yet.
      </div>
    );
  }

  return (
    <>
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40">
              <th
                onClick={() => handleSort("date")}
                className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
              >
                <span className="inline-flex items-center gap-1">
                  Date
                  <span className={sortKey === "date" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                    {sortKey === "date" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                  </span>
                </span>
              </th>
              <th
                onClick={() => handleSort("reference")}
                className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
              >
                <span className="inline-flex items-center gap-1">
                  Reference
                  <span className={sortKey === "reference" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                    {sortKey === "reference" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                  </span>
                </span>
              </th>
              <th
                onClick={() => handleSort("lines")}
                className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
              >
                <span className="inline-flex items-center gap-1">
                  Items
                  <span className={sortKey === "lines" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                    {sortKey === "lines" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                  </span>
                </span>
              </th>
              <th
                onClick={() => handleSort("amount")}
                className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
              >
                <span className="inline-flex items-center gap-1">
                  Amount
                  <span className={sortKey === "amount" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                    {sortKey === "amount" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                  </span>
                </span>
              </th>
              <th
                onClick={() => handleSort("paid")}
                className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
              >
                <span className="inline-flex items-center gap-1">
                  Paid
                  <span className={sortKey === "paid" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                    {sortKey === "paid" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                  </span>
                </span>
              </th>
              <th
                onClick={() => handleSort("outstanding")}
                className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
              >
                <span className="inline-flex items-center gap-1">
                  Outstanding
                  <span className={sortKey === "outstanding" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                    {sortKey === "outstanding" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                  </span>
                </span>
              </th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {sortedBills.map((b) => {
              const outstanding = b.amount - b.paid;
              return (
                <tr key={b.id} className="hover:bg-muted/20">
                  <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">{fmtDate(b.date)}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{b.reference || "—"}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {b.lines.length === 0 ? (
                      "—"
                    ) : (
                      <span className="block max-w-[22rem] truncate" title={itemsSummary(b.lines)}>
                        {itemsSummary(b.lines)}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right font-medium tabular-nums">Rs {fmt(b.amount)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-emerald-600">{b.paid > 0 ? `Rs ${fmt(b.paid)}` : "—"}</td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {outstanding <= 0 ? (
                      <span className="text-emerald-600 font-medium">Clear</span>
                    ) : (
                      <span className="text-rose-700 font-semibold">Rs {fmt(outstanding)}</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      {b.receiptUrl && (
                        <button
                          onClick={() => setViewReceipt(b.receiptUrl)}
                          className="rounded p-1 text-muted-foreground hover:bg-sky-50 hover:text-sky-600 transition-colors"
                          title="View receipt"
                        >
                          <ImageIcon className="size-3.5" />
                        </button>
                      )}
                      <button
                        onClick={() => setPreviewBill(b)}
                        className="rounded p-1 text-muted-foreground hover:bg-muted transition-colors"
                        title="Preview"
                      >
                        <Printer className="size-3.5" />
                      </button>
                      <button
                        onClick={() => onDelete(b.id)}
                        className="rounded p-1 text-muted-foreground hover:bg-rose-50 hover:text-rose-600 transition-colors"
                        title="Delete"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {previewBill && (
        <PrintPreview
          bill={previewBill}
          vendorName={vendorName}
          oldBalance={oldBalMap[previewBill.id] ?? 0}
          open={!!previewBill}
          onClose={() => setPreviewBill(null)}
        />
      )}

      {viewReceipt && (
        <ReceiptViewer url={viewReceipt} open={!!viewReceipt} onClose={() => setViewReceipt(null)} />
      )}
    </>
  );
}

// ── Recent receivables table (what THIS vendor owes you, from OTC sales) ──────

function RecentReceivables({
  receivables,
  onDelete,
}: {
  receivables: VendorReceivableEntry[];
  onDelete: (id: string) => void;
}) {
  if (receivables.length === 0) {
    return (
      <div className="flex h-28 items-center justify-center text-sm text-muted-foreground rounded-xl border border-dashed">
        No receivables for this vendor yet.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/40">
            <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">Date</th>
            <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">Reference</th>
            <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">Items</th>
            <th className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">Amount</th>
            <th className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">Received</th>
            <th className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground">Outstanding</th>
            <th className="px-4 py-2.5" />
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {receivables.map((r) => {
            const outstanding = r.amount - r.received;
            return (
              <tr key={r.id} className="hover:bg-muted/20">
                <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">{fmtDate(r.date)}</td>
                <td className="px-4 py-3 text-xs text-muted-foreground">{r.notes || "—"}</td>
                <td className="px-4 py-3 text-xs text-muted-foreground">
                  {r.lines.length === 0 ? (
                    "—"
                  ) : (
                    <span className="block max-w-[22rem] truncate" title={itemsSummary(r.lines)}>
                      {itemsSummary(r.lines)}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-right font-medium tabular-nums">Rs {fmt(r.amount)}</td>
                <td className="px-4 py-3 text-right tabular-nums text-emerald-600">{r.received > 0 ? `Rs ${fmt(r.received)}` : "—"}</td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {outstanding <= 0 ? (
                    <span className="text-emerald-600 font-medium">Clear</span>
                  ) : (
                    <span className="text-sky-700 font-semibold">Rs {fmt(outstanding)}</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1">
                    <button
                      onClick={() => onDelete(r.id)}
                      className="rounded p-1 text-muted-foreground hover:bg-rose-50 hover:text-rose-600 transition-colors"
                      title="Delete"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Main client ───────────────────────────────────────────────────────────────

/** "20 L" — blank for hand-written bill lines, which carry no quantity. */
const qtyText = (l: BillLine) =>
  l.quantity === undefined ? "" : `${fmt(l.quantity)} ${unitLabel(l.unit as Unit)}`;

/** "Cow Milk 20 L · Eggs 30 pc" — what the row shows at a glance. */
const itemsSummary = (lines: BillLine[]) =>
  lines.map((l) => [l.description || "—", qtyText(l)].filter(Boolean).join(" ")).join(" · ");

export function VendorsClient({ initialVendors, headBalances }: { initialVendors: VendorEntry[]; headBalances: HeadBalance[] }) {
  // Live balance per head, so the "Pay from" dropdown shows how much is in each
  // account (real figures from getHeadBalances).
  const headBalanceOf = (key: string) => headBalances.find((h) => h.head === key)?.balance;
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [vendors, setVendors] = useState<VendorEntry[]>(initialVendors);
  const [selectedVendorId, setSelectedVendorId] = useState("");
  const [bills, setBills] = useState<VendorBillEntry[]>([]);
  const [loadingBills, setLoadingBills] = useState(false);
  const [receivables, setReceivables] = useState<VendorReceivableEntry[]>([]);

  // New vendor
  const [showNewVendor, setShowNewVendor] = useState(false);
  const [newVendorName, setNewVendorName] = useState("");
  const [newVendorPhone, setNewVendorPhone] = useState("");
  const [newVendorNotes, setNewVendorNotes] = useState("");

  // Make payment
  const [payAmount, setPayAmount] = useState("");
  const [payHead, setPayHead] = useState("CASH");
  const [payDate, setPayDate] = useState(todayPKTString());

  // Record receipt (money a vendor is paying back to you)
  const [receiveAmount, setReceiveAmount] = useState("");
  const [receiveHead, setReceiveHead] = useState("CASH");

  // Bill form
  const [date, setDate] = useState(todayPKTString());
  const [reference, setReference] = useState("");
  const [lines, setLines] = useState<(BillLine & { _key: string })[]>([
    { _key: "k0", description: "", category: BILL_CATEGORIES[0], amount: 0 },
  ]);
  const [receiptUrl, setReceiptUrl] = useState<string | null>(null);
  const [receiptName, setReceiptName] = useState("");
  const [receiptUploading, setReceiptUploading] = useState(false);

  async function handleReceiptFile(file: File) {
    if (!file.type.startsWith("image/")) { toast.error("Please choose an image file."); return; }
    setReceiptUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/vendor-receipts", { method: "POST", body: fd });
      const json = await res.json();
      if (json.ok) { setReceiptUrl(json.url); setReceiptName(file.name); toast.success("Receipt uploaded."); }
      else toast.error(json.error || "Upload failed.");
    } catch {
      toast.error("Upload failed.");
    } finally {
      setReceiptUploading(false);
    }
  }

  // Preview
  const [previewBill, setPreviewBill] = useState<VendorBillEntry | null>(null);

  const selectedVendor = vendors.find((v) => v.id === selectedVendorId) ?? null;

  // ── Vendor selection ──────────────────────────────────────────────────────

  function handleVendorChange(id: string) {
    setSelectedVendorId(id);
    if (!id) { setBills([]); setReceivables([]); return; }
    setLoadingBills(true);
    startTransition(async () => {
      const [b, r] = await Promise.all([getVendorBills(id), getVendorReceivables(id)]);
      setBills(b);
      setReceivables(r);
      setLoadingBills(false);
    });
  }

  function handleAddNewVendor() {
    if (!newVendorName.trim()) { toast.error("Enter a vendor name."); return; }
    startTransition(async () => {
      const res = await createVendor(
        newVendorName.trim(),
        newVendorPhone.trim() || undefined,
        newVendorNotes.trim() || undefined
      );
      if (res.ok) {
        setVendors((prev) => [...prev, res.vendor].sort((a, b) => a.name.localeCompare(b.name)));
        setSelectedVendorId(res.vendor.id);
        setBills([]);
        setShowNewVendor(false);
        setNewVendorName("");
        setNewVendorPhone("");
        setNewVendorNotes("");
        toast.success("Vendor added.");
      } else {
        toast.error(res.error);
      }
    });
  }

  function handleMakePayment() {
    const amount = parseFloat(payAmount);
    if (!selectedVendorId)    { toast.error("Select a vendor first."); return; }
    if (!amount || amount <= 0) { toast.error("Enter a valid amount."); return; }
    startTransition(async () => {
      const res = await recordVendorPayment({ vendorId: selectedVendorId, amount, head: payHead, date: payDate });
      if (res.ok) {
        toast.success(
          res.advance > 0
            ? `Rs ${fmt(res.applied)} applied · Rs ${fmt(res.advance)} recorded as an advance — they now owe you that.`
            : `Rs ${fmt(res.applied)} applied to outstanding bills.`
        );
        setPayAmount("");
        setPayDate(todayPKTString());
        // Refresh bills and vendor outstanding
        const updatedBills = await getVendorBills(selectedVendorId);
        setBills(updatedBills);
        setVendors((prev) =>
          prev.map((v) =>
            v.id === selectedVendorId
              // The surplus moves to the other column rather than vanishing into
              // a Math.max(0, …) the way it used to.
              ? { ...v, outstanding: Math.max(0, v.outstanding - res.applied), receivable: v.receivable + res.advance }
              : v
          )
        );
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  // Net what they owe us against what we owe them — no cash moves. Only offered when
  // the vendor has a balance on BOTH sides.
  function handleSettleContra() {
    if (!selectedVendorId) { toast.error("Select a vendor first."); return; }
    startTransition(async () => {
      const res = await settleVendorContra({ vendorId: selectedVendorId });
      if (res.ok) {
        toast.success(`Rs ${fmt(res.settled)} netted off both sides — no cash moved.`);
        const updatedR = await getVendorReceivables(selectedVendorId);
        setReceivables(updatedR);
        const updatedB = await getVendorBills(selectedVendorId);
        setBills(updatedB);
        setVendors((prev) =>
          prev.map((v) =>
            v.id === selectedVendorId
              ? {
                  ...v,
                  outstanding: Math.max(0, v.outstanding - res.settled),
                  receivable:  Math.max(0, v.receivable  - res.settled),
                }
              : v
          )
        );
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  function handleRecordReceipt() {
    const amount = parseFloat(receiveAmount);
    if (!selectedVendorId)      { toast.error("Select a vendor first."); return; }
    if (!amount || amount <= 0) { toast.error("Enter a valid amount."); return; }
    startTransition(async () => {
      const res = await recordVendorReceipt({ vendorId: selectedVendorId, amount, head: receiveHead });
      if (res.ok) {
        toast.success(
          res.advance > 0
            ? `Rs ${fmt(res.applied)} applied · Rs ${fmt(res.advance)} held as an advance — you now owe them that.`
            : `Rs ${fmt(res.applied)} applied to their receivables.`
        );
        setReceiveAmount("");
        const updated = await getVendorReceivables(selectedVendorId);
        setReceivables(updated);
        setVendors((prev) =>
          prev.map((v) =>
            v.id === selectedVendorId
              ? { ...v, receivable: Math.max(0, v.receivable - res.applied), outstanding: v.outstanding + res.advance }
              : v
          )
        );
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  function handleDeleteReceivable(id: string) {
    if (!window.confirm("Delete this receivable? It removes a record of money this vendor owes you.")) return;
    const receivable = receivables.find((r) => r.id === id);
    startTransition(async () => {
      const res = await deleteVendorReceivable(id);
      if (res.ok) {
        toast.success("Receivable deleted.");
        setReceivables((prev) => prev.filter((r) => r.id !== id));
        if (receivable) {
          setVendors((prev) =>
            prev.map((v) =>
              v.id === selectedVendorId
                ? { ...v, receivable: Math.max(0, v.receivable - (receivable.amount - receivable.received)) }
                : v
            )
          );
        }
      } else {
        toast.error(res.error);
      }
    });
  }

  // ── Line items ────────────────────────────────────────────────────────────

  function addLine() {
    setLines((prev) => [
      ...prev,
      { _key: `k${Date.now()}`, description: "", category: BILL_CATEGORIES[0], amount: 0 },
    ]);
  }

  function updateLine(key: string, field: keyof BillLine, value: string | number) {
    setLines((prev) =>
      prev.map((l) => (l._key === key ? { ...l, [field]: value } : l))
    );
  }

  function removeLine(key: string) {
    setLines((prev) => prev.filter((l) => l._key !== key));
  }

  const total = lines.reduce((s, l) => s + (l.amount || 0), 0);

  // ── Generate bill ─────────────────────────────────────────────────────────

  function handleGenerate() {
    if (!selectedVendorId) { toast.error("Select a vendor first."); return; }
    if (!date) { toast.error("Date is required."); return; }
    const validLines = lines.filter((l) => l.description.trim() || l.amount > 0);
    if (!validLines.length) { toast.error("Add at least one item."); return; }
    if (total <= 0) { toast.error("Total amount must be greater than 0."); return; }

    startTransition(async () => {
      const res = await createVendorBill({
        vendorId: selectedVendorId,
        date,
        reference: reference.trim(),
        lines: validLines.map(({ description, category, amount }) => ({ description, category, amount })),
        receiptUrl,
      });
      if (res.ok) {
        toast.success("Bill created.");
        setPreviewBill(res.bill);
        setBills((prev) => [res.bill, ...prev]);
        // Update outstanding balance in vendor list
        setVendors((prev) =>
          prev.map((v) =>
            v.id === selectedVendorId
              ? { ...v, outstanding: v.outstanding + res.bill.amount, billCount: v.billCount + 1 }
              : v
          )
        );
        // Reset form
        setReference("");
        setLines([{ _key: `k${Date.now()}`, description: "", category: BILL_CATEGORIES[0], amount: 0 }]);
        setReceiptUrl(null);
        setReceiptName("");
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  function handleClear() {
    setSelectedVendorId("");
    setShowNewVendor(false);
    setNewVendorName("");
    setNewVendorPhone("");
    setNewVendorNotes("");
    setBills([]);
    setReceivables([]);
    setPayAmount("");
    setReceiveAmount("");
    setDate(todayPKTString());
    setReference("");
    setLines([{ _key: "k0", description: "", category: BILL_CATEGORIES[0], amount: 0 }]);
    setReceiptUrl(null);
    setReceiptName("");
  }

  function handleDeleteBill(id: string) {
    if (!window.confirm("Delete this bill? If it was already paid, the payment stays recorded — this only removes the bill.")) return;
    const bill = bills.find((b) => b.id === id);
    startTransition(async () => {
      const res = await deleteVendorBill(id);
      if (res.ok) {
        toast.success("Bill deleted.");
        setBills((prev) => prev.filter((b) => b.id !== id));
        if (bill) {
          setVendors((prev) =>
            prev.map((v) =>
              v.id === selectedVendorId
                ? { ...v, outstanding: Math.max(0, v.outstanding - (bill.amount - bill.paid)), billCount: Math.max(0, v.billCount - 1) }
                : v
            )
          );
        }
      } else {
        toast.error(res.error);
      }
    });
  }

  const totalOutstanding = vendors.reduce((s, v) => s + v.outstanding, 0);
  const totalReceivable = vendors.reduce((s, v) => s + v.receivable, 0);

  return (
    <div className="space-y-5 p-4 sm:p-6">
      {/* ── Totals across all vendors — never netted together ── */}
      {(totalOutstanding > 0 || totalReceivable > 0) && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {totalOutstanding > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-center justify-between">
              <span className="text-sm font-medium text-amber-800">Total Outstanding (you owe them)</span>
              <span className="text-base font-bold text-amber-900 tabular-nums">₨ {fmt(totalOutstanding)}</span>
            </div>
          )}
          {totalReceivable > 0 && (
            <div className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 flex items-center justify-between">
              <span className="text-sm font-medium text-sky-800">Total Receivable (they owe you)</span>
              <span className="text-base font-bold text-sky-900 tabular-nums">₨ {fmt(totalReceivable)}</span>
            </div>
          )}
        </div>
      )}
      {/* ── Vendor selection ── */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-base">
              <Building2 className="size-4" /> Vendor
            </CardTitle>
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 text-xs"
              onClick={() => { setShowNewVendor((v) => !v); setNewVendorName(""); setNewVendorPhone(""); }}
            >
              <Plus className="size-3" /> Add vendor
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* New vendor form */}
          {showNewVendor && (
            <div className="rounded-lg border border-dashed border-border bg-muted/30 p-3 space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">New vendor</p>
              <div className="grid grid-cols-2 gap-2">
                <Input
                  placeholder="Vendor name *"
                  value={newVendorName}
                  onChange={(e) => setNewVendorName(e.target.value)}
                  className="text-sm"
                />
                <Input
                  placeholder="Phone number"
                  value={newVendorPhone}
                  onChange={(e) => setNewVendorPhone(e.target.value)}
                  className="text-sm"
                />
              </div>
              <Input
                placeholder="Details / notes (e.g. Animal feed supplier, Lahore Road)"
                value={newVendorNotes}
                onChange={(e) => setNewVendorNotes(e.target.value)}
                className="text-sm"
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={handleAddNewVendor} disabled={isPending} className="shrink-0">
                  Save vendor
                </Button>
                <Button size="sm" variant="outline" onClick={() => { setShowNewVendor(false); setNewVendorName(""); setNewVendorPhone(""); setNewVendorNotes(""); }} className="shrink-0">
                  <X className="size-3.5" />
                </Button>
              </div>
            </div>
          )}

          <div>
            <Label>Select vendor</Label>
            <select
              value={selectedVendorId}
              onChange={(e) => handleVendorChange(e.target.value)}
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="">— choose vendor —</option>
              {vendors.map((v) => {
                const bits = [
                  v.outstanding > 0 ? `Rs ${fmt(v.outstanding)} payable` : "",
                  v.receivable > 0 ? `Rs ${fmt(v.receivable)} receivable` : "",
                ].filter(Boolean).join(" · ");
                return (
                  <option key={v.id} value={v.id}>
                    {v.name}{bits ? ` (${bits})` : ""}
                  </option>
                );
              })}
            </select>
          </div>

          {/* Amount we owe this vendor */}
          {selectedVendor && (
            <div className={`rounded-lg px-4 py-3 space-y-2 ${selectedVendor.outstanding > 0 ? "bg-amber-50 border border-amber-200" : "bg-muted/40"}`}>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-muted-foreground">Amount we owe</p>
                  <p className="text-sm font-semibold mt-0.5">{selectedVendor.name}</p>
                  {selectedVendor.notes && (
                    <p className="text-[10px] text-muted-foreground mt-0.5">{selectedVendor.notes}</p>
                  )}
                </div>
                <div className="text-right">
                  <p className={`text-xl font-bold ${selectedVendor.outstanding > 0 ? "text-amber-700" : "text-emerald-600"}`}>
                    Rs {fmt(selectedVendor.outstanding)}
                  </p>
                  {selectedVendor.outstanding > 0 ? (
                    <div className="flex items-center gap-1 text-[10px] text-amber-600 mt-0.5">
                      <AlertCircle className="size-2.5" /> payable to vendor
                    </div>
                  ) : (
                    <p className="text-[10px] text-emerald-600 mt-0.5">All clear</p>
                  )}
                </div>
              </div>
              {/* Make payment. No longer hidden when nothing is owed — paying more
                  than the balance is allowed, and the surplus becomes a credit they
                  owe us that settles against their next bill. */}
              {(
                <div className="flex flex-wrap gap-2 items-center pt-1 border-t border-amber-200">
                  <Input
                    type="number"
                    min="0"
                    step="1"
                    placeholder="Payment amount"
                    value={payAmount}
                    onChange={(e) => setPayAmount(e.target.value)}
                    className="h-8 text-sm flex-1 min-w-[120px]"
                  />
                  <Input
                    type="date"
                    value={payDate}
                    max={todayPKTString()}
                    onChange={(e) => setPayDate(e.target.value || todayPKTString())}
                    className="h-8 w-[150px] shrink-0 text-sm"
                    aria-label="Payment date"
                    title="Payment date"
                  />
                  <Select value={payHead} onValueChange={setPayHead}>
                    <SelectTrigger className="h-8 w-44 text-xs shrink-0">
                      <SelectValue placeholder="Pay from" />
                    </SelectTrigger>
                    <SelectContent>
                      {PAY_HEADS.map((h) => {
                        const bal = headBalanceOf(h.value);
                        return (
                          <SelectItem key={h.value} value={h.value} className="text-xs">
                            <span className="flex w-full items-center justify-between gap-3">
                              <span>{h.label}</span>
                              {bal !== undefined && (
                                <span className={`font-mono text-[10px] ${bal < 0 ? "text-rose-600" : "text-muted-foreground"}`}>
                                  {bal < 0 ? "−" : ""}Rs {fmt(bal)}
                                </span>
                              )}
                            </span>
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    className="h-8 text-xs shrink-0 bg-amber-600 hover:bg-amber-700 text-white"
                    onClick={handleMakePayment}
                    disabled={isPending}
                  >
                    Pay vendor
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* Settle one against the other — only when the vendor owes us AND we owe them.
              Nets the smaller of the two off both sides with no cash movement. */}
          {selectedVendor && selectedVendor.outstanding > 0 && selectedVendor.receivable > 0 && (
            <div className="rounded-lg border border-violet-200 bg-violet-50 px-4 py-3 dark:border-violet-900 dark:bg-violet-950/30">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-xs font-semibold text-violet-800 dark:text-violet-300">Net off the balances</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    Cancels Rs {fmt(Math.min(selectedVendor.outstanding, selectedVendor.receivable))} from both sides — no cash moves.
                  </p>
                </div>
                <Button
                  size="sm"
                  className="h-8 text-xs shrink-0 bg-violet-600 hover:bg-violet-700 text-white"
                  onClick={handleSettleContra}
                  disabled={isPending}
                >
                  Settle against balance
                </Button>
              </div>
            </div>
          )}

          {/* Amount this vendor owes us — tracked separately from the payable above */}
          {selectedVendor && (
            <div className={`rounded-lg px-4 py-3 space-y-2 ${selectedVendor.receivable > 0 ? "bg-sky-50 border border-sky-200" : "bg-muted/40"}`}>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-muted-foreground">Amount they owe us</p>
                  <p className="text-sm font-semibold mt-0.5">{selectedVendor.name}</p>
                </div>
                <div className="text-right">
                  <p className={`text-xl font-bold ${selectedVendor.receivable > 0 ? "text-sky-700" : "text-emerald-600"}`}>
                    Rs {fmt(selectedVendor.receivable)}
                  </p>
                  {selectedVendor.receivable > 0 ? (
                    <div className="flex items-center gap-1 text-[10px] text-sky-600 mt-0.5">
                      <AlertCircle className="size-2.5" /> receivable from vendor
                    </div>
                  ) : (
                    <p className="text-[10px] text-emerald-600 mt-0.5">All clear</p>
                  )}
                </div>
              </div>
              {/* Record receipt. Same rule in reverse: taking more than they owe
                  leaves a credit we owe them. */}
              {(
                <div className="flex flex-wrap gap-2 items-center pt-1 border-t border-sky-200">
                  <Input
                    type="number"
                    min="0"
                    step="1"
                    placeholder="Receipt amount"
                    value={receiveAmount}
                    onChange={(e) => setReceiveAmount(e.target.value)}
                    className="h-8 text-sm flex-1 min-w-[120px]"
                  />
                  <Select value={receiveHead} onValueChange={setReceiveHead}>
                    <SelectTrigger className="h-8 w-32 text-xs shrink-0">
                      <SelectValue placeholder="Receive into" />
                    </SelectTrigger>
                    <SelectContent>
                      {RECEIVE_HEADS.map((h) => (
                        <SelectItem key={h.value} value={h.value} className="text-xs">{h.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    className="h-8 text-xs shrink-0 bg-sky-600 hover:bg-sky-700 text-white"
                    onClick={handleRecordReceipt}
                    disabled={isPending}
                  >
                    Record receipt
                  </Button>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Bill details ── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Bill Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Date</Label>
              <Input
                type="date"
                className="mt-1"
                value={date}
                max={todayPKTString()}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
            <div>
              <Label>Bill reference # (optional)</Label>
              <Input
                className="mt-1"
                placeholder="e.g. INV-2026-041"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
              />
            </div>
          </div>

          {/* Receipt image (proof) */}
          <div>
            <Label>Receipt photo (optional)</Label>
            <div className="mt-1 flex flex-wrap items-center gap-3">
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted/50">
                {receiptUploading ? <Loader2 className="size-3.5 animate-spin" /> : <ImageIcon className="size-3.5" />}
                {receiptUploading ? "Uploading…" : receiptUrl ? "Change photo" : "Upload receipt"}
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  disabled={receiptUploading}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleReceiptFile(f);
                    e.target.value = ""; // allow re-selecting the same file
                  }}
                />
              </label>

              {receiptUrl && (
                <div className="flex items-center gap-2 rounded-md border border-border bg-muted/20 p-1 pr-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={receiptUrl} alt="Receipt" className="size-9 rounded object-cover" />
                  <span className="max-w-[140px] truncate text-[11px] text-muted-foreground">{receiptName || "receipt"}</span>
                  <button
                    type="button"
                    onClick={() => { setReceiptUrl(null); setReceiptName(""); }}
                    className="rounded p-0.5 text-muted-foreground hover:bg-rose-50 hover:text-rose-600"
                    title="Remove"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              )}
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">Attach a photo of the vendor&apos;s receipt as proof (image, max 10 MB).</p>
          </div>

          {/* Line items header */}
          <div className="grid grid-cols-[1fr_100px_90px_32px] gap-2 sm:grid-cols-[1fr_140px_120px_32px]">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Item / Description</p>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Category</p>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide text-right">Amount (Rs)</p>
            <div />
          </div>

          {/* Line items */}
          <div className="space-y-2">
            {lines.map((line) => (
              <LineItem
                key={line._key}
                line={line}
                onUpdate={(f, v) => updateLine(line._key, f, v)}
                onRemove={() => removeLine(line._key)}
                canRemove={lines.length > 1}
              />
            ))}
          </div>

          <Button size="sm" variant="outline" onClick={addLine} className="text-xs">
            <Plus className="mr-1.5 size-3.5" /> Add item
          </Button>

          {/* Total */}
          <div className="flex items-center justify-between border-t border-border pt-3">
            <span className="text-sm font-semibold text-muted-foreground">Total bill</span>
            <span className="text-2xl font-bold">Rs {fmt(total)}</span>
          </div>
        </CardContent>
      </Card>

      {/* ── Actions ── */}
      <div className="flex gap-3">
        <Button
          className="flex-1"
          onClick={handleGenerate}
          disabled={isPending || !selectedVendorId}
        >
          {isPending ? "Saving…" : "Generate Bill"}
        </Button>
        <Button variant="outline" className="flex-1" onClick={handleClear}>
          Clear
        </Button>
      </div>

      {/* ── Recent bills ── */}
      {selectedVendor && (
        <div>
          <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Recent bills — {selectedVendor.name}
          </p>
          {loadingBills ? (
            <div className="flex h-20 items-center justify-center text-sm text-muted-foreground">Loading…</div>
          ) : (
            <RecentBills
              bills={bills}
              vendorName={selectedVendor.name}
              onDelete={handleDeleteBill}
            />
          )}
        </div>
      )}

      {/* ── Recent receivables (Over-the-Counter sales made to this vendor) ── */}
      {selectedVendor && (
        <div>
          <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Recent receivables — {selectedVendor.name}
          </p>
          {loadingBills ? (
            <div className="flex h-20 items-center justify-center text-sm text-muted-foreground">Loading…</div>
          ) : (
            <RecentReceivables
              receivables={receivables}
              onDelete={handleDeleteReceivable}
            />
          )}
        </div>
      )}

      {/* Print preview dialog (after generate) */}
      {previewBill && selectedVendor && (
        <PrintPreview
          bill={previewBill}
          vendorName={selectedVendor.name}
          oldBalance={selectedVendor.outstanding - previewBill.amount}
          open={!!previewBill}
          onClose={() => setPreviewBill(null)}
        />
      )}
    </div>
  );
}

