"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Search, Pencil, Package, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { unitLabel, perUnitLabel, packLabel, qtyLabel, isPackUnit } from "@/lib/units";
import { stepForUnit } from "@/lib/quantity";
import {
  addRetailStock, setProductCost, voidRetailStockEntry,
  type RetailStockData, type RetailStockRow,
} from "@/app/(dashboard)/retail/actions";
import { fmt, fmtQty } from "./retail-client";

export function RetailStockClient({
  stock,
  canEditCost,
  canVoid,
}: {
  stock: RetailStockData;
  /** Cost decides what every loss is worth, so only full-access roles may set it. */
  canEditCost: boolean;
  canVoid: boolean;
}) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [costFor, setCostFor] = useState<RetailStockRow | null>(null);
  const [voidId, setVoidId] = useState<string | null>(null);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? stock.rows.filter((r) => r.productName.toLowerCase().includes(q)) : stock.rows;
  }, [stock.rows, search]);

  const refresh = () => router.refresh();

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="flex flex-wrap items-center gap-2 p-3">
          <div className="relative min-w-[180px] flex-1">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="h-9 pl-8"
              placeholder="Search retail products"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="text-xs text-muted-foreground">
            Stock value{" "}
            <span className="font-semibold tabular-nums text-foreground">₨ {fmt(stock.totalStockValue)}</span>
          </div>
          {stock.missingCost > 0 && (
            <span
              className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-800"
              title="Without a cost, every loss on these reads as a dash"
            >
              {stock.missingCost} with no cost set
            </span>
          )}
          <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
            <Plus className="mr-1.5 size-3.5" /> Add stock
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead>Product</TableHead>
                  <TableHead className="text-right">In stock</TableHead>
                  <TableHead className="hidden text-right sm:table-cell">At shops</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead className="hidden text-right sm:table-cell">Price</TableHead>
                  <TableHead className="text-right">Stock value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                      <Package className="mx-auto mb-2 size-8 opacity-20" />
                      No retail products yet. Add one in Inventory → Products, ticking
                      &ldquo;Retail only&rdquo;.
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((r) => (
                    <TableRow key={r.productId}>
                      <TableCell className="font-medium">
                        {r.productName}
                        {r.packSize != null && (
                          <span className="ml-1.5 text-[11px] text-muted-foreground">
                            {packLabel(r.unit, r.packSize)} pack
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums font-semibold">
                        {qtyLabel(r.unit, r.onHand)}
                      </TableCell>
                      <TableCell className="hidden text-right tabular-nums text-muted-foreground sm:table-cell">
                        {r.atShops > 0 ? fmtQty(r.atShops) : "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {!canEditCost ? (
                          <span className={r.costPrice == null ? "text-muted-foreground" : ""}>
                            {r.costPrice == null ? "—" : `₨ ${fmt(r.costPrice)}`}
                          </span>
                        ) : r.costPrice == null ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 border-amber-300 px-2 text-[11px] text-amber-800 hover:bg-amber-50"
                            onClick={() => setCostFor(r)}
                          >
                            <Pencil className="mr-1 size-3" /> Set cost
                          </Button>
                        ) : (
                          <button
                            onClick={() => setCostFor(r)}
                            className="inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-muted hover:text-primary"
                            title="Edit the cost"
                          >
                            ₨ {fmt(r.costPrice)}
                            <Pencil className="size-3 opacity-50" />
                          </button>
                        )}
                      </TableCell>
                      <TableCell className="hidden text-right tabular-nums text-muted-foreground sm:table-cell">
                        ₨ {fmt(r.defaultRate)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {r.stockValue == null ? "—" : `₨ ${fmt(r.stockValue)}`}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <p className="px-1 text-[11px] leading-relaxed text-muted-foreground">
        <b>Cost</b> is what one unit costs you to make — tap it to set or change it. It
        is only ever used to value what you lose, never to price a sale.
      </p>
      <p className="px-1 text-[11px] leading-relaxed text-muted-foreground">
        <b>In stock</b> is what is at the farm, ready to sell or drop. <b>At shops</b> is
        what a shop still has unsold — it left storage the day it was dropped, so the two
        do not add up to one figure; together they are everything you are holding.
      </p>

      {stock.entries.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <div className="border-b border-border px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Recently counted in
            </div>
            <div className="max-h-64 overflow-y-auto">
              {stock.entries.map((e) => (
                <div
                  key={e.id}
                  className={`flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2 text-sm last:border-0 ${e.voided ? "opacity-50" : ""}`}
                >
                  <span className="w-20 shrink-0 text-xs text-muted-foreground">{e.date}</span>
                  <span className="font-medium">{e.productName}</span>
                  <span className="tabular-nums">
                    {e.voided ? <s>+{fmtQty(e.quantity)}</s> : `+${fmtQty(e.quantity)}`} {unitLabel(e.unit)}
                  </span>
                  {e.note && <span className="text-xs text-muted-foreground">{e.note}</span>}
                  {e.enteredBy && <span className="text-xs text-muted-foreground">· {e.enteredBy}</span>}
                  {e.voided && <span className="text-xs font-medium text-rose-600">removed</span>}
                  {!e.voided && canVoid && (
                    <button
                      onClick={() => setVoidId(e.id)}
                      className="ml-auto rounded p-1 text-muted-foreground hover:bg-rose-50 hover:text-rose-600"
                      title="Remove this entry"
                    >
                      <X className="size-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {addOpen && (
        <AddStockDialog
          rows={stock.rows}
          today={stock.today}
          onClose={() => setAddOpen(false)}
          onSaved={refresh}
        />
      )}
      {costFor && (
        <CostDialog row={costFor} onClose={() => setCostFor(null)} onSaved={refresh} />
      )}
      {voidId && (
        <VoidEntryDialog id={voidId} onClose={() => setVoidId(null)} onSaved={refresh} />
      )}
    </div>
  );
}

function AddStockDialog({
  rows, today, onClose, onSaved,
}: {
  rows: RetailStockRow[];
  today: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [pending, start] = useTransition();
  const [productId, setProductId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [date, setDate] = useState(today);
  const [note, setNote] = useState("");

  const product = rows.find((r) => r.productId === productId);
  const qty = parseFloat(quantity) || 0;

  function save() {
    if (!product) { toast.error("Choose a product."); return; }
    if (qty <= 0) { toast.error("Enter how many to add."); return; }
    start(async () => {
      const res = await addRetailStock({ productId, quantity: qty, date, note });
      if (res.ok) {
        toast.success(`Added ${fmtQty(qty)} ${unitLabel(product.unit)} of ${product.productName}.`);
        onClose();
        onSaved();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add stock</DialogTitle>
          <DialogDescription className="text-xs">
            Quantity only — this does not create an expense or a vendor bill.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label className="text-xs">Product *</Label>
            <Select value={productId} onValueChange={setProductId}>
              <SelectTrigger className="mt-1">
                <SelectValue placeholder="Choose a retail product" />
              </SelectTrigger>
              <SelectContent>
                {rows.map((r) => (
                  <SelectItem key={r.productId} value={r.productId}>
                    {r.productName}
                    <span className="ml-1.5 text-xs text-muted-foreground">
                      {qtyLabel(r.unit, r.onHand)} in stock
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-xs">
                {product && isPackUnit(product.unit) ? "Packs *" : "Quantity *"}
              </Label>
              <Input
                type="number"
                min={0}
                step={product ? stepForUnit(product.unit) : "1"}
                className="mt-1"
                placeholder="0"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
              />
            </div>
            <div>
              <Label className="text-xs">Date</Label>
              <Input
                type="date"
                className="mt-1"
                value={date}
                max={today}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
          </div>

          {product && qty > 0 && (
            <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
              {product.productName} goes from{" "}
              <b className="tabular-nums">{qtyLabel(product.unit, product.onHand)}</b> to{" "}
              <b className="tabular-nums">{qtyLabel(product.unit, product.onHand + qty)}</b>.
            </p>
          )}

          <div>
            <Label className="text-xs">Note (optional)</Label>
            <Input
              className="mt-1"
              placeholder="e.g. delivery from the supplier"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button onClick={save} disabled={pending || !productId || qty <= 0}>
            {pending ? "Adding…" : "Add stock"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CostDialog({
  row, onClose, onSaved,
}: {
  row: RetailStockRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [pending, start] = useTransition();
  const [cost, setCost] = useState(row.costPrice == null ? "" : String(row.costPrice));

  function save() {
    const val = cost.trim() === "" ? null : parseFloat(cost);
    if (val != null && (!Number.isFinite(val) || val < 0)) {
      toast.error("Enter a valid cost."); return;
    }
    start(async () => {
      const res = await setProductCost(row.productId, val);
      if (res.ok) { toast.success("Cost saved."); onClose(); onSaved(); }
      else toast.error(res.error);
    });
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>What {row.productName} costs to make</DialogTitle>
          <DialogDescription className="text-xs">
            Used to value what we lose, never to price a sale.
          </DialogDescription>
        </DialogHeader>

        <div>
          <Label className="text-xs">Cost per {perUnitLabel(row.unit)}</Label>
          <div className="mt-1 flex items-center gap-2">
            <span className="text-sm text-muted-foreground">₨</span>
            <Input
              type="number"
              min={0}
              step="0.01"
              placeholder="60"
              value={cost}
              onChange={(e) => setCost(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && save()}
              autoFocus
            />
          </div>
          {row.packSize != null && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              Per {packLabel(row.unit, row.packSize)} pack — the same thing the price of
              ₨ {fmt(row.defaultRate)} is per, not per {unitLabel(row.unit)}.
            </p>
          )}
          <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
            Changing this changes what the stock on hand is worth. Losses already
            reported keep the cost recorded at the time.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button onClick={save} disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function VoidEntryDialog({
  id, onClose, onSaved,
}: {
  id: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [pending, start] = useTransition();
  const [reason, setReason] = useState("");

  function save() {
    if (!reason.trim()) { toast.error("Say why this entry is being removed."); return; }
    start(async () => {
      const res = await voidRetailStockEntry(id, reason);
      if (res.ok) { toast.success("Entry removed."); onClose(); onSaved(); }
      else toast.error(res.error);
    });
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Remove this entry?</DialogTitle>
          <DialogDescription className="text-xs">
            The stock it added comes back out. If some of it has already been sold or
            dropped, this will be refused.
          </DialogDescription>
        </DialogHeader>
        <div>
          <Label className="text-xs">Reason *</Label>
          <Input
            className="mt-1"
            placeholder="e.g. entered twice"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save()}
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button variant="destructive" onClick={save} disabled={pending || !reason.trim()}>
            {pending ? "Removing…" : "Remove"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
