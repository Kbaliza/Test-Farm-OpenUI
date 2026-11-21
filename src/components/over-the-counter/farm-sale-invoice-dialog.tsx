"use client";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Printer } from "lucide-react";
import { categoryLabel, describeDetails } from "@/lib/farm-sale-catalog";
import type { FarmSaleView } from "@/app/(dashboard)/over-the-counter/farm-sales/actions";
import { PAYMENT_HEAD_LABELS } from "@/lib/payment-heads";

// The printable record of a farm sale. Modelled on otc-invoice-dialog, but this one
// has no payment status to show: a farm sale is always paid in full.

// From lib/payment-heads: lib/head-balances is server-only and this is a client component.
const HEAD_LABEL: Record<string, string> = PAYMENT_HEAD_LABELS;

const money = (n: number) => Math.round(n).toLocaleString("en-PK");

export function FarmSaleInvoiceDialog({
  sale,
  onClose,
}: {
  sale: FarmSaleView | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={!!sale} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[88vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-sm">{sale?.invoiceNo}</DialogTitle>
        </DialogHeader>
        {sale && (
          <div id="farm-sale-print" className="space-y-3 text-sm">
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <p className="text-muted-foreground">Buyer</p>
                <p className="font-medium">
                  <span className="mr-1.5 rounded-full border border-emerald-300 px-1.5 py-0.5 text-[9px] font-bold uppercase text-emerald-700">
                    {sale.buyerType === "VENDOR" ? "Vendor" : "Cash"}
                  </span>
                  {sale.buyerName}
                </p>
              </div>
              <div className="text-right">
                <p className="text-muted-foreground">Date</p>
                <p className="font-medium">{new Date(sale.date).toLocaleDateString("en-GB")}</p>
              </div>
              {sale.gatePassNo && (
                <div>
                  <p className="text-muted-foreground">Gate pass</p>
                  <p className="font-mono font-medium">{sale.gatePassNo}</p>
                </div>
              )}
              <div className="text-right">
                <p className="text-muted-foreground">Received into</p>
                <p className="font-medium">{HEAD_LABEL[sale.paymentHead] ?? sale.paymentHead}</p>
              </div>
            </div>

            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[520px] text-xs">
                <thead className="bg-muted/40">
                  <tr>
                    {["Item", "Unit", "Rate", "Qty", "Total"].map((h, i) => (
                      <th key={h} className={`px-3 py-2 font-semibold uppercase tracking-wide text-muted-foreground ${i >= 2 ? "text-right" : "text-left"}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {sale.lines.map((l) => {
                    const details = describeDetails(l.category, l.details);
                    return (
                      <tr key={l.id}>
                        <td className="px-3 py-2">
                          <span className="mr-1.5 rounded-full border border-border px-1.5 py-0.5 text-[9px] font-bold uppercase text-muted-foreground">
                            {categoryLabel(l.category)}
                          </span>
                          <span className="font-medium">{l.item}</span>
                          {l.animalTag && <span className="ml-1 font-mono text-[10px] text-muted-foreground">#{l.animalTag}</span>}
                          {details && <p className="mt-0.5 text-[10px] text-muted-foreground">{details}</p>}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">{l.unit}</td>
                        <td className="px-3 py-2 text-right font-mono">{money(l.rate)}</td>
                        <td className="px-3 py-2 text-right font-mono">{l.quantity}</td>
                        <td className="px-3 py-2 text-right font-mono font-semibold">{money(l.amount)}</td>
                      </tr>
                    );
                  })}
                  {sale.transportCharge > 0 && (
                    <tr>
                      <td colSpan={4} className="px-3 py-2 text-muted-foreground">Transport charge</td>
                      <td className="px-3 py-2 text-right font-mono">{money(sale.transportCharge)}</td>
                    </tr>
                  )}
                </tbody>
                <tfoot>
                  <tr className="border-t border-border bg-muted/30">
                    <td colSpan={4} className="px-3 py-2 font-semibold">Total — paid in full</td>
                    <td className="px-3 py-2 text-right font-mono text-sm font-bold">Rs {money(sale.totalAmount)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {sale.narration && <p className="text-xs text-muted-foreground">{sale.narration}</p>}

            <div className="flex justify-end print:hidden">
              <Button variant="outline" size="sm" onClick={() => window.print()}>
                <Printer className="mr-1.5 size-3.5" /> Print
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
