"use client";

import { useState, useEffect, useTransition } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { ProductsPicker, type CustomerProductRow, type ProductOption } from "./products-picker";
import {
  getCustomerForEdit, updateCustomer,
  type CustomerEditData,
} from "@/app/(dashboard)/customers/actions";

// ── Types ─────────────────────────────────────────────────────────────────────

type AreaOption  = { id: string; name: string; defaultDeliveryCharge?: number; scheduleLabel?: string };
type SimpleOption = { id: string; name: string };
type FieldErrors  = Record<string, string>;

// ── Main component ────────────────────────────────────────────────────────────

export function EditCustomerSheet({
  customerId,
  open,
  onClose,
  onSaved,
  products: productOptions,
  areas,
  shifts,
}: {
  customerId: string | null;
  open: boolean;
  onClose: () => void;
  onSaved: (id: string) => void;
  products: ProductOption[];
  areas: AreaOption[];
  shifts: SimpleOption[];
}) {
  const [isPending, startTransition] = useTransition();
  const [loading, setLoading]         = useState(false);
  const [errors, setErrors]           = useState<FieldErrors>({});

  // Form state — matches CustomerEditData
  const [data, setData]           = useState<CustomerEditData | null>(null);
  const [productRows, setProductRows] = useState<CustomerProductRow[]>([]);
  const [areaScheduleLabel, setAreaScheduleLabel] = useState<string>("");

  // Fetch customer when opened
  useEffect(() => {
    if (!open || !customerId) return;
    setLoading(true);
    setErrors({});
    getCustomerForEdit(customerId).then((res) => {
      setLoading(false);
      if (!res.ok) { toast.error(res.error); onClose(); return; }
      setData(res.customer);
      setProductRows(res.customer.products);
      const area = areas.find((a) => a.id === res.customer.areaId);
      setAreaScheduleLabel(area?.scheduleLabel ?? "");
    });
  }, [open, customerId]); // eslint-disable-line react-hooks/exhaustive-deps

  function up<K extends keyof CustomerEditData>(key: K, value: CustomerEditData[K]) {
    setData((d) => d ? { ...d, [key]: value } : d);
  }

  function handleAreaChange(areaId: string) {
    up("areaId", areaId);
    const area = areas.find((a) => a.id === areaId);
    if (area?.defaultDeliveryCharge !== undefined) up("deliveryCharge", Number(area.defaultDeliveryCharge));
    setAreaScheduleLabel(area?.scheduleLabel ?? "");
  }

  function err(key: string) {
    return errors[key]
      ? <p className="mt-1 text-xs text-destructive">{errors[key]}</p>
      : null;
  }

  function handleSave() {
    if (!data) return;
    const fe: FieldErrors = {};
    if (!data.name.trim())        fe.name  = "Name is required.";
    if (data.phone.length < 7)    fe.phone = "Phone is required.";
    if (!productRows.length)      fe.products = "Add at least one product.";
    if (Object.keys(fe).length) { setErrors(fe); toast.error("Fix the errors before saving."); return; }

    startTransition(async () => {
      const res = await updateCustomer(data.id, {
        name:           data.name,
        invoiceName:    data.invoiceName,
        phone:          data.phone,
        secondPhone:    data.secondPhone,
        email:          data.email,
        address:        data.address,
        locationUrl:    data.locationUrl,
        areaId:         data.areaId || null,
        shiftId:        data.shiftId || null,
        billingType:    data.billingType,
        status:         data.status,
        customerType:   data.customerType,
        joinDate:       data.joinDate,
        creditLimit:    data.creditLimit,
        deliveryCharge: data.deliveryCharge,
        products:       productRows,
      });
      if (!res.ok) { toast.error(res.error); return; }
      toast.success("Customer updated.");
      onSaved(data.id);
    });
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            Edit customer{data ? ` — ${data.customerCode}` : ""}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Changes are saved immediately. Opening balance is not editable here.
          </DialogDescription>
        </DialogHeader>

        {/* Body */}
        <div className="space-y-6">
          {loading ? (
            <div className="flex h-48 items-center justify-center text-muted-foreground">
              <Loader2 className="size-5 animate-spin mr-2" />
              Loading…
            </div>
          ) : !data ? null : (
            <>
              {/* ── Customer Info ── */}
              <section className="space-y-4">
                <h3 className="text-sm font-semibold">Customer Info</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs">Customer ID</Label>
                    <Input value={data.customerCode} disabled className="mt-1 h-8 text-xs bg-muted/40" />
                    <p className="mt-1 text-[10px] text-muted-foreground">ID cannot be changed</p>
                  </div>
                  <div>
                    <Label className="text-xs">Name *</Label>
                    <Input value={data.name} onChange={(e) => up("name", e.target.value)} className="mt-1 h-8 text-xs" />
                    {err("name")}
                  </div>
                  <div>
                    <Label className="text-xs">Phone *</Label>
                    <Input value={data.phone} onChange={(e) => up("phone", e.target.value)} className="mt-1 h-8 text-xs" placeholder="03XX-XXXXXXX" />
                    {err("phone")}
                  </div>
                  <div>
                    <Label className="text-xs">Second phone</Label>
                    <Input value={data.secondPhone} onChange={(e) => up("secondPhone", e.target.value)} className="mt-1 h-8 text-xs" placeholder="Optional" />
                  </div>
                  <div>
                    <Label className="text-xs">Email</Label>
                    <Input type="email" value={data.email} onChange={(e) => up("email", e.target.value)} className="mt-1 h-8 text-xs" />
                    {err("email")}
                  </div>
                  <div>
                    <Label className="text-xs">Invoice name</Label>
                    <Input value={data.invoiceName} onChange={(e) => up("invoiceName", e.target.value)} className="mt-1 h-8 text-xs" placeholder="Name on invoices" />
                  </div>
                  <div className="sm:col-span-2">
                    <Label className="text-xs">Address</Label>
                    <Textarea value={data.address} onChange={(e) => up("address", e.target.value)} className="mt-1 text-xs resize-none" rows={2} />
                  </div>
                  <div className="sm:col-span-2">
                    <Label className="text-xs">Location URL (Google Maps)</Label>
                    <Input value={data.locationUrl} onChange={(e) => up("locationUrl", e.target.value)} className="mt-1 h-8 text-xs" placeholder="https://maps.google.com/…" />
                  </div>
                </div>
              </section>

              {/* ── Routing & Status ── */}
              <section className="space-y-4">
                <h3 className="text-sm font-semibold">Routing & Status</h3>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <div>
                    <Label className="text-xs">Area</Label>
                    <Select value={data.areaId || "none"} onValueChange={(v) => handleAreaChange(v === "none" ? "" : v)}>
                      <SelectTrigger className="mt-1 h-8 text-xs"><SelectValue placeholder="Choose area" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none" className="text-xs">No area</SelectItem>
                        {areas.map((a) => <SelectItem key={a.id} value={a.id} className="text-xs">{a.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    {areaScheduleLabel && (
                      <p className="mt-1.5 text-[10px] text-muted-foreground">
                        Schedule: <span className="font-medium text-foreground">{areaScheduleLabel}</span>
                      </p>
                    )}
                  </div>
                  <div>
                    <Label className="text-xs">Shift</Label>
                    <Select value={data.shiftId || "none"} onValueChange={(v) => up("shiftId", v === "none" ? "" : v)}>
                      <SelectTrigger className="mt-1 h-8 text-xs"><SelectValue placeholder="Choose shift" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none" className="text-xs">No shift</SelectItem>
                        {shifts.map((s) => <SelectItem key={s.id} value={s.id} className="text-xs">{s.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-xs">Status</Label>
                    <Select value={data.status} onValueChange={(v) => up("status", v as CustomerEditData["status"])}>
                      <SelectTrigger className="mt-1 h-8 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ACTIVE" className="text-xs">Active</SelectItem>
                        <SelectItem value="ON_CALL" className="text-xs">On call (only when they ask)</SelectItem>
                        <SelectItem value="INACTIVE" className="text-xs">Inactive</SelectItem>
                        <SelectItem value="RECOVERY" className="text-xs">Recovery</SelectItem>
                        <SelectItem value="DISABLED" className="text-xs">Disabled</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-xs">Billing type</Label>
                    <Select value={data.billingType} onValueChange={(v) => up("billingType", v as "CREDIT" | "DAILY")}>
                      <SelectTrigger className="mt-1 h-8 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="CREDIT" className="text-xs">Credit (monthly bill)</SelectItem>
                        <SelectItem value="DAILY" className="text-xs">Daily (cash on delivery)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-xs">Customer type</Label>
                    <Select value={data.customerType} onValueChange={(v) => up("customerType", v)}>
                      <SelectTrigger className="mt-1 h-8 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {["Regular","Sample","Wholesale"].map((t) => <SelectItem key={t} value={t} className="text-xs">{t}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </section>

              {/* ── Financial ── */}
              <section className="space-y-3">
                <h3 className="text-sm font-semibold">Financial</h3>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <div>
                    <Label className="text-xs">Join date</Label>
                    <Input type="date" value={data.joinDate} onChange={(e) => up("joinDate", e.target.value)} className="mt-1 h-8 text-xs" />
                  </div>
                  <div>
                    <Label className="text-xs">Credit limit</Label>
                    <Input type="number" min="0" value={data.creditLimit} onChange={(e) => up("creditLimit", Number(e.target.value || 0))} className="mt-1 h-8 text-xs text-right" />
                  </div>
                  <div>
                    <Label className="text-xs">Delivery charges</Label>
                    <Input type="number" min="0" value={data.deliveryCharge} onChange={(e) => up("deliveryCharge", Number(e.target.value || 0))} className="mt-1 h-8 text-xs text-right" />
                    <p className="mt-1 text-[10px] text-muted-foreground">Auto-filled from area</p>
                  </div>
                </div>
              </section>

              {/* ── Products ── */}
              <section className="space-y-3">
                <h3 className="text-sm font-semibold">Products & Schedule</h3>
                <ProductsPicker
                  options={productOptions}
                  value={productRows}
                  onChange={setProductRows}
                  error={errors["products"]}
                  shiftId={data.shiftId}
                />
              </section>
            </>
          )}
        </div>

        {/* Footer */}
        {!loading && data && (
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={onClose} disabled={isPending}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSave} disabled={isPending}>
              {isPending ? <><Loader2 className="mr-1.5 size-3.5 animate-spin" />Saving…</> : "Save changes"}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
