"use client";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { fmtMoney } from "./otc-line-editor";
import { PAYMENT_HEAD_LABELS } from "@/lib/payment-heads";

export type OtcInvoiceView = {
  kind: "sale" | "purchase";
  invoiceNo: string;
  date: string;
  partyLabel: string;
  partyName: string;
  tag?: string;
  deliveryCharge?: number;
  narration: string;
  totalAmount: number;
  paidAmount?: number;
  paymentStatus: "PAID" | "PARTIAL" | "CREDIT";
  paymentHead: string | null;
  lines: { productName: string; unit: string; rate: number; quantity: number; amount: number }[];
};

const HEAD_LABEL: Record<string, string> = PAYMENT_HEAD_LABELS;

export function OtcInvoiceDialog({
  invoice,
  onClose,
}: {
  invoice: OtcInvoiceView | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={!!invoice} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg sm:max-w-lg">
        {invoice && (
          <div id="otc-invoice-print" className="space-y-4">
            <DialogHeader className="border-b-2 border-foreground pb-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <DialogTitle className="font-serif text-2xl font-semibold">
                    {invoice.kind === "sale" ? "Sale" : "Purchase"} Invoice
                  </DialogTitle>
                </div>
                <div className="text-right">
                  <p className="text-[9px] uppercase tracking-wide text-muted-foreground">Invoice No</p>
                  <p className="font-mono text-sm font-bold text-primary">{invoice.invoiceNo}</p>
                </div>
              </div>
            </DialogHeader>

            <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-[9px] uppercase tracking-wide text-muted-foreground">Date</dt>
                <dd className="font-medium">{new Date(invoice.date).toLocaleDateString("en-GB")}</dd>
              </div>
              <div className="col-span-2">
                <dt className="text-[9px] uppercase tracking-wide text-muted-foreground">{invoice.partyLabel}</dt>
                <dd className="font-medium">
                  {invoice.tag && (
                    <span className="mr-1.5 rounded-full border border-current px-1.5 py-0.5 text-[9px] font-bold uppercase text-emerald-700">
                      {invoice.tag}
                    </span>
                  )}
                  {invoice.partyName}
                </dd>
              </div>
              <div>
                <dt className="text-[9px] uppercase tracking-wide text-muted-foreground">Payment</dt>
                <dd className="font-medium">
                  {invoice.paymentStatus === "PAID"
                    ? `Paid — ${HEAD_LABEL[invoice.paymentHead ?? ""] ?? invoice.paymentHead}`
                    : invoice.paymentStatus === "CREDIT"
                    ? "On Credit"
                    : `Partial — ${HEAD_LABEL[invoice.paymentHead ?? ""] ?? invoice.paymentHead}`}
                </dd>
              </div>
            </dl>

            <div className="overflow-x-auto">
            <table className="w-full min-w-[360px] text-sm">
              <thead>
                <tr className="border-b border-border text-[9px] uppercase tracking-wide text-muted-foreground">
                  <th className="py-1.5 text-left font-medium">Product</th>
                  <th className="py-1.5 text-left font-medium">Unit</th>
                  <th className="py-1.5 text-right font-medium">Rate</th>
                  <th className="py-1.5 text-right font-medium">Qty</th>
                  <th className="py-1.5 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {invoice.lines.map((l, i) => (
                  <tr key={i} className="border-b border-border/50">
                    <td className="py-1.5">{l.productName}</td>
                    <td className="py-1.5 font-mono text-xs text-muted-foreground">{l.unit}</td>
                    <td className="py-1.5 text-right font-mono text-xs">{fmtMoney(l.rate)}</td>
                    <td className="py-1.5 text-right font-mono text-xs">{l.quantity}</td>
                    <td className="py-1.5 text-right font-mono text-xs font-semibold">{fmtMoney(l.amount)}</td>
                  </tr>
                ))}
                {!!invoice.deliveryCharge && (
                  <tr className="border-b border-border/50">
                    <td className="py-1.5 text-muted-foreground" colSpan={4}>Delivery charge</td>
                    <td className="py-1.5 text-right font-mono text-xs font-semibold">
                      {fmtMoney(invoice.deliveryCharge)}
                    </td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr className="bg-primary text-primary-foreground">
                  <td colSpan={4} className="px-1.5 py-2.5 text-[10px] font-bold uppercase tracking-wide">
                    Grand Total (PKR)
                  </td>
                  <td className="px-1.5 py-2.5 text-right font-mono text-lg font-bold">
                    {fmtMoney(invoice.totalAmount)}
                  </td>
                </tr>
                {invoice.paymentStatus === "PARTIAL" && (
                  <>
                    <tr className="border-b border-border/50">
                      <td colSpan={4} className="px-1.5 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700">
                        Paid Now ({HEAD_LABEL[invoice.paymentHead ?? ""] ?? invoice.paymentHead})
                      </td>
                      <td className="px-1.5 py-1.5 text-right font-mono text-xs font-semibold text-emerald-700">
                        {fmtMoney(invoice.paidAmount ?? 0)}
                      </td>
                    </tr>
                    <tr>
                      <td colSpan={4} className="px-1.5 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
                        Balance On Credit
                      </td>
                      <td className="px-1.5 py-1.5 text-right font-mono text-xs font-semibold text-amber-700">
                        {fmtMoney(invoice.totalAmount - (invoice.paidAmount ?? 0))}
                      </td>
                    </tr>
                  </>
                )}
              </tfoot>
            </table>
            </div>

            {invoice.narration && (
              <p className="text-xs text-muted-foreground">
                <strong className="text-foreground">Narration: </strong>{invoice.narration}
              </p>
            )}

            <div className="flex justify-end gap-2 print:hidden">
              <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
              <Button size="sm" onClick={() => window.print()}>Print Invoice</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
