"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  ProductsPicker,
  type CustomerProductRow,
  type ProductOption,
} from "./products-picker";
import { customerFormSchema } from "@/lib/validators/customer";
import { createCustomer } from "@/app/(dashboard)/customers/actions";
import { format } from "date-fns";

type AreaOption = { id: string; name: string; defaultDeliveryCharge?: number; scheduleLabel?: string };
type SimpleOption = { id: string; name: string };

type FieldErrors = Record<string, string>;

type FormState = {
  customerCode: string;
  name: string;
  invoiceName: string;
  phone: string;
  secondPhone: string;
  email: string;
  address: string;
  locationUrl: string;
  areaId: string;
  shiftId: string;
  billingType: "CREDIT" | "DAILY";
  status: "ACTIVE" | "INACTIVE" | "RECOVERY" | "DISABLED";
  customerType: string;
  joinDate: string;
  openingBalance: number;
  creditLimit: number;
  deliveryCharge: number;
};

export type CustomerFormInitial = Partial<FormState> & { products?: CustomerProductRow[] };

export function CustomerForm({
  products,
  areas,
  shifts,
  defaultCustomerCode,
  initial,
  onCreated,
  submitLabel = "Save Changes",
}: {
  products: ProductOption[];
  areas: AreaOption[];
  shifts: SimpleOption[];
  defaultCustomerCode: string;
  initial?: CustomerFormInitial;
  // When provided, called with the new customer id instead of navigating away.
  onCreated?: (id: string) => void;
  submitLabel?: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [errors, setErrors] = useState<FieldErrors>({});

  const [form, setForm] = useState<FormState>({
    customerCode: initial?.customerCode ?? defaultCustomerCode,
    name: initial?.name ?? "",
    invoiceName: initial?.invoiceName ?? "",
    phone: initial?.phone ?? "",
    secondPhone: initial?.secondPhone ?? "",
    email: initial?.email ?? "",
    address: initial?.address ?? "",
    locationUrl: initial?.locationUrl ?? "",
    areaId: initial?.areaId ?? "",
    shiftId: initial?.shiftId ?? "",
    billingType: initial?.billingType ?? "CREDIT",
    status: initial?.status ?? "ACTIVE",
    customerType: initial?.customerType ?? "Regular",
    joinDate: initial?.joinDate ?? format(new Date(), "yyyy-MM-dd"),
    openingBalance: initial?.openingBalance ?? 0,
    creditLimit: initial?.creditLimit ?? 0,
    deliveryCharge: initial?.deliveryCharge ?? 0,
  });

  const [productRows, setProductRows] = useState<CustomerProductRow[]>(initial?.products ?? []);
  const [areaScheduleLabel, setAreaScheduleLabel] = useState<string>(
    () => areas.find((a) => a.id === initial?.areaId)?.scheduleLabel ?? ""
  );

  const update = <K extends keyof typeof form>(
    key: K,
    value: (typeof form)[K]
  ) => setForm((f) => ({ ...f, [key]: value }));

  // Invoice Name auto-follows Customer Name until the user types their own invoice
  // name. On the edit form we treat an already-set invoice name as "custom" so we
  // never clobber it.
  const [invoiceTouched, setInvoiceTouched] = useState<boolean>(!!initial?.invoiceName);

  const handleNameChange = (value: string) =>
    setForm((f) => ({ ...f, name: value, ...(invoiceTouched ? {} : { invoiceName: value }) }));

  const handleAreaChange = (areaId: string) => {
    update("areaId", areaId);
    const area = areas.find((a) => a.id === areaId);
    if (area?.defaultDeliveryCharge !== undefined) {
      update("deliveryCharge", Number(area.defaultDeliveryCharge));
    }
    setAreaScheduleLabel(area?.scheduleLabel ?? "");
  };

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErrors({});

    const payload = {
      ...form,
      areaId: form.areaId || null,
      shiftId: form.shiftId || null,
      products: productRows,
    };

    const result = customerFormSchema.safeParse(payload);
    if (!result.success) {
      const fe: FieldErrors = {};
      for (const issue of result.error.issues) {
        const path = issue.path.join(".");
        fe[path] = issue.message;
      }
      setErrors(fe);
      toast.error("Please fix the errors in the form");
      return;
    }

    startTransition(async () => {
      const res = await createCustomer(result.data);
      if (res.ok) {
        toast.success("Customer created");
        if (onCreated) {
          onCreated(res.id);
        } else {
          router.push("/customers");
          router.refresh();
        }
      } else {
        toast.error(res.error);
      }
    });
  };

  const onReset = () => {
    setForm((f) => ({
      ...f,
      name: "",
      invoiceName: "",
      phone: "",
      secondPhone: "",
      email: "",
      address: "",
      locationUrl: "",
      areaId: "",
      shiftId: "",
      openingBalance: 0,
      creditLimit: 0,
      deliveryCharge: 0,
    }));
    setProductRows([]);
    setErrors({});
  };

  const err = (key: string) =>
    errors[key] ? (
      <p className="mt-1 text-xs text-destructive">{errors[key]}</p>
    ) : null;

  return (
    <form onSubmit={onSubmit} className="space-y-4 p-4 sm:p-6">
      {/* Customer Info */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Customer Info</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <Label>Customer Id</Label>
              <Input
                value={form.customerCode}
                disabled
                placeholder="C-0001"
                className="mt-1 bg-muted/40"
              />
              <p className="mt-1 text-[10px] text-muted-foreground">
                {initial ? "Locked — customer IDs can't be changed." : "Auto-assigned on save."}
              </p>
            </div>
            <div>
              <Label>Customer Name *</Label>
              <Input
                value={form.name}
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder="Full name"
                className="mt-1"
              />
              {err("name")}
            </div>

            <div>
              <Label>Contact Number *</Label>
              <Input
                value={form.phone}
                onChange={(e) => update("phone", e.target.value)}
                placeholder="03XX-XXXXXXX"
                className="mt-1"
              />
              {err("phone")}
            </div>
            <div>
              <Label>Second Number</Label>
              <Input
                value={form.secondPhone}
                onChange={(e) => update("secondPhone", e.target.value)}
                placeholder="Optional"
                className="mt-1"
              />
            </div>

            <div>
              <Label>Email</Label>
              <Input
                type="email"
                value={form.email}
                onChange={(e) => update("email", e.target.value)}
                placeholder="customer@example.com"
                className="mt-1"
              />
              {err("email")}
            </div>
            <div>
              <Label>Invoice Name</Label>
              <Input
                value={form.invoiceName}
                onChange={(e) => { setInvoiceTouched(true); update("invoiceName", e.target.value); }}
                placeholder="Name to print on invoices"
                className="mt-1"
              />
              <p className="mt-1 text-[10px] text-muted-foreground">Auto-filled from the customer name — edit to use a different name on invoices.</p>
            </div>

            <div className="md:col-span-2">
              <Label>Address</Label>
              <Textarea
                value={form.address}
                onChange={(e) => update("address", e.target.value)}
                placeholder="Street, building, landmark..."
                className="mt-1"
                rows={2}
              />
            </div>

            <div className="md:col-span-2">
              <Label>Location URL (Google Maps)</Label>
              <Input
                value={form.locationUrl}
                onChange={(e) => update("locationUrl", e.target.value)}
                placeholder="https://maps.google.com/?q=..."
                className="mt-1"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Routing */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Routing & Status</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            <div>
              <Label>Area</Label>
              <Select
                value={form.areaId}
                onValueChange={handleAreaChange}
              >
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="Choose area" />
                </SelectTrigger>
                <SelectContent>
                  {areas.length === 0 ? (
                    <div className="px-3 py-2 text-sm text-muted-foreground">
                      Add areas first
                    </div>
                  ) : (
                    areas.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
              {areaScheduleLabel && (
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Delivery schedule: <span className="font-medium text-foreground">{areaScheduleLabel}</span>
                </p>
              )}
            </div>

            <div>
              <Label>Shift</Label>
              <Select
                value={form.shiftId}
                onValueChange={(v) => update("shiftId", v)}
              >
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="Choose shift" />
                </SelectTrigger>
                <SelectContent>
                  {shifts.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label>Customer Type</Label>
              <Select
                value={form.customerType}
                onValueChange={(v) => update("customerType", v)}
              >
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["Regular", "Sample", "Wholesale"].map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label>Status</Label>
              <Select
                value={form.status}
                onValueChange={(v) =>
                  update(
                    "status",
                    v as "ACTIVE" | "INACTIVE" | "RECOVERY" | "DISABLED"
                  )
                }
              >
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ACTIVE">Active</SelectItem>
                  <SelectItem value="ON_CALL">On call (only when they ask)</SelectItem>
                  <SelectItem value="INACTIVE">Inactive</SelectItem>
                  <SelectItem value="RECOVERY">Recovery</SelectItem>
                  <SelectItem value="DISABLED">Disabled</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label>Type</Label>
              <Select
                value={form.billingType}
                onValueChange={(v) =>
                  update("billingType", v as "CREDIT" | "DAILY")
                }
              >
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="CREDIT">Credit (monthly bill)</SelectItem>
                  <SelectItem value="DAILY">Daily (cash on delivery)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Money */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Money</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
            <div>
              <Label>Join Date *</Label>
              <Input
                type="date"
                value={form.joinDate}
                onChange={(e) => update("joinDate", e.target.value)}
                className="mt-1"
              />
              {err("joinDate")}
            </div>
            <div>
              <Label>Opening Balance</Label>
              <Input
                type="number"
                value={form.openingBalance}
                onChange={(e) =>
                  update("openingBalance", Number(e.target.value || 0))
                }
                className="mt-1"
              />
            </div>
            <div>
              <Label>Credit Limit</Label>
              <Input
                type="number"
                value={form.creditLimit}
                onChange={(e) =>
                  update("creditLimit", Number(e.target.value || 0))
                }
                className="mt-1"
              />
            </div>
            <div>
              <Label>Delivery Charges</Label>
              <Input
                type="number"
                value={form.deliveryCharge}
                onChange={(e) =>
                  update("deliveryCharge", Number(e.target.value || 0))
                }
                className="mt-1"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Auto-filled from selected area
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Products */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Products & Schedule</CardTitle>
        </CardHeader>
        <CardContent>
          <ProductsPicker
            options={products}
            value={productRows}
            onChange={setProductRows}
            error={errors["products"]}
            shiftId={form.shiftId}
          />
        </CardContent>
      </Card>

      {/* Actions */}
      <div className="sticky bottom-0 -mx-4 flex items-center justify-end gap-3 border-t border-border bg-background/95 px-4 py-4 backdrop-blur sm:-mx-6 sm:px-6">
        <Button type="button" variant="outline" onClick={onReset} className="flex-1 sm:flex-none">
          Reset
        </Button>
        <Button type="submit" disabled={isPending} className="flex-1 sm:flex-none">
          {isPending ? "Saving..." : submitLabel}
        </Button>
      </div>
    </form>
  );
}
