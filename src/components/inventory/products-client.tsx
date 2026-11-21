"use client";

import { useState, useTransition } from "react";
import type { Unit } from "@/lib/units";
import { unitLabel, unitOptionLabel, isPackUnit, packLabel } from "@/lib/units";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Pencil, Trash2, RotateCcw, Package } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  addProduct,
  updateProduct,
  deleteProduct,
  restoreProduct,
  type ProductRow,
} from "@/app/(dashboard)/inventory/products/actions";


// Millilitre and gram are pack units: a 250 ml bottle, a 500 g sachet. They are
// only offered for retail products, so no litre figure on the farm side can ever
// be handed a pack count.
const STOCK_UNITS: Unit[] = ["LITER", "KG", "PIECE"];
const RETAIL_UNITS: Unit[] = ["LITER", "KG", "PIECE", "MILLILITER", "GRAM"];

// ── Product Dialog — the same screen for adding and for editing ───────────────
//
// Editing used to be a rate-only box in the table, so a product created with the
// wrong name or unit could not be corrected at all. It is one component rather
// than two so the two forms cannot drift apart, and so every edit goes through
// the same server validation an add does.

function ProductDialog({
  open,
  onClose,
  product,
}: {
  open: boolean;
  onClose: () => void;
  /** Null to add a new product; a row to edit that one. */
  product?: ProductRow | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Mounted only while open (see the call sites), so these initialisers run
  // afresh on every open — a cancelled edit can never leave its values behind for
  // the next one.
  const [name, setName] = useState(product?.name ?? "");
  const [unit, setUnit] = useState<Unit>(product?.unit ?? "LITER");
  const [rate, setRate] = useState(product ? String(product.defaultRate) : "");
  const [retailOnly, setRetailOnly] = useState(product?.retailOnly ?? false);
  const [packSize, setPackSize] = useState(
    product?.packSize != null ? String(product.packSize) : ""
  );
  const editing = !!product;

  function handleSubmit() {
    const payload = {
      name,
      unit,
      defaultRate: parseFloat(rate) || 0,
      retailOnly,
      packSize: isPackUnit(unit) ? parseFloat(packSize) || null : null,
    };
    startTransition(async () => {
      const res = product
        ? await updateProduct(product.id, payload)
        : await addProduct(payload);
      if (res.ok) {
        toast.success(product ? `"${name}" saved.` : `"${name}" added.`);
        router.refresh();
        onClose();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit Product" : "Add Product"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-1">
          <div>
            <Label>Name *</Label>
            <Input
              className="mt-1"
              placeholder="e.g. Buffalo Milk"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            />
          </div>
          <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border p-2.5">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={retailOnly}
              onChange={(e) => {
                const on = e.target.checked;
                setRetailOnly(on);
                // Leaving a pack unit selected after unticking would be an invalid
                // pair the server would refuse, so reset it here.
                if (!on && isPackUnit(unit)) {
                  setUnit("LITER");
                  setPackSize("");
                }
              }}
            />
            <span>
              <span className="text-sm font-medium">Retail only</span>
              <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                Sold at marts, over the counter and on a round, but outside the milk
                pipeline — so it stays off production, packaging and reconciliation. Its
                stock is counted in on the Retail Inventory page.
                {editing
                  ? " This can only be changed while nothing has moved as stock yet."
                  : ""}
              </span>
            </span>
          </label>

          <div>
            <Label>Unit *</Label>
            <Select value={unit} onValueChange={(v) => setUnit(v as Unit)}>
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(retailOnly ? RETAIL_UNITS : STOCK_UNITS).map((u) => (
                  <SelectItem key={u} value={u}>
                    {unitOptionLabel(u)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {isPackUnit(unit) && (
            <div>
              <Label>Pack size *</Label>
              <div className="mt-1 flex items-center gap-2">
                <Input
                  type="number"
                  min="0"
                  step="1"
                  placeholder="250"
                  value={packSize}
                  onChange={(e) => setPackSize(e.target.value)}
                />
                <span className="text-sm text-muted-foreground">{unitLabel(unit)}</span>
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                One pack is this many {unitLabel(unit)}. You enter the number of packs when
                selling, and the price below is the price of one pack.
              </p>
            </div>
          )}
          <div>
            <Label>{isPackUnit(unit) ? "Price per pack" : "Rate per unit"}</Label>
            <Input
              className="mt-1"
              type="number"
              min="0"
              step="0.01"
              placeholder="0.00"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={pending || !name.trim()}>
            {pending ? "Saving…" : editing ? "Save changes" : "Add Product"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Delete Confirm Dialog ─────────────────────────────────────────────────────

function DeleteConfirmDialog({
  productName,
  open,
  onCancel,
  onConfirm,
  pending,
}: {
  productName: string;
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  pending: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onCancel()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Remove product?</DialogTitle>
          <DialogDescription>
            <span className="font-semibold text-foreground">&ldquo;{productName}&rdquo;</span> will be
            deactivated and hidden from all forms. Existing records will not be affected.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={pending}
          >
            {pending ? "Removing…" : "Remove"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Product Row ───────────────────────────────────────────────────────────────

function ProductTableRow({ product }: { product: ProductRow }) {
  const router = useRouter();
  const [editOpen, setEditOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function handleDelete() {
    setConfirmOpen(false);
    startTransition(async () => {
      const res = await deleteProduct(product.id);
      if (res.ok) {
        toast.success(`"${product.name}" deactivated.`);
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  function handleRestore() {
    startTransition(async () => {
      const res = await restoreProduct(product.id);
      if (res.ok) {
        toast.success(`"${product.name}" restored.`);
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <TableRow className={!product.active ? "opacity-50" : undefined}>
      <TableCell className="font-medium">
        <div className="flex items-center gap-2">
          {product.name}
          {!product.active && (
            <Badge variant="outline" className="text-[10px] text-muted-foreground">
              inactive
            </Badge>
          )}
          {product.retailOnly && (
            <Badge
              variant="outline"
              className="border-sky-200 bg-sky-50 text-[10px] text-sky-700"
              title="Sold at retail, not part of the milk pipeline"
            >
              retail only
            </Badge>
          )}
        </div>
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="secondary" className="text-xs font-mono">
            {unitLabel(product.unit)}
          </Badge>
          {product.packSize != null && (
            <span className="text-[11px] text-muted-foreground">{packLabel(product.unit, product.packSize)} pack</span>
          )}
        </div>
      </TableCell>
      <TableCell>
        <button
          onClick={() => product.active && setEditOpen(true)}
          className={`group flex items-center gap-1.5 text-sm ${product.active ? "cursor-pointer hover:text-primary" : "cursor-default"}`}
        >
          <span className="font-medium">{product.defaultRate}</span>
          {product.active && (
            <Pencil className="size-3 opacity-0 transition-opacity group-hover:opacity-60" />
          )}
        </button>
      </TableCell>
      <TableCell className="text-right">
        {product.active ? (
          <div className="flex items-center justify-end gap-1">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-muted-foreground hover:text-primary"
              onClick={() => setEditOpen(true)}
              disabled={pending}
            >
              <Pencil className="size-3.5" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-rose-500 hover:bg-rose-50 hover:text-rose-600"
              onClick={() => setConfirmOpen(true)}
              disabled={pending}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-emerald-600 hover:bg-emerald-50"
            onClick={handleRestore}
            disabled={pending}
          >
            <RotateCcw className="size-3.5 mr-1" />
            Restore
          </Button>
        )}
      </TableCell>
      {editOpen && (
        <ProductDialog open onClose={() => setEditOpen(false)} product={product} />
      )}
      <DeleteConfirmDialog
        productName={product.name}
        open={confirmOpen}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={handleDelete}
        pending={pending}
      />
    </TableRow>
  );
}

// ── Main client ───────────────────────────────────────────────────────────────

export function ProductsClient({
  initialProducts,
}: {
  initialProducts: ProductRow[];
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [showInactive, setShowInactive] = useState(false);

  const active = initialProducts.filter((p) => p.active);
  const inactive = initialProducts.filter((p) => !p.active);
  const displayed = showInactive ? initialProducts : active;

  return (
    <div className="space-y-5 p-4 sm:p-6">
      {/* Stats + action bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">
            <span className="font-semibold text-foreground">{active.length}</span> active
            {inactive.length > 0 && (
              <>
                {" · "}
                <button
                  onClick={() => setShowInactive((v) => !v)}
                  className="text-muted-foreground underline-offset-2 hover:underline"
                >
                  {showInactive ? "hide" : `show ${inactive.length} inactive`}
                </button>
              </>
            )}
          </span>
        </div>
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus className="mr-1.5 size-4" /> Add Product
        </Button>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-border">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40">
              <TableHead className="w-[40%]">Product</TableHead>
              <TableHead>Unit</TableHead>
              <TableHead>Rate / unit</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {displayed.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="h-32 text-center">
                  <div className="flex flex-col items-center gap-2 text-muted-foreground">
                    <Package className="size-6 opacity-40" />
                    <p className="text-sm">No products yet.</p>
                    <button
                      onClick={() => setAddOpen(true)}
                      className="text-xs text-primary hover:underline"
                    >
                      Add the first product →
                    </button>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              displayed.map((p) => <ProductTableRow key={p.id} product={p} />)
            )}
          </TableBody>
        </Table>
      </div>

      {addOpen && <ProductDialog open onClose={() => setAddOpen(false)} product={null} />}
    </div>
  );
}
