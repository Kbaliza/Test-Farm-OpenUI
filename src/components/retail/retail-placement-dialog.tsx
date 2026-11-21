"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { unitLabel, isPackUnit, packLabel, packQtyLabel, equivalentLabel } from "@/lib/units";
import { toast } from "sonner";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { stepForUnit, quantityProblem } from "@/lib/quantity";
import { round2 } from "@/lib/retail-math";
import {
  createRetailPlacement,
  createRetailVendor,
  type RetailContext,
} from "@/app/(dashboard)/retail/actions";
import { fmt, fmtQty } from "./retail-client";

type LineRow = { key: string; productId: string; quantity: string; rate: string };

let seq = 0;
const newRow = (): LineRow => ({ key: `r${seq++}`, productId: "", quantity: "", rate: "" });

const NEW_MART = "__new__";

export function RetailPlacementDialog({
  open,
  onClose,
  context,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  context: RetailContext;
  onSaved: () => void;
}) {
  const [pending, start] = useTransition();
  const [martId, setMartId] = useState("");
  const [date, setDate] = useState(context.today);
  const [notes, setNotes] = useState("");
  const [rows, setRows] = useState<LineRow[]>([newRow()]);

  // Inline new shop
  const [nv, setNv] = useState({ name: "", managerName: "", phone: "", address: "", areaName: "", city: "", followUpDays: "3" });

  useEffect(() => {
    if (!open) return;
    setMartId("");
    setDate(context.today);
    setNotes("");
    setRows([newRow()]);
    setNv({ name: "", managerName: "", phone: "", address: "", areaName: "", city: "", followUpDays: "3" });
  }, [open, context.today]);

  const productById = useMemo(
    () => new Map(context.products.map((p) => [p.productId, p])),
    [context.products]
  );

  function setRow(key: string, patch: Partial<LineRow>) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function pickProduct(key: string, productId: string) {
    const p = productById.get(productId);
    // Seed the rate from the catalogue, still editable — shop rates are negotiated.
    setRow(key, { productId, rate: p ? String(p.defaultRate) : "" });
  }

  const total = round2(
    rows.reduce((s, r) => s + (parseFloat(r.quantity) || 0) * (parseFloat(r.rate) || 0), 0)
  );

  // What each product would leave in storage, so the person dropping sees the
  // ceiling before the server has to refuse them.
  const overStock = useMemo(() => {
    const wanted = new Map<string, number>();
    for (const r of rows) {
      const q = parseFloat(r.quantity) || 0;
      if (!r.productId || q <= 0) continue;
      wanted.set(r.productId, (wanted.get(r.productId) ?? 0) + q);
    }
    const out: { name: string; want: number; have: number; unit: string }[] = [];
    for (const [productId, want] of wanted) {
      const p = productById.get(productId);
      if (!p) continue;
      // Every product has a ceiling now, retail products included. Skipping them
      // here would offer a drop the server is about to refuse.
      if (want > p.onHand + 1e-6) out.push({ name: p.productName, want, have: p.onHand, unit: p.unit });
    }
    return out;
  }, [rows, productById]);

  function save() {
    const lines = rows
      .filter((r) => r.productId && (parseFloat(r.quantity) || 0) > 0)
      .map((r) => ({
        productId: r.productId,
        quantity: parseFloat(r.quantity) || 0,
        rate: parseFloat(r.rate) || 0,
      }));

    if (lines.length === 0) {
      toast.error("Add at least one product.");
      return;
    }
    for (const l of lines) {
      const p = productById.get(l.productId)!;
      const problem = quantityProblem(p.productName, p.unit, l.quantity);
      if (problem) {
        toast.error(problem);
        return;
      }
    }
    if (overStock.length > 0) {
      const o = overStock[0];
      toast.error(`Not enough ${o.name}: ${fmtQty(o.have)} ${unitLabel(o.unit)} in storage, ${fmtQty(o.want)} requested.`);
      return;
    }

    start(async () => {
      let targetMart = martId;

      if (martId === NEW_MART) {
        if (!nv.name.trim()) {
          toast.error("Enter the shop's name.");
          return;
        }
        const made = await createRetailVendor({
          name: nv.name,
          managerName: nv.managerName,
          phone: nv.phone,
          address: nv.address,
          areaName: nv.areaName,
          city: nv.city,
          followUpDays: parseInt(nv.followUpDays, 10),
        });
        if (!made.ok) {
          toast.error(made.error);
          return;
        }
        targetMart = made.id;
      }

      if (!targetMart) {
        toast.error("Select a shop.");
        return;
      }

      const res = await createRetailPlacement({ retailVendorId: targetMart, date, notes, lines });
      if (res.ok) {
        toast.success(`${res.placementNo} recorded — stock is now out at the shop.`);
        onClose();
        onSaved();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Record a drop</DialogTitle>
          <DialogDescription>
            Product left at a shop on consignment. It leaves storage now; what sold is reported later.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[65vh] space-y-4 overflow-y-auto pr-1">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <Label className="text-xs">Shop</Label>
              <Select value={martId} onValueChange={setMartId}>
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="Select a shop" />
                </SelectTrigger>
                <SelectContent>
                  {context.marts.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name}
                      {m.areaName ? <span className="text-muted-foreground"> · {m.areaName}</span> : null}
                    </SelectItem>
                  ))}
                  <SelectItem value={NEW_MART}>+ Add a new shop</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Date</Label>
              <Input
                type="date"
                className="mt-1"
                value={date}
                max={context.today}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
          </div>

          {martId === NEW_MART && (
            <div className="rounded-lg border border-border bg-muted/30 p-3">
              <p className="mb-2 text-xs font-semibold">New shop details</p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <Field label="Shop name" value={nv.name} onChange={(v) => setNv({ ...nv, name: v })} placeholder="e.g. Abib Mart" />
                <Field label="Manager" value={nv.managerName} onChange={(v) => setNv({ ...nv, managerName: v })} placeholder="e.g. Haider Ali" />
                <Field label="Phone" value={nv.phone} onChange={(v) => setNv({ ...nv, phone: v })} placeholder="03xx-xxxxxxx" />
                <Field label="Address" value={nv.address} onChange={(v) => setNv({ ...nv, address: v })} placeholder="Shop #, street" />
                <Field label="Area" value={nv.areaName} onChange={(v) => setNv({ ...nv, areaName: v })} placeholder="e.g. Phase 8" />
                <Field label="City" value={nv.city} onChange={(v) => setNv({ ...nv, city: v })} placeholder="e.g. Rawalpindi" />
                <div>
                  <Label className="text-xs">Check back after (days)</Label>
                  <Input
                    type="number"
                    min={0}
                    max={60}
                    className="mt-1"
                    value={nv.followUpDays}
                    onChange={(e) => setNv({ ...nv, followUpDays: e.target.value })}
                  />
                </div>
              </div>
            </div>
          )}

          <div>
            <Label className="text-xs">What was left there</Label>
            <div className="mt-1 space-y-2">
              {rows.map((r, i) => {
                const p = r.productId ? productById.get(r.productId) : null;
                return (
                  <div key={r.key} className="grid grid-cols-2 items-end gap-2 rounded-md border border-border p-2 sm:flex sm:flex-wrap">
                    <div className="col-span-2 min-w-0 sm:col-span-1 sm:min-w-[150px] sm:flex-1">
                      <Label className="text-[11px] text-muted-foreground">Product</Label>
                      <Select value={r.productId} onValueChange={(v) => pickProduct(r.key, v)}>
                        <SelectTrigger className="mt-1 h-9">
                          <SelectValue placeholder={`Product ${i + 1}`} />
                        </SelectTrigger>
                        <SelectContent>
                          {context.products.map((prod) => (
                            <SelectItem key={prod.productId} value={prod.productId}>
                              {prod.productName}
                              <span className="text-muted-foreground">
                                {" "}
                                ·{" "}
                                {prod.retailOnly && prod.packSize != null
                                  ? `${fmtQty(prod.onHand)} × ${packLabel(prod.unit, prod.packSize)} in stock`
                                  : `${fmtQty(prod.onHand)} ${unitLabel(prod.unit)} in storage`}
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="col-span-1 sm:w-24">
                      <Label className="text-[11px] text-muted-foreground">
                        {p && isPackUnit(p.unit) ? "Packs" : `Qty ${p ? `(${unitLabel(p.unit)})` : ""}`}
                      </Label>
                      <Input
                        type="number"
                        min={0}
                        step={p ? stepForUnit(p.unit) : "0.01"}
                        className="mt-1 h-9"
                        value={r.quantity}
                        onChange={(e) => setRow(r.key, { quantity: e.target.value })}
                      />
                    </div>
                    <div className="col-span-1 sm:w-28">
                      <Label className="text-[11px] text-muted-foreground">Shop rate</Label>
                      <Input
                        type="number"
                        min={0}
                        step="0.01"
                        className="mt-1 h-9"
                        value={r.rate}
                        onChange={(e) => setRow(r.key, { rate: e.target.value })}
                      />
                    </div>
                    <div className="col-span-1 sm:w-28 sm:text-right">
                      <Label className="text-[11px] text-muted-foreground">Value</Label>
                      <p className="mt-1 text-sm font-semibold tabular-nums">
                        ₨ {fmt((parseFloat(r.quantity) || 0) * (parseFloat(r.rate) || 0))}
                      </p>
                      {p && isPackUnit(p.unit) && (parseFloat(r.quantity) || 0) > 0 && (
                        <p className="text-[10px] text-muted-foreground">
                          {packQtyLabel(p.unit, p.packSize, parseFloat(r.quantity) || 0)}
                          {equivalentLabel(p.unit, p.packSize, parseFloat(r.quantity) || 0)
                            ? ` = ${equivalentLabel(p.unit, p.packSize, parseFloat(r.quantity) || 0)}`
                            : ""}
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => setRows((prev) => (prev.length > 1 ? prev.filter((x) => x.key !== r.key) : prev))}
                      disabled={rows.length === 1}
                      className="mb-1 grid size-9 shrink-0 place-items-center justify-self-end rounded-md border border-border text-muted-foreground hover:border-rose-200 hover:text-rose-600 disabled:opacity-30"
                      title="Remove"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
            <Button type="button" variant="outline" size="sm" className="mt-2 text-xs" onClick={() => setRows((p) => [...p, newRow()])}>
              <Plus className="mr-1 size-3.5" /> Add product
            </Button>
          </div>

          {overStock.length > 0 && (
            <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {overStock.map((o) => (
                <p key={o.name}>
                  {o.name}: only {fmtQty(o.have)} {unitLabel(o.unit)} in storage, {fmtQty(o.want)} requested.
                </p>
              ))}
            </div>
          )}

          <div>
            <Label className="text-xs">Notes (optional)</Label>
            <Input className="mt-1" placeholder="Anything worth remembering" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>

          <div className="flex items-center justify-between rounded-md bg-muted/40 px-3 py-2">
            <span className="text-xs text-muted-foreground">Total value dropped</span>
            <span className="text-lg font-bold tabular-nums">₨ {fmt(total)}</span>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={save} disabled={pending || overStock.length > 0}>
            {pending ? "Saving…" : "Record drop"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div>
      <Label className="text-xs">{label}</Label>
      <Input className="mt-1" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
