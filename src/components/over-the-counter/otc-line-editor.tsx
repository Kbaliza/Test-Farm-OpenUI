"use client";

import { Input } from "@/components/ui/input";
import type { Unit } from "@/lib/units";
import { unitLabel } from "@/lib/units";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { X, Plus } from "lucide-react";

export type OtcLineRow = {
  key: string;
  productId: string;
  unit: string;
  rate: number;
  quantity: number;
};

export type OtcProductOption = {
  productId: string;
  productName: string;
  unit: Unit;
  defaultRate: number;
  onHand?: number; // current in-storage qty — present on the sale side (shown + enforced), absent on purchase
};


export function fmtMoney(n: number) {
  return Math.round(n).toLocaleString("en-PK");
}

export function emptyLine(): OtcLineRow {
  return { key: Math.random().toString(36).slice(2), productId: "", unit: "", rate: 0, quantity: 0 };
}

export function OtcLineEditor({
  products,
  lines,
  onChange,
}: {
  products: OtcProductOption[];
  lines: OtcLineRow[];
  onChange: (lines: OtcLineRow[]) => void;
}) {
  function addRow() {
    onChange([...lines, emptyLine()]);
  }
  function updateRow(key: string, patch: Partial<OtcLineRow>) {
    onChange(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }
  function removeRow(key: string) {
    onChange(lines.filter((l) => l.key !== key));
  }
  function handleProductChange(key: string, productId: string) {
    const p = products.find((x) => x.productId === productId);
    // Seed the list rate but leave it editable — counter rates get negotiated.
    updateRow(key, { productId, unit: p ? unitLabel(p.unit) : "", rate: p?.defaultRate || 0 });
  }

  const grandTotal = lines.reduce((s, l) => s + l.rate * l.quantity, 0);

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <div className="flex items-center justify-between border-b border-border bg-muted/40 px-3 py-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Stock Information
        </p>
        <Button type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={addRow}>
          <Plus className="mr-1 size-3.5" /> Add more items
        </Button>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Select Product</TableHead>
            <TableHead className="w-20">Unit</TableHead>
            <TableHead className="w-28 text-right">Rate</TableHead>
            <TableHead className="w-24 text-right">Qty</TableHead>
            <TableHead className="w-32 text-right">Total</TableHead>
            <TableHead className="w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {lines.map((line) => {
            const selected = products.find((p) => p.productId === line.productId);
            const hasStockInfo = selected?.onHand !== undefined;
            const onHand = selected?.onHand ?? 0;
            const over = hasStockInfo && line.quantity > onHand + 1e-6;
            return (
            <TableRow key={line.key}>
              <TableCell>
                <Select value={line.productId} onValueChange={(v) => handleProductChange(line.key, v)}>
                  <SelectTrigger className="h-8 text-xs w-full">
                    <SelectValue placeholder="Select product…" />
                  </SelectTrigger>
                  <SelectContent>
                    {products.map((p) => (
                      <SelectItem key={p.productId} value={p.productId}>
                        <span className="flex w-full items-center justify-between gap-3">
                          <span>{p.productName}</span>
                          {p.onHand !== undefined ? (
                            <span className="font-mono text-[10px] text-muted-foreground">
                              {p.onHand} {unitLabel(p.unit)}
                            </span>
                          ) : null}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {hasStockInfo && line.productId ? (
                  <p className={`mt-1 text-[10px] ${over ? "font-semibold text-rose-600" : "text-muted-foreground"}`}>
                    {over ? "Over stock — " : "In storage: "}
                    {onHand} {selected ? unitLabel(selected.unit) : ""} available
                  </p>
                ) : null}
              </TableCell>
              <TableCell>
                <Input value={line.unit} readOnly placeholder="—" className="h-8 text-xs bg-muted/40" />
              </TableCell>
              <TableCell>
                <Input
                  type="number"
                  inputMode="decimal"
                  value={line.rate || ""}
                  onChange={(e) => updateRow(line.key, { rate: parseFloat(e.target.value) || 0 })}
                  className="h-8 text-xs text-right font-mono"
                  placeholder="0"
                />
              </TableCell>
              <TableCell>
                <Input
                  type="number"
                  inputMode="decimal"
                  value={line.quantity || ""}
                  onChange={(e) => updateRow(line.key, { quantity: parseFloat(e.target.value) || 0 })}
                  className="h-8 text-xs text-right font-mono"
                  placeholder="0"
                />
              </TableCell>
              <TableCell className="text-right font-mono text-sm font-semibold">
                {fmtMoney(line.rate * line.quantity)}
              </TableCell>
              <TableCell>
                <button
                  type="button"
                  onClick={() => removeRow(line.key)}
                  disabled={lines.length === 1}
                  className="flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-rose-50 hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-30"
                  title="Remove item"
                >
                  <X className="size-3.5" />
                </button>
              </TableCell>
            </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <div className="flex items-center justify-end gap-3 border-t border-border bg-muted/20 px-3 py-2.5">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Total</span>
        <span className="font-mono text-lg font-bold">Rs {fmtMoney(grandTotal)}</span>
      </div>
    </div>
  );
}
