"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  saveRiderEdits, refundSpoiled, replaceSpoiled, type ReportRow,
} from "@/app/(dashboard)/customers/rider-report/actions";

const uLabel = (u: string) => (u === "LITER" ? "L" : u === "KG" ? "kg" : "pc");

export function RiderEditDialog({
  row,
  shiftId,
  date,
  onClose,
  onSaved,
}: {
  row: ReportRow | null;
  shiftId: string;
  date: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [pending, start] = useTransition();
  // Editable delivered/returned per product, keyed by productId.
  const [lines, setLines] = useState<Record<string, { delivered: string; returned: string }>>({});
  const [cash, setCash] = useState("");
  // Spoilage section.
  const [spProduct, setSpProduct] = useState("");
  const [spQty, setSpQty] = useState("");

  // Re-seed the form whenever a different customer's row is opened.
  useEffect(() => {
    if (!row) return;
    setLines(Object.fromEntries(row.products.map((p) => [p.productId, { delivered: String(p.delivered), returned: String(p.returned) }])));
    setCash(row.cashCollected != null ? String(row.cashCollected) : "");
    setSpProduct(row.products[0]?.productId ?? "");
    setSpQty("");
  }, [row]);

  if (!row) return null;

  const setLine = (pid: string, field: "delivered" | "returned", val: string) =>
    setLines((m) => ({ ...m, [pid]: { ...(m[pid] ?? { delivered: "0", returned: "0" }), [field]: val } }));

  function saveEdits() {
    if (!row) return;
    start(async () => {
      const res = await saveRiderEdits({
        customerId: row.customerId,
        shiftId,
        date,
        cash: Number(cash) || 0,
        lines: row.products.map((p) => ({
          productId: p.productId,
          delivered: Number(lines[p.productId]?.delivered) || 0,
          returned: Number(lines[p.productId]?.returned) || 0,
        })),
      });
      if (res.ok) { toast.success("Rider work updated."); onSaved(); }
      else toast.error(res.error);
    });
  }

  function doSpoilage(kind: "refund" | "replace") {
    if (!row) return;
    const qty = Number(spQty);
    if (!spProduct) return toast.error("Pick a product.");
    if (!Number.isFinite(qty) || qty <= 0) return toast.error("Enter a spoiled quantity greater than 0.");
    start(async () => {
      const res = kind === "refund"
        ? await refundSpoiled(row.customerId, date, spProduct, qty, shiftId)
        : await replaceSpoiled(row.customerId, date, spProduct, qty, shiftId);
      if (res.ok) {
        toast.success(kind === "refund" ? "Refund recorded — the customer owes less." : "Replacement recorded — fresh stock sent from storage.");
        setSpQty("");
        onSaved();
      } else toast.error(res.error);
    });
  }

  return (
    <Dialog open={!!row} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">Edit — {row.name}</DialogTitle>
        </DialogHeader>

        {/* Correct the rider's delivery record */}
        <div className="space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Delivered / returned</p>
          {row.products.length === 0 ? (
            <p className="text-xs text-muted-foreground">No products for this customer.</p>
          ) : (
            <div className="space-y-2">
              {row.products.map((p) => (
                <div key={p.productId} className="grid grid-cols-[1fr_auto_auto] items-center gap-2">
                  <span className="truncate text-sm">{p.productName} <span className="text-[11px] text-muted-foreground">({uLabel(p.unit)})</span></span>
                  <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
                    Del
                    <Input type="number" min="0" step="any" inputMode="decimal" className="h-8 w-16"
                      value={lines[p.productId]?.delivered ?? "0"} onChange={(e) => setLine(p.productId, "delivered", e.target.value)} />
                  </label>
                  <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
                    Ret
                    <Input type="number" min="0" step="any" inputMode="decimal" className="h-8 w-16"
                      value={lines[p.productId]?.returned ?? "0"} onChange={(e) => setLine(p.productId, "returned", e.target.value)} />
                  </label>
                </div>
              ))}
            </div>
          )}
          <div className="grid grid-cols-[1fr_auto] items-center gap-2 pt-1">
            <Label className="text-xs text-muted-foreground">Cash collected (Rs)</Label>
            <Input type="number" min="0" step="any" inputMode="decimal" className="h-8 w-28"
              value={cash} onChange={(e) => setCash(e.target.value)} placeholder="0" />
          </div>
          <Button size="sm" className="w-full" onClick={saveEdits} disabled={pending}>
            {pending ? "Saving…" : "Save changes"}
          </Button>
        </div>

        {/* After-delivery spoilage → refund or replace */}
        <div className="mt-2 space-y-2 rounded-lg border border-border p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Spoiled milk (customer complaint)</p>
          <p className="text-[11px] text-muted-foreground">
            Refund reduces the customer&apos;s bill. Replace sends fresh stock from storage (what the rider returned).
          </p>
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <Select value={spProduct} onValueChange={setSpProduct}>
              <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="Product" /></SelectTrigger>
              <SelectContent>
                {row.products.map((p) => <SelectItem key={p.productId} value={p.productId}>{p.productName}</SelectItem>)}
              </SelectContent>
            </Select>
            <Input type="number" min="0" step="any" inputMode="decimal" className="h-8 w-24" placeholder="Qty"
              value={spQty} onChange={(e) => setSpQty(e.target.value)} />
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" className="flex-1" onClick={() => doSpoilage("refund")} disabled={pending}>Refund</Button>
            <Button size="sm" variant="outline" className="flex-1" onClick={() => doSpoilage("replace")} disabled={pending}>Replace</Button>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={pending}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
