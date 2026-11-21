"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Ban, Loader2, MessageSquareWarning, PackageCheck, Pencil, Plus, Receipt, Save, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SearchCombobox } from "@/components/ui/search-combobox";
import { PieChart, Pie, Cell, Tooltip } from "recharts";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { todayPKTString, toDateStrPKT } from "@/lib/pkt";
import { unitLabel, type Unit } from "@/lib/units";
import {
  COMPLAINT_CATEGORIES,
  COMPLAINT_RESOLUTIONS,
  DESCRIPTION_MAX,
  RESOLUTION_LABELS,
  compensationProblem,
  complaintShapeProblem,
  refundValue,
  type ComplaintResolutionValue,
} from "@/lib/complaints";
import {
  createComplaint,
  updateComplaint,
  deleteComplaint,
  getComplaintDayProducts,
  getComplaints,
  getCustomerDeliveryDays,
  type ComplaintCustomer,
  type ComplaintRow,
  type DayProduct,
  type DeliveryDay,
} from "@/app/(dashboard)/complaints/actions";

const RANGES = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "1 year" },
];

const RESOLUTION_ICON: Record<ComplaintResolutionValue, typeof Receipt> = {
  REFUND: Receipt,
  REPLACEMENT: PackageCheck,
  NONE: Ban,
};

const RESOLUTION_TONE: Record<ComplaintResolutionValue, string> = {
  REFUND: "bg-rose-50 text-rose-700 ring-rose-200",
  REPLACEMENT: "bg-sky-50 text-sky-700 ring-sky-200",
  NONE: "bg-muted text-muted-foreground ring-border",
};

const SELECT_CLASS =
  "mt-1 flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm disabled:cursor-not-allowed disabled:opacity-50";

function money(n: number) {
  return `Rs ${n.toLocaleString("en-PK", { maximumFractionDigits: 2 })}`;
}
function qty(n: number) {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000);
}
function unitOf(u: string | null) {
  return u ? unitLabel(u as Unit) : "";
}
/** "12 Sep 2026" from a stored instant, in Pakistan time. */
function dayLabel(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Karachi" });
}
/** "Sat 12 Sep" from a "YYYY-MM-DD" calendar day. */
function chipLabel(dateStr: string) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

/**
 * The complaint form - used to record one, and to correct one.
 *
 * One component for both jobs, because every rule on this screen lives in it:
 * which products that day is open to a complaint, how much of each is left after
 * rider returns and earlier complaints, the rate that was billed, and what a
 * refund will take off the bill. A separate edit form would be a second copy of
 * all that to keep in step, and the two copies would drift.
 *
 * Pass `existing` to edit that complaint. The form is mounted fresh for each one
 * (keyed on its id), so its state starts from the record and there is nothing to
 * keep re-syncing.
 */
function ComplaintForm({
  customers,
  userName,
  existing,
  onSaved,
  onCancel,
}: {
  customers: ComplaintCustomer[];
  userName: string;
  existing?: ComplaintRow | null;
  onSaved: () => void | Promise<void>;
  onCancel?: () => void;
}) {
  const editing = existing ?? null;
  const [pending, start] = useTransition();
  const today = todayPKTString();

  const [customerId, setCustomerId] = useState(editing?.customerId ?? "");
  const [deliveryDate, setDeliveryDate] = useState(editing ? toDateStrPKT(editing.deliveryDate) : "");
  const [date, setDate] = useState(editing ? toDateStrPKT(editing.date) : today);
  const [category, setCategory] = useState(editing?.category ?? "");
  const [description, setDescription] = useState(editing?.description ?? "");
  const [resolution, setResolution] = useState<ComplaintResolutionValue>(editing?.resolution ?? "REFUND");
  const [productId, setProductId] = useState(editing?.productId ?? "");
  const [quantity, setQuantity] = useState(editing?.quantity == null ? "" : String(editing.quantity));

  const [days, setDays] = useState<DeliveryDay[]>([]);
  const [products, setProducts] = useState<DayProduct[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(!!editing);
  // Each lookup gets a number; an answer that comes back after a newer lookup
  // started is dropped, so a slow reply can't overwrite the customer you picked next.
  const daysReq = useRef(0);
  const productsReq = useRef(0);

  const customer = customers.find((c) => c.id === customerId) ?? null;
  const product = products.find((p) => p.productId === productId) ?? null;
  const typedQty = quantity === "" ? NaN : parseFloat(quantity);

  const customerItems = useMemo(
    () => customers.map((c) => ({ value: c.id, label: c.name, sublabel: c.shiftName ? c.code + " · " + c.shiftName : c.code })),
    [customers]
  );

  /** `exclude` is the complaint being edited: without it the day's cap counts the
   *  very quantity on screen, and the form refuses its own figure. */
  function loadProducts(cid: string, d: string, exclude?: string | null) {
    const n = ++productsReq.current;
    setProducts([]);
    setProductId("");
    if (!cid || !d) {
      setLoadingProducts(false);
      return;
    }
    setLoadingProducts(true);
    getComplaintDayProducts(cid, d, exclude ?? undefined)
      .then((list) => {
        if (n !== productsReq.current) return;
        setProducts(list);
        // One product delivered that day is the common case - choose it.
        if (list.length === 1) setProductId(list[0].productId);
      })
      .catch(() => { if (n === productsReq.current) toast.error("Could not load that day's deliveries."); })
      .finally(() => { if (n === productsReq.current) setLoadingProducts(false); });
  }

  // An edit opens with a customer and a day already chosen, so what that day holds
  // has to be fetched without anybody picking anything. Written out rather than
  // calling loadProducts, because that clears the product first and an effect must
  // not set state on its way in — the chosen product would blink away and back.
  useEffect(() => {
    if (!editing) return;
    let alive = true;
    const dq = ++daysReq.current;
    const pq = ++productsReq.current;
    getCustomerDeliveryDays(editing.customerId)
      .then((list) => { if (alive && dq === daysReq.current) setDays(list); })
      .catch(() => {});
    getComplaintDayProducts(editing.customerId, toDateStrPKT(editing.deliveryDate), editing.id)
      .then((list) => {
        if (!alive || pq !== productsReq.current) return;
        setProducts(list);
        // Keep the product the complaint was raised against, if that day still has it.
        if (editing.productId && list.some((p) => p.productId === editing.productId)) {
          setProductId(editing.productId);
        }
      })
      .catch(() => { if (alive) toast.error("Could not load that day's deliveries."); })
      .finally(() => { if (alive) setLoadingProducts(false); });
    return () => { alive = false; };
    // Once, for the complaint this form was opened on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pickCustomer(id: string) {
    setCustomerId(id);
    setDeliveryDate("");
    setDays([]);
    loadProducts("", "");
    if (!id) return;
    const n = ++daysReq.current;
    getCustomerDeliveryDays(id)
      .then((list) => { if (n === daysReq.current) setDays(list); })
      .catch(() => {});
  }

  function pickDeliveryDate(d: string) {
    setDeliveryDate(d);
    // The complaint can't be received before the delivery it is about.
    if (d && date < d) setDate(d);
    loadProducts(customerId, d, editing?.id ?? null);
  }

  const draft = {
    customerId,
    deliveryDate,
    date,
    category,
    description,
    resolution,
    productId: resolution === "NONE" ? null : productId || null,
    quantity: resolution === "NONE" ? null : typedQty,
  };
  const problem =
    complaintShapeProblem(draft, today) ??
    (resolution !== "NONE" && product
      ? compensationProblem(resolution, typedQty, product, product.name)
      : null);
  // Only shout about the quantity once someone has typed one.
  const qtyProblem =
    resolution !== "NONE" && product && quantity !== ""
      ? compensationProblem(resolution, typedQty, product, product.name)
      : null;

  function save() {
    if (problem) {
      toast.error(problem);
      return;
    }
    start(async () => {
      const res = editing ? await updateComplaint(editing.id, draft) : await createComplaint(draft);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      const what = editing ? "Complaint updated" : "Complaint saved";
      toast.success(
        resolution === "REFUND" && product
          ? what + " — " + money(refundValue(typedQty, product.rate)) + " taken off " + (customer ? customer.name + "'s" : "the") + " bill."
          : resolution === "REPLACEMENT" && product
            ? what + " — " + qty(typedQty) + " " + unitOf(product.unit) + " " + product.name + " to be sent free."
            : what + "."
      );
      if (!editing) {
        setCategory("");
        setDescription("");
        setQuantity("");
        // What is still open on that day just changed.
        loadProducts(customerId, deliveryDate);
      }
      await onSaved();
    });
  }

  return (
    <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <Label className="text-xs">Customer</Label>
              <div className="mt-1">
                <SearchCombobox
                  items={customerItems}
                  value={customerId}
                  onChange={pickCustomer}
                  placeholder="Search customer…"
                  searchPlaceholder="Name, code or shift…"
                  emptyText="No customers found."
                />
              </div>
              {customer && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Shift: <span className="font-medium text-foreground">{customer.shiftName ?? "No shift"}</span>
                </p>
              )}
            </div>
            <div>
              <Label className="text-xs">Complaint received on</Label>
              <Input
                type="date"
                className="mt-1"
                value={date}
                min={deliveryDate || undefined}
                max={today}
                onChange={(e) => setDate(e.target.value)}
              />
              <p className="mt-1 text-[11px] text-muted-foreground">A refund comes off the bill for this date.</p>
            </div>
          </div>

          <div>
            <Label className="text-xs">Delivery date</Label>
            <Input
              type="date"
              className="mt-1 sm:max-w-[220px]"
              value={deliveryDate}
              max={today}
              disabled={!customerId}
              onChange={(e) => pickDeliveryDate(e.target.value)}
            />
            {customerId && days.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {days.slice(0, 10).map((d) => (
                  <button
                    key={d.date}
                    type="button"
                    title={d.summary}
                    onClick={() => pickDeliveryDate(d.date)}
                    className={cn(
                      "rounded-md border px-2 py-1 text-[11px] transition",
                      d.date === deliveryDate
                        ? "border-brand bg-brand text-white"
                        : "border-border bg-background hover:bg-muted"
                    )}
                  >
                    {chipLabel(d.date)}
                  </button>
                ))}
              </div>
            )}
            {customerId && days.length === 0 && (
              <p className="mt-1 text-[11px] text-muted-foreground">No deliveries to this customer in the last 60 days.</p>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[220px_1fr]">
            <div>
              <Label className="text-xs">Complaint about</Label>
              <select className={SELECT_CLASS} value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="">Choose…</option>
                {COMPLAINT_CATEGORIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
            <div>
              <Label className="text-xs">What the customer said</Label>
              <Textarea
                className="mt-1 min-h-[38px]"
                rows={2}
                maxLength={DESCRIPTION_MAX}
                placeholder="e.g. Milk was sour when opened in the morning"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
          </div>

          <div>
            <Label className="text-xs">What we give</Label>
            <div className="mt-1 grid grid-cols-3 gap-2">
              {COMPLAINT_RESOLUTIONS.map((r) => {
                const Icon = RESOLUTION_ICON[r];
                return (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setResolution(r)}
                    className={cn(
                      "flex items-center justify-center gap-1.5 rounded-md border px-2 py-2 text-xs font-medium transition",
                      resolution === r ? "border-brand bg-brand text-white" : "border-border bg-background hover:bg-muted"
                    )}
                  >
                    <Icon className="size-3.5 shrink-0" />
                    <span className="truncate">{RESOLUTION_LABELS[r]}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {resolution !== "NONE" && (
            <div className="rounded-lg border border-border bg-muted/30 p-3">
              {!customerId || !deliveryDate ? (
                <p className="text-xs text-muted-foreground">Choose the customer and the delivery date first.</p>
              ) : loadingProducts ? (
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" /> Looking up that day&apos;s delivery…
                </p>
              ) : products.length === 0 ? (
                <p className="text-xs font-medium text-rose-600">
                  Nothing was delivered to this customer on that day, so there is nothing to refund or replace.
                </p>
              ) : (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_160px]">
                  <div>
                    <Label className="text-xs">Product</Label>
                    <select className={SELECT_CLASS} value={productId} onChange={(e) => setProductId(e.target.value)}>
                      <option value="">Choose…</option>
                      {products.map((p) => (
                        <option key={p.productId} value={p.productId} disabled={p.compensable <= 0}>
                          {p.name} — {qty(p.compensable)} of {qty(p.delivered)} {unitOf(p.unit)} open
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <Label className="text-xs">Quantity{product ? ` (${unitOf(product.unit)})` : ""}</Label>
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      max={product ? product.compensable : undefined}
                      className="mt-1"
                      placeholder="0"
                      value={quantity}
                      disabled={!product}
                      onChange={(e) => setQuantity(e.target.value)}
                    />
                  </div>
                  {product && (
                    <div className="sm:col-span-2 space-y-1 text-xs">
                      <p className="text-muted-foreground">
                        Delivered {qty(product.delivered)} {unitOf(product.unit)} at {money(product.rate)}
                        {product.riderReturned > 0 && <> · rider brought back {qty(product.riderReturned)}</>}
                        {product.alreadyCompensated > 0 && <> · earlier complaints {qty(product.alreadyCompensated)}</>}
                      </p>
                      {qtyProblem ? (
                        <p className="font-medium text-rose-600">{qtyProblem}</p>
                      ) : Number.isFinite(typedQty) && typedQty > 0 ? (
                        resolution === "REFUND" ? (
                          <p className="font-semibold text-foreground">
                            {money(refundValue(typedQty, product.rate))} will be taken off the bill
                            <span className="font-normal text-muted-foreground"> ({qty(typedQty)} × {money(product.rate)}, the rate billed that day)</span>
                          </p>
                        ) : (
                          <p className="font-semibold text-foreground">
                            {qty(typedQty)} {unitOf(product.unit)} {product.name} sent free from stock
                            <span className="font-normal text-muted-foreground"> — nothing is charged</span>
                          </p>
                        )
                      ) : null}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted-foreground">
          {editing ? (
            <>Raised by <span className="font-medium text-foreground">{editing.enteredByName}</span></>
          ) : (
            <>Entered by <span className="font-medium text-foreground">{userName || "you"}</span></>
          )}
        </p>
        <div className="flex gap-2">
          {onCancel && (
            <Button variant="outline" onClick={onCancel} disabled={pending}>
              Cancel
            </Button>
          )}
          <Button onClick={save} disabled={pending || !!problem} className="sm:min-w-40">
            {pending ? <Loader2 className="size-4 animate-spin" /> : editing ? <Save className="size-4" /> : <Plus className="size-4" />}
            {editing ? "Save changes" : "Save complaint"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// One colour per slice, in the software's palette; the biggest categories come
// first in the data so they get the strongest colours.
const PIE_COLORS = ["#B23408", "#B4740A", "#1A3A9E", "#0F766E", "#1A4D2E", "#6321C7", "#8A1414", "#6B6760"];

export function ComplaintsClient({
  initialRows,
  customers,
  userName,
}: {
  initialRows: ComplaintRow[];
  customers: ComplaintCustomer[];
  userName: string;
}) {
  const [pending, start] = useTransition();

  // ── List ──────────────────────────────────────────────────────────────────
  const [rows, setRows] = useState(initialRows);
  const [rangeDays, setRangeDays] = useState(30);
  const [filter, setFilter] = useState<"ALL" | ComplaintResolutionValue>("ALL");
  const [search, setSearch] = useState("");
  const [loadingList, setLoadingList] = useState(false);
  const [toDelete, setToDelete] = useState<ComplaintRow | null>(null);
  /** The complaint open in the edit dialog. */
  const [toEdit, setToEdit] = useState<ComplaintRow | null>(null);
  const listReq = useRef(0);

  async function refreshList(d: number) {
    const n = ++listReq.current;
    setLoadingList(true);
    try {
      const res = await getComplaints(d);
      if (n === listReq.current) setRows(res.rows);
    } finally {
      if (n === listReq.current) setLoadingList(false);
    }
  }

  function pickRange(d: number) {
    setRangeDays(d);
    refreshList(d);
  }

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter !== "ALL" && r.resolution !== filter) return false;
      if (!q) return true;
      return (
        r.customerName.toLowerCase().includes(q) ||
        r.customerCode.toLowerCase().includes(q) ||
        r.category.toLowerCase().includes(q) ||
        r.description.toLowerCase().includes(q) ||
        r.enteredByName.toLowerCase().includes(q)
      );
    });
  }, [rows, filter, search]);

  // What the complaints are about, for the chart: every category with at least
  // one complaint in the rows on screen, biggest first.
  const byCategory = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of visible) m.set(r.category, (m.get(r.category) ?? 0) + 1);
    return [...m].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  }, [visible]);

  const refundTotal = visible.reduce((s, r) => s + (r.resolution === "REFUND" ? r.amount : 0), 0);
  const replacements = visible.filter((r) => r.resolution === "REPLACEMENT").length;

  function confirmDelete() {
    const row = toDelete;
    if (!row) return;
    start(async () => {
      const res = await deleteComplaint(row.id);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Complaint removed.");
      setToDelete(null);
      await refreshList(rangeDays);
    });
  }

  return (
    <div className="space-y-6">
      {/* ── Record a complaint ─────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <MessageSquareWarning className="size-4 text-muted-foreground" /> Record a complaint
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ComplaintForm
            customers={customers}
            userName={userName}
            onSaved={() => refreshList(rangeDays)}
          />
        </CardContent>
      </Card>

      {/* ── What they are about ───────────────────────────────────────────── */}
      {byCategory.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">What the complaints are about</CardTitle>
            <p className="text-xs text-muted-foreground">{visible.length} complaint{visible.length === 1 ? "" : "s"} in the last {rangeDays} days, by category</p>
          </CardHeader>
          <CardContent>
            <div className="grid items-center gap-4 sm:grid-cols-[220px_1fr]">
              <div className="mx-auto">
                {/* A fixed size: the chart then draws the same on the server, in a
                    narrow column and on a phone, with no measuring step. */}
                <PieChart width={220} height={208}>
                    <Pie data={byCategory} dataKey="count" nameKey="name" cx="50%" cy="50%" innerRadius="55%" outerRadius="90%" stroke="var(--card)" strokeWidth={2} isAnimationActive={false}>
                      {byCategory.map((c, i) => <Cell key={c.name} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                    </Pie>
                    <Tooltip formatter={(v, n) => [`${Number(v)} (${Math.round((Number(v) / visible.length) * 100)}%)`, String(n)]} />
                </PieChart>
              </div>
              <div className="divide-y divide-border rounded-lg border border-border">
                {byCategory.map((c, i) => (
                  <div key={c.name} className="flex items-center gap-2.5 px-3 py-1.5 text-sm">
                    <span className="size-3 shrink-0 rounded-sm" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                    <span className="min-w-0 flex-1 truncate">{c.name}</span>
                    <span className="tabular-nums text-muted-foreground">{Math.round((c.count / visible.length) * 100)}%</span>
                    <span className="w-8 text-right font-semibold tabular-nums">{c.count}</span>
                  </div>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Complaints ─────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="space-y-3 pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">Complaints</CardTitle>
            <div className="flex flex-wrap gap-1.5">
              {RANGES.map((r) => (
                <button
                  key={r.days}
                  type="button"
                  onClick={() => pickRange(r.days)}
                  className={cn(
                    "rounded-md border px-2.5 py-1 text-xs transition",
                    rangeDays === r.days ? "border-brand bg-brand text-white" : "border-border bg-background hover:bg-muted"
                  )}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative sm:max-w-xs sm:flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="h-8 pl-8 text-xs"
                placeholder="Customer, complaint or who entered it…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {(["ALL", ...COMPLAINT_RESOLUTIONS] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFilter(f)}
                  className={cn(
                    "rounded-md border px-2.5 py-1 text-xs transition",
                    filter === f ? "border-foreground bg-foreground text-background" : "border-border bg-background hover:bg-muted"
                  )}
                >
                  {f === "ALL" ? "All" : RESOLUTION_LABELS[f]}
                </button>
              ))}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {visible.length} complaint{visible.length === 1 ? "" : "s"}
            {refundTotal > 0 && <> · <span className="font-medium text-foreground">{money(refundTotal)}</span> refunded</>}
            {replacements > 0 && <> · {replacements} replacement{replacements === 1 ? "" : "s"}</>}
            {loadingList && <Loader2 className="ml-2 inline size-3 animate-spin" />}
          </p>
        </CardHeader>
        <CardContent className="pt-0">
          {visible.length === 0 ? (
            <p className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
              No complaints in this period.
            </p>
          ) : (
            <div className="divide-y divide-border rounded-lg border border-border">
              {visible.map((r) => {
                const Icon = RESOLUTION_ICON[r.resolution];
                return (
                  <div key={r.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="font-medium">{r.customerName}</span>
                        <span className="text-xs text-muted-foreground">{r.customerCode}{r.shiftName ? ` · ${r.shiftName}` : ""}</span>
                        <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1", RESOLUTION_TONE[r.resolution])}>
                          <Icon className="size-3" /> {RESOLUTION_LABELS[r.resolution]}
                        </span>
                      </div>
                      <p className="text-sm">
                        <span className="font-medium">{r.category}</span>
                        <span className="text-muted-foreground"> — {r.description}</span>
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        Delivery {dayLabel(r.deliveryDate)} · received {dayLabel(r.date)} · entered by{" "}
                        <span className="font-medium text-foreground">{r.enteredByName}</span>
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center justify-between gap-3 sm:flex-col sm:items-end sm:justify-start">
                      <div className="text-right text-sm">
                        {r.resolution === "REFUND" ? (
                          <>
                            <p className="font-semibold text-rose-600">− {money(r.amount)}</p>
                            <p className="text-[11px] text-muted-foreground">{qty(r.quantity ?? 0)} {unitOf(r.unit)} {r.productName}</p>
                          </>
                        ) : r.resolution === "REPLACEMENT" ? (
                          <p className="font-medium text-sky-700">{qty(r.quantity ?? 0)} {unitOf(r.unit)} {r.productName}</p>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className={cn(
                            "h-7 px-2 text-muted-foreground hover:text-foreground",
                            toEdit?.id === r.id && "bg-amber-100 text-amber-800",
                          )}
                          onClick={() => setToEdit(r)}
                          aria-label="Edit complaint"
                          title="Edit this complaint"
                        >
                          <Pencil className="size-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-muted-foreground hover:text-rose-600"
                          onClick={() => setToDelete(r)}
                          aria-label="Remove complaint"
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Editing happens here, over the list, so the complaint being changed stays
          in view and nothing about the page shifts under the cursor. */}
      <Dialog open={!!toEdit} onOpenChange={(o) => { if (!o) setToEdit(null); }}>
        <DialogContent className="max-h-[92vh] w-[96vw] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit complaint</DialogTitle>
            <DialogDescription>
              {toEdit ? (
                <>
                  {toEdit.customerName} ({toEdit.customerCode}) · delivered {dayLabel(toEdit.deliveryDate)}.
                  {" "}Saving rewrites what this complaint gave: the refund on the bill, or the replacement and its stock.
                </>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          {toEdit && (
            <ComplaintForm
              key={toEdit.id}
              customers={customers}
              userName={userName}
              existing={toEdit}
              onCancel={() => setToEdit(null)}
              onSaved={async () => {
                setToEdit(null);
                await refreshList(rangeDays);
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!toDelete} onOpenChange={(o) => { if (!o) setToDelete(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove this complaint?</DialogTitle>
            <DialogDescription>
              {toDelete?.resolution === "REFUND"
                ? `The ${money(toDelete.amount)} refund will be added back to ${toDelete.customerName}'s bill.`
                : toDelete?.resolution === "REPLACEMENT"
                  ? `The ${qty(toDelete.quantity ?? 0)} ${unitOf(toDelete.unit)} ${toDelete.productName ?? ""} taken from stock will be put back.`
                  : "It will be removed from the list. Nothing else changes."}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setToDelete(null)} disabled={pending}>
              Keep it
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={pending}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
              Remove
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
