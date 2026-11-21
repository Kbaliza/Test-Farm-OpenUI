"use client";

import { useState, useMemo, useTransition } from "react";
import type { Unit } from "@/lib/units";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  Plus, Trash2, Truck, PhoneCall, RefreshCw, UserCheck, Ban, ChevronDown, Pencil,
  ChevronUp, Search, Gift, MapPin, ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { CustomerForm } from "@/components/customers/customer-form";
import {
  type SamplesPageData, type SampleRow, type SampleStatus, type SampleItemInput,
  type ProductOpt,
  createSample, updateSample, markSampleDelivered, setSampleStatus, addSampleFollowup,
  resendSample, markSampleConverted, deleteSample, markSampleNotDelivered,
} from "@/app/(dashboard)/samples/actions";
import { RECEIVE_HEADS } from "@/lib/payment-heads";

const PAYMENT_LABEL: Record<string, string> = {
  CASH: "Cash", HBL: "HBL", MEEZAN: "Meezan", JAZZCASH: "JazzCash", EASYPAISA: "Easypaisa",
};

// How the money came in, beside the name — cash goes into the rider's bag and is
// handed over at the end of the day, the rest lands in an account, and that is
// the difference worth seeing without opening the sample.
const PAYMENT_PILL: Record<string, string> = {
  CASH: "bg-amber-50 text-amber-700", HBL: "bg-sky-50 text-sky-700", MEEZAN: "bg-fuchsia-50 text-fuchsia-700",
  JAZZCASH: "bg-violet-50 text-violet-700", EASYPAISA: "bg-teal-50 text-teal-700",
};

// ── Status config ───────────────────────────────────────────────────────────────

const STATUS_META: Record<SampleStatus, { label: string; pill: string; dot: string }> = {
  ASSIGNED:  { label: "Assigned",  pill: "bg-blue-50 text-blue-700",       dot: "bg-blue-500" },
  DELIVERED: { label: "Delivered", pill: "bg-emerald-50 text-emerald-700", dot: "bg-emerald-500" },
  NOT_DELIVERED: { label: "Not delivered", pill: "bg-orange-50 text-orange-700", dot: "bg-orange-500" },
  FOLLOWUP:  { label: "Follow-up", pill: "bg-amber-50 text-amber-700",     dot: "bg-amber-500" },
  CONVERTED: { label: "Converted", pill: "bg-violet-50 text-violet-700",   dot: "bg-violet-500" },
  DECLINED:  { label: "Declined",  pill: "bg-rose-50 text-rose-700",       dot: "bg-rose-500" },
};

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", {
    timeZone: "Asia/Karachi", day: "2-digit", month: "short", year: "numeric",
  });
}
function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString("en-GB", {
    timeZone: "Asia/Karachi", day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: true,
  });
}

// ── Shared item editor (product + quantity rows) ─────────────────────────────────

function ItemsEditor({
  products, items, onChange,
}: {
  products: ProductOpt[];
  items: SampleItemInput[];
  onChange: (items: SampleItemInput[]) => void;
}) {
  const [pid, setPid] = useState("");
  const [qty, setQty] = useState("1");

  const used = new Set(items.map((i) => i.productId));
  const available = products.filter((p) => !used.has(p.id));
  const nameOf = (id: string) => products.find((p) => p.id === id)?.name ?? "Item";
  const unitOf = (id: string) => {
    const u = products.find((p) => p.id === id)?.unit;
    return u === "LITER" ? "L" : u === "KG" ? "kg" : "pc";
  };

  function add() {
    const q = Number(qty);
    if (!pid || !(q > 0)) { toast.error("Pick a product and quantity."); return; }
    const prod = products.find((p) => p.id === pid);
    onChange([...items, { productId: pid, quantity: q, ratePerUnit: prod?.defaultRate ?? 0 }]);
    setPid(""); setQty("1");
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex-1">
          <Select value={pid} onValueChange={setPid}>
            <SelectTrigger className="h-9">
              <SelectValue placeholder="Choose a product" />
            </SelectTrigger>
            <SelectContent>
              {available.length === 0 ? (
                <div className="px-3 py-2 text-sm text-muted-foreground">All products added</div>
              ) : (
                available.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
        </div>
        <Input
          type="number"
          step="0.5"
          min={0}
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          className="h-9 w-full sm:w-24"
          placeholder="Qty"
        />
        <Button type="button" variant="outline" className="h-9" onClick={add} disabled={!pid}>
          <Plus className="size-4" /> Add
        </Button>
      </div>

      {items.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {items.map((it) => (
            <span
              key={it.productId}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-xs"
            >
              <span className="font-medium">{nameOf(it.productId)}</span>
              <span className="text-muted-foreground">{it.quantity} {unitOf(it.productId)}</span>
              <button
                type="button"
                onClick={() => onChange(items.filter((x) => x.productId !== it.productId))}
                className="text-muted-foreground hover:text-destructive"
                aria-label="Remove item"
              >
                <Trash2 className="size-3" />
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No items added yet.</p>
      )}
    </div>
  );
}

// ── Add sample dialog ────────────────────────────────────────────────────────────

const EMPTY_FORM = {
  name: "", phone: "", secondPhone: "", email: "", invoiceName: "",
  address: "", locationUrl: "", areaId: "", shiftId: "", notes: "",
};

/**
 * Add OR edit — one dialog, because two near-identical ones drift.
 *
 * `sample` null = adding. Otherwise the form is seeded from that row, and the item
 * editor is frozen once the sample has left the farm: delivery already booked rider
 * cash for those exact items and nothing re-books it, so changing them would leave
 * the cash describing a basket that no longer exists. Use Resend for that.
 */
function SampleDialog({
  data, sample, open, onOpenChange, onDone,
}: {
  data: SamplesPageData;
  sample?: SampleRow | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onDone: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [items, setItems] = useState<SampleItemInput[]>([]);
  // Seed once per opening, not on every render — the same guard ResendDialog uses,
  // so typing in the form is never clobbered by a re-render.
  const [seededFor, setSeededFor] = useState<string | null>(null);

  const editing = !!sample;
  const itemsLocked = editing && sample.status !== "ASSIGNED" && sample.status !== "DECLINED";

  const seedKey = open ? (sample?.id ?? "__new__") : null;
  if (seedKey && seedKey !== seededFor) {
    setSeededFor(seedKey);
    setForm(sample
      ? {
          name: sample.name, phone: sample.phone, secondPhone: sample.secondPhone,
          email: sample.email, invoiceName: sample.invoiceName, address: sample.address,
          locationUrl: sample.locationUrl, areaId: sample.areaId ?? "", shiftId: sample.shiftId ?? "",
          notes: sample.notes,
        }
      : { ...EMPTY_FORM });
    setItems(sample
      ? sample.items.map((i) => ({ productId: i.productId, quantity: i.quantity, ratePerUnit: i.ratePerUnit }))
      : []);
  }

  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  // Picking an area auto-selects the shift that serves it.
  function handleArea(areaId: string) {
    const shift = data.shifts.find((s) => s.areaIds.includes(areaId));
    setForm((f) => ({ ...f, areaId, shiftId: shift?.id ?? f.shiftId }));
  }

  function reset() {
    setForm({ ...EMPTY_FORM });
    setItems([]);
    setSeededFor(null);
  }

  function submit() {
    startTransition(async () => {
      const res = sample
        // Omitting `items` entirely tells the server to leave them alone — which is
        // what a locked editor means.
        ? await updateSample({ id: sample.id, ...form, ...(itemsLocked ? {} : { items }) })
        : await createSample({ ...form, items });
      if (res.ok) {
        toast.success(sample ? "Sample updated." : "Free sample added.");
        reset();
        onOpenChange(false);
        onDone();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit sample — ${sample.name}` : "Add free sample"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "Correct the prospect's details. Status, delivery and resend history are not affected."
              : "Capture the prospect's details. They are tracked here as a lead until converted — not counted as a customer yet."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <Label>Name *</Label>
              <Input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Full name" className="mt-1" />
            </div>
            <div>
              <Label>Contact number *</Label>
              <Input value={form.phone} onChange={(e) => set("phone", e.target.value)} placeholder="03XX-XXXXXXX" className="mt-1" />
            </div>
            <div>
              <Label>Second number</Label>
              <Input value={form.secondPhone} onChange={(e) => set("secondPhone", e.target.value)} placeholder="Optional" className="mt-1" />
            </div>
            <div>
              <Label>Email</Label>
              <Input type="email" value={form.email} onChange={(e) => set("email", e.target.value)} placeholder="Optional" className="mt-1" />
            </div>
            <div className="sm:col-span-2">
              <Label>Address</Label>
              <Textarea value={form.address} onChange={(e) => set("address", e.target.value)} rows={2} placeholder="Street, building, landmark…" className="mt-1" />
            </div>
            <div className="sm:col-span-2">
              <Label>Location URL (Google Maps)</Label>
              <Input value={form.locationUrl} onChange={(e) => set("locationUrl", e.target.value)} placeholder="https://maps.google.com/?q=…" className="mt-1" />
            </div>

            <div>
              <Label>Area</Label>
              <Select value={form.areaId} onValueChange={handleArea}>
                <SelectTrigger className="mt-1"><SelectValue placeholder="Choose area" /></SelectTrigger>
                <SelectContent>
                  {data.areas.length === 0 ? (
                    <div className="px-3 py-2 text-sm text-muted-foreground">Add areas first</div>
                  ) : (
                    data.areas.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)
                  )}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Shift</Label>
              <Select value={form.shiftId} onValueChange={(v) => set("shiftId", v)}>
                <SelectTrigger className="mt-1"><SelectValue placeholder="Auto from area" /></SelectTrigger>
                <SelectContent>
                  {data.shifts.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <p className="mt-1 text-xs text-muted-foreground">
                Auto-selected from the area. The sample rides this shift&rsquo;s next run, charged at the standard rate.
              </p>
            </div>
          </div>

          <div>
            <Label className="mb-1.5 block">Sample item(s) {itemsLocked ? "" : "*"}</Label>
            {itemsLocked ? (
              <div className="rounded-md border border-border bg-muted/30 p-2.5">
                <div className="flex flex-wrap gap-1">
                  {items.map((i) => {
                    const p = data.products.find((x) => x.id === i.productId);
                    return (
                      <span key={i.productId} className="rounded-md bg-background px-1.5 py-0.5 text-[11px]">
                        {p?.name ?? "Product"} · {i.quantity} {p?.unit ?? ""}
                      </span>
                    );
                  })}
                </div>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Locked — this sample has been delivered and rider cash was booked against
                  these exact items. Use <strong>Resend</strong> to send something different.
                </p>
              </div>
            ) : (
              <ItemsEditor products={data.products} items={items} onChange={setItems} />
            )}
          </div>

          <div>
            <Label>Notes</Label>
            <Textarea value={form.notes} onChange={(e) => set("notes", e.target.value)} rows={2} placeholder="Anything to remember about this prospect…" className="mt-1" />
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" onClick={submit} disabled={pending}>
            {pending ? "Saving…" : editing ? "Save changes" : "Add sample"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Resend dialog ────────────────────────────────────────────────────────────────

function ResendDialog({
  sample, products, open, onOpenChange, onDone,
}: {
  sample: SampleRow | null;
  products: ProductOpt[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onDone: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [items, setItems] = useState<SampleItemInput[]>([]);

  // Seed with the sample's current items whenever a new sample is opened.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (sample && seededFor !== sample.id) {
    setSeededFor(sample.id);
    setItems(sample.items.map((i) => ({ productId: i.productId, quantity: i.quantity })));
  }

  function submit() {
    if (!sample) return;
    startTransition(async () => {
      const res = await resendSample(sample.id, items);
      if (res.ok) {
        toast.success("Sample queued to send again.");
        onOpenChange(false);
        onDone();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Resend sample{sample ? ` — ${sample.name}` : ""}</DialogTitle>
          <DialogDescription>
            Choose the item(s) and quantity to send again. This moves them back to “Assigned”.
          </DialogDescription>
        </DialogHeader>
        <ItemsEditor products={products} items={items} onChange={setItems} />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" onClick={submit} disabled={pending}>
            {pending ? "Sending…" : "Resend"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Convert dialog (reuses the full customer form, pre-filled) ────────────────────

function ConvertDialog({
  sample, data, open, onOpenChange, onDone,
}: {
  sample: SampleRow | null;
  data: SamplesPageData;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onDone: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  if (!sample) return null;

  const initial = {
    name: sample.name,
    invoiceName: sample.invoiceName,
    phone: sample.phone,
    secondPhone: sample.secondPhone,
    email: sample.email,
    address: sample.address,
    locationUrl: sample.locationUrl,
    areaId: sample.areaId ?? "",
    shiftId: sample.shiftId ?? "",
    products: sample.items.map((it) => ({
      productId: it.productId,
      quantity: it.quantity,
      ratePerUnit: data.products.find((p) => p.id === it.productId)?.defaultRate ?? 0,
      scheduleType: "DAILY" as const,
      alternatePattern: [] as number[],
      weekdays: [] as number[],
      anchorDate: null,
    })),
  };

  function handleCreated(customerId: string) {
    startTransition(async () => {
      const res = await markSampleConverted(sample!.id, customerId);
      if (res.ok) toast.success("Converted to customer.");
      else toast.error(res.error);
      onOpenChange(false);
      onDone();
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto p-0 sm:max-w-3xl">
        <DialogHeader className="px-4 pt-4 sm:px-6">
          <DialogTitle>Convert to customer — {sample.name}</DialogTitle>
          <DialogDescription>
            Details are pre-filled from the sample. Review, complete the remaining fields, and save.
            {pending ? " Linking…" : ""}
          </DialogDescription>
        </DialogHeader>
        <CustomerForm
          products={data.products.map((p) => ({
            id: p.id, name: p.name,
            unit: p.unit as Unit,
            defaultRate: p.defaultRate,
          }))}
          areas={data.areas}
          shifts={data.shifts}
          defaultCustomerCode={data.defaultCustomerCode}
          initial={initial}
          onCreated={handleCreated}
          submitLabel="Create customer"
        />
      </DialogContent>
    </Dialog>
  );
}

// ── Sample card ──────────────────────────────────────────────────────────────────

function SampleCard({
  sample, onResend, onConvert, onEdit, onChanged,
}: {
  sample: SampleRow;
  onResend: (s: SampleRow) => void;
  onConvert: (s: SampleRow) => void;
  onEdit: (s: SampleRow) => void;
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [fu, setFu] = useState("");
  const [pending, startTransition] = useTransition();
  // Recording the outcome by hand: delivered (and how it was paid) or not.
  const [outcome, setOutcome] = useState<null | "delivered" | "not">(null);
  const [payBy, setPayBy] = useState("CASH");
  const [notReason, setNotReason] = useState("");
  const meta = STATUS_META[sample.status];

  function act(fn: () => Promise<{ ok: boolean; error?: string }>, okMsg?: string) {
    startTransition(async () => {
      const res = await fn();
      if (res.ok) { if (okMsg) toast.success(okMsg); onChanged(); }
      else toast.error(res.error ?? "Failed.");
    });
  }

  function submitFollowup() {
    if (!fu.trim()) return;
    startTransition(async () => {
      const res = await addSampleFollowup(sample.id, fu);
      if (res.ok) { setFu(""); toast.success("Follow-up added."); onChanged(); }
      else toast.error(res.error);
    });
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-stretch">
        <div className={cn("w-1 shrink-0", meta.dot)} />
        <div className="min-w-0 flex-1 p-3">
          {/* Header */}
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-semibold">{sample.name}</p>
                <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold", meta.pill)}>
                  {meta.label}
                </span>
                {sample.paymentMethod && sample.status !== "NOT_DELIVERED" ? (
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[10px] font-semibold",
                      PAYMENT_PILL[sample.paymentMethod] ?? "bg-slate-100 text-slate-600",
                    )}
                    title={`Paid by ${PAYMENT_LABEL[sample.paymentMethod] ?? sample.paymentMethod}`}
                  >
                    {PAYMENT_LABEL[sample.paymentMethod] ?? sample.paymentMethod}
                  </span>
                ) : null}
                {sample.resendCount > 0 ? (
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600">
                    Resent ×{sample.resendCount}
                  </span>
                ) : null}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                <span>{sample.phone}</span>
                {sample.areaName ? <span>· {sample.areaName}</span> : null}
                {sample.shiftName ? <span>· {sample.shiftName}</span> : null}
                {/* The address, not "on next run" — where to take it is the useful
                    fact here, and the shift is already named to the left. Free text,
                    so it is truncated or one long address wraps the whole line. */}
                {sample.address ? (
                  <span className="max-w-[22rem] truncate" title={sample.address}>· {sample.address}</span>
                ) : null}
                {sample.deliveredAt ? <span>· Delivered {fmtDate(sample.deliveredAt)}</span> : null}
                {/* When it was added. More than a nicety: a sample rides the next
                    completed run of its shift, matched on createdAt, so this is the
                    date that decides which run picks it up. The exact time is on
                    hover, since two samples added the same day can still land on
                    different runs. */}
                <span title={`Added ${fmtDateTime(sample.createdAt)}`}>
                  · Added {fmtDate(sample.createdAt)}
                </span>
              </div>
              {/* What the rider reported, and how it was paid. */}
              {sample.status === "NOT_DELIVERED" && sample.notDeliveredReason ? (
                <p className="mt-1 text-xs text-orange-700">Not delivered — {sample.notDeliveredReason}</p>
              ) : null}
              {sample.status === "ASSIGNED" && sample.riderOutcome ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  Rider reported: <span className="font-medium text-foreground">
                    {sample.riderOutcome === "NOT_DELIVERED" ? "Not delivered" : "Delivered"}
                  </span>
                  {sample.riderOutcome === "NOT_DELIVERED" && sample.notDeliveredReason ? ` (${sample.notDeliveredReason})` : ""}
                  {sample.paymentMethod ? ` · paid by ${PAYMENT_LABEL[sample.paymentMethod] ?? sample.paymentMethod}` : ""}
                </p>
              ) : null}

              {/* Items */}
              <div className="mt-1.5 flex flex-wrap gap-1">
                {sample.items.map((it) => (
                  <span key={it.productId} className="rounded-md bg-muted/50 px-1.5 py-0.5 text-[11px]">
                    {it.productName} · {it.quantity} {it.unit}
                  </span>
                ))}
              </div>
            </div>

            <button
              onClick={() => setExpanded((v) => !v)}
              className="flex size-7 shrink-0 items-center justify-center rounded border border-border bg-muted/40 text-muted-foreground hover:bg-muted"
              title="Details & follow-ups"
            >
              {expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
            </button>
          </div>

          {/* Action row */}
          <div className="mt-3 flex flex-wrap gap-1.5">
            {sample.status === "ASSIGNED" && outcome === null && (
              <>
                <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground" disabled={pending}
                  title="Set automatically when the rider completes this shift's route. Use this only when that did not happen."
                  onClick={() => setOutcome("delivered")}>
                  <Truck className="size-3.5" /> Mark delivered
                </Button>
                <Button size="sm" variant="ghost" className="h-7 text-xs text-orange-700" disabled={pending}
                  onClick={() => setOutcome("not")}>
                  <Ban className="size-3.5" /> Not delivered
                </Button>
              </>
            )}
            {sample.status === "ASSIGNED" && outcome === "delivered" && (
              <span className="flex flex-wrap items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50/50 px-2 py-1 text-xs">
                Paid by
                <select value={payBy} onChange={(e) => setPayBy(e.target.value)}
                  className="h-7 rounded border border-border bg-card px-1.5 text-xs">
                  {RECEIVE_HEADS.map((k) => <option key={k} value={k}>{PAYMENT_LABEL[k]}</option>)}
                </select>
                <Button size="sm" className="h-7 text-xs" disabled={pending}
                  onClick={() => act(() => markSampleDelivered(sample.id, payBy), "Marked delivered.")}>
                  Confirm delivered
                </Button>
                <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setOutcome(null)}>Cancel</Button>
              </span>
            )}
            {sample.status === "ASSIGNED" && outcome === "not" && (
              <span className="flex flex-wrap items-center gap-1.5 rounded-md border border-orange-200 bg-orange-50/50 px-2 py-1 text-xs">
                <input value={notReason} onChange={(e) => setNotReason(e.target.value)}
                  placeholder="Why? (not home, refused…)"
                  className="h-7 w-48 rounded border border-border bg-card px-2 text-xs" />
                <Button size="sm" className="h-7 text-xs" disabled={pending || !notReason.trim()}
                  onClick={() => act(() => markSampleNotDelivered(sample.id, notReason), "Marked not delivered.")}>
                  Confirm not delivered
                </Button>
                <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setOutcome(null)}>Cancel</Button>
              </span>
            )}
            {(sample.status === "DELIVERED" || sample.status === "FOLLOWUP") && (
              <>
                <Button size="sm" variant="outline" className="h-7 text-xs" disabled={pending}
                  onClick={() => setExpanded(true)}>
                  <PhoneCall className="size-3.5" /> Follow-up
                </Button>
                <Button size="sm" className="h-7 text-xs" disabled={pending}
                  onClick={() => onConvert(sample)}>
                  <UserCheck className="size-3.5" /> Convert
                </Button>
                <Button size="sm" variant="outline" className="h-7 text-xs text-rose-600" disabled={pending}
                  onClick={() => act(() => setSampleStatus(sample.id, "DECLINED"), "Marked declined.")}>
                  <Ban className="size-3.5" /> Declined
                </Button>
              </>
            )}
            {sample.status === "CONVERTED" && sample.convertedCustomerId && (
              // Deep-links to the converted customer instead of the bare list. It
              // used to drop convertedCustomerId on the floor and just open
              // /customers, which shows the ACTIVE tab — so a customer who was on
              // call or had been marked lost looked as though converting had never
              // created them. `?find=` picks the right tab and narrows to them.
              <Button asChild size="sm" variant="outline" className="h-7 text-xs">
                <Link href={`/customers?find=${sample.convertedCustomerId}`}>
                  <UserCheck className="size-3.5" /> View as customer
                </Link>
              </Button>
            )}
            {sample.status === "DECLINED" && (
              <Button size="sm" variant="outline" className="h-7 text-xs" disabled={pending}
                onClick={() => act(() => setSampleStatus(sample.id, "FOLLOWUP"), "Reopened.")}>
                <RefreshCw className="size-3.5" /> Reopen
              </Button>
            )}

            {sample.status !== "ASSIGNED" && (
              <Button size="sm" variant="outline" className="h-7 text-xs" disabled={pending}
                onClick={() => onResend(sample)}>
                <RefreshCw className="size-3.5" /> Resend
              </Button>
            )}
            {sample.locationUrl ? (
              <Button asChild size="sm" variant="ghost" className="h-7 text-xs">
                <a href={sample.locationUrl} target="_blank" rel="noopener noreferrer">
                  <MapPin className="size-3.5" /> Map <ExternalLink className="size-3" />
                </a>
              </Button>
            ) : null}
            {sample.status !== "CONVERTED" ? (
              <Button size="sm" variant="outline" className="ml-auto h-7 text-xs" onClick={() => onEdit(sample)}>
                <Pencil className="size-3.5" /> Edit
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" className={`h-7 text-xs text-muted-foreground hover:text-destructive ${sample.status === "CONVERTED" ? "ml-auto" : ""}`} disabled={pending}
              onClick={() => { if (confirm("Delete this sample lead?")) act(() => deleteSample(sample.id), "Deleted."); }}>
              <Trash2 className="size-3.5" />
            </Button>
          </div>

          {/* Expanded: follow-ups */}
          {expanded && (
            <div className="mt-3 space-y-3 rounded-md border border-border bg-muted/20 p-3">
              {sample.notes ? (
                <p className="text-xs text-muted-foreground"><span className="font-medium text-foreground">Notes:</span> {sample.notes}</p>
              ) : null}
              {sample.followups.length > 0 ? (
                <div>
                  <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Follow-up log</p>
                  <div className="space-y-1">
                    {sample.followups.map((f) => (
                      <div key={f.id} className="flex items-start justify-between gap-3 border-b border-border/60 pb-1 last:border-0 last:pb-0">
                        <span className="text-xs text-foreground/80">{f.body}</span>
                        <span className="shrink-0 text-[10px] text-muted-foreground">{fmtDateTime(f.createdAt)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              {sample.status !== "CONVERTED" && (
                <div className="flex gap-2">
                  <Textarea
                    rows={1}
                    className="h-8 flex-1 resize-none py-1.5 text-xs"
                    placeholder="Log a call / review note…"
                    value={fu}
                    onChange={(e) => setFu(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitFollowup(); } }}
                  />
                  <Button size="sm" className="h-8 shrink-0" onClick={submitFollowup} disabled={pending}>Add</Button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main client ──────────────────────────────────────────────────────────────────

export function SamplesClient({ data }: { data: SamplesPageData }) {
  const router = useRouter();
  const [addOpen, setAddOpen] = useState(false);
  const [resendFor, setResendFor] = useState<SampleRow | null>(null);
  const [editFor, setEditFor] = useState<SampleRow | null>(null);
  const [convertFor, setConvertFor] = useState<SampleRow | null>(null);
  const [filter, setFilter] = useState<"" | SampleStatus>("");
  const [query, setQuery] = useState("");

  const refresh = () => router.refresh();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return data.samples.filter((s) => {
      if (filter && s.status !== filter) return false;
      if (q && !s.name.toLowerCase().includes(q) && !s.phone.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [data.samples, filter, query]);

  const p = data.pipeline;
  const CHIPS: { key: "" | SampleStatus; label: string; value: number; dot: string }[] = [
    { key: "",          label: "Total",     value: p.total,     dot: "bg-foreground" },
    { key: "ASSIGNED",  label: "Assigned",  value: p.assigned,  dot: STATUS_META.ASSIGNED.dot },
    { key: "DELIVERED", label: "Delivered", value: p.delivered, dot: STATUS_META.DELIVERED.dot },
    { key: "NOT_DELIVERED", label: "Not delivered", value: p.notDelivered, dot: STATUS_META.NOT_DELIVERED.dot },
    { key: "FOLLOWUP",  label: "Follow-up", value: p.followup,  dot: STATUS_META.FOLLOWUP.dot },
    { key: "CONVERTED", label: "Converted", value: p.converted, dot: STATUS_META.CONVERTED.dot },
    { key: "DECLINED",  label: "Declined",  value: p.declined,  dot: STATUS_META.DECLINED.dot },
  ];

  return (
    <div className="space-y-4 p-4 sm:p-6">
      {/* Pipeline chips (clickable filters) */}
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        {CHIPS.map((c) => (
          <button
            key={c.key || "all"}
            onClick={() => setFilter(c.key)}
            className={cn(
              "rounded-lg border p-3 text-left transition-colors",
              filter === c.key ? "border-foreground bg-muted/40" : "border-border hover:bg-muted/30"
            )}
          >
            <div className="flex items-center gap-1.5">
              <span className={cn("size-1.5 rounded-full", c.dot)} />
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{c.label}</span>
            </div>
            <p className="mt-1 text-xl font-bold tabular-nums">{c.value}</p>
          </button>
        ))}
      </div>

      {/* Toolbar */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or phone…"
            className="w-full pl-8 sm:max-w-xs"
          />
        </div>
        <Button onClick={() => setAddOpen(true)}>
          <Plus className="size-4" /> Add free sample
        </Button>
      </div>

      {/* List */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed py-12 text-muted-foreground">
          <Gift className="size-7 opacity-40" />
          <p className="text-sm">
            {data.samples.length === 0 ? "No free samples yet. Add your first one." : "No samples match your filters."}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((s) => (
            <SampleCard
              key={s.id}
              sample={s}
              onResend={setResendFor}
              onConvert={setConvertFor}
              onEdit={setEditFor}
              onChanged={refresh}
            />
          ))}
        </div>
      )}

      {/* Dialogs */}
      <SampleDialog data={data} open={addOpen} onOpenChange={setAddOpen} onDone={refresh} />
      <SampleDialog
        data={data}
        sample={editFor}
        open={editFor !== null}
        onOpenChange={(v) => { if (!v) setEditFor(null); }}
        onDone={refresh}
      />
      <ResendDialog
        sample={resendFor}
        products={data.products}
        open={resendFor !== null}
        onOpenChange={(v) => { if (!v) setResendFor(null); }}
        onDone={refresh}
      />
      <ConvertDialog
        sample={convertFor}
        data={data}
        open={convertFor !== null}
        onOpenChange={(v) => { if (!v) setConvertFor(null); }}
        onDone={refresh}
      />
    </div>
  );
}
