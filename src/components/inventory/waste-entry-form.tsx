"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2, AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  createPackagingWasteEntry,
  createWasteEntry,
  type WasteEntryProduct,
} from "@/app/(dashboard)/inventory/waste-entry/actions";

const UNIT_LABEL: Record<string, string> = { LITER: "L", KG: "kg", PIECE: "pc" };

function fmt(n: number) {
  return n % 1 === 0 ? n.toFixed(0) : n.toFixed(1);
}

// Current local wall-clock as "YYYY-MM-DDTHH:MM" for a datetime-local default.
function nowLocalInput() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Stored value stays "Yoghurt"; only the label follows the catalogue spelling.
const stageLabel = (s: string) => (s === "Yoghurt" ? "Yogurt" : s);

export function WasteEntryForm({
  loggedByName,
  stages,
  reasons,
  products,
  packaging = false,
}: {
  loggedByName: string;
  stages: readonly string[];
  reasons: string[];
  products: WasteEntryProduct[];
  /** On the Packaging page: stage fixed to Packaging, and no page padding. */
  packaging?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const [productId, setProductId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [stage, setStage] = useState<string>(stages[0] ?? "Production");
  const [reason, setReason] = useState("");
  const [customReason, setCustomReason] = useState("");
  const [date, setDate] = useState(nowLocalInput);

  const product = useMemo(() => products.find((p) => p.id === productId) ?? null, [products, productId]);
  const unit = product ? UNIT_LABEL[product.unit] ?? "" : "";
  const qtyNum = Number(quantity);
  const exceeds = !!product && Number.isFinite(qtyNum) && qtyNum > product.inStorage + 1e-6;
  const effectiveReason = reason === "Other" ? customReason.trim() : reason;

  const valid =
    !!product &&
    Number.isFinite(qtyNum) &&
    qtyNum > 0 &&
    !exceeds &&
    !!stage &&
    !!effectiveReason;

  function submit() {
    if (!valid || !product) return;
    start(async () => {
      const save = packaging ? createPackagingWasteEntry : createWasteEntry;
      const res = await save({
        productId: product.id,
        quantity: qtyNum,
        stage,
        reason: effectiveReason,
        date,
      });
      if (res.ok) {
        toast.success(`Logged ${fmt(qtyNum)} ${unit} wastage for ${product.name}.`);
        setQuantity("");
        setReason("");
        setCustomReason("");
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <div className={packaging ? "" : "p-4 sm:p-6"}>
      <div className={packaging ? "space-y-4" : "mx-auto max-w-xl space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6"}>
        {products.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No active products to log wastage against.</p>
        ) : (
          <>
            {/* Product */}
            <div>
              <Label className="text-xs">Product</Label>
              <Select value={productId} onValueChange={setProductId}>
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="Select a product" />
                </SelectTrigger>
                <SelectContent>
                  {products.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}{" "}
                      <span className="text-muted-foreground">· in storage: {fmt(p.inStorage)} {UNIT_LABEL[p.unit] ?? ""}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {product && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  In storage: <span className="font-medium text-foreground">{fmt(product.inStorage)} {unit}</span>
                </p>
              )}
            </div>

            {/* Waste quantity */}
            <div>
              <Label className="text-xs">Waste quantity{unit ? ` (${unit})` : ""}</Label>
              <Input
                type="number"
                min="0"
                step="any"
                inputMode="decimal"
                className="mt-1"
                placeholder="0"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                aria-invalid={exceeds}
              />
              {exceeds && product && (
                <p className="mt-1 flex items-center gap-1 text-[11px] text-rose-600">
                  <AlertTriangle className="size-3.5" /> Cannot exceed current stock ({fmt(product.inStorage)} {unit}).
                </p>
              )}
            </div>

            {/* Date & time */}
            <div>
              <Label className="text-xs">Date &amp; time</Label>
              <Input type="datetime-local" className="mt-1" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>

            {/* Stage */}
            <div hidden={packaging}>
              <Label className="text-xs">Stage</Label>
              <Select value={stage} onValueChange={setStage}>
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="Select a stage" />
                </SelectTrigger>
                <SelectContent>
                  {stages.map((s) => (
                    <SelectItem key={s} value={s}>{stageLabel(s)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Reason */}
            <div>
              <Label className="text-xs">Reason</Label>
              <Select value={reason} onValueChange={setReason}>
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="Select a reason" />
                </SelectTrigger>
                <SelectContent>
                  {reasons.map((r) => (
                    <SelectItem key={r} value={r}>{r}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {reason === "Other" && (
                <Input
                  className="mt-2"
                  placeholder="Type the reason"
                  value={customReason}
                  onChange={(e) => setCustomReason(e.target.value)}
                />
              )}
            </div>

            {/* Logged by (auto) */}
            <div>
              <Label className="text-xs">Logged by</Label>
              <div className="mt-1 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                {loggedByName}
              </div>
            </div>

            <Button className="w-full" onClick={submit} disabled={!valid || pending}>
              <Trash2 className="mr-1.5 size-4" />
              {pending ? "Logging…" : "Log wastage"}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
