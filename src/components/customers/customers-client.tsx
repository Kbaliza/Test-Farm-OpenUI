"use client";

import { useState, useTransition, useMemo } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Search, CircleCheck, CircleMinus, Pencil } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DEACTIVATION_REASONS, NO_REASON } from "@/lib/deactivation-reasons";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent } from "@/components/ui/card";
import { toggleCustomerActive } from "@/app/(dashboard)/customers/actions";
import { EditCustomerSheet } from "./edit-customer-sheet";
import type { ProductOption } from "./products-picker";

// ── Types ─────────────────────────────────────────────────────────────────────

type AreaOption   = { id: string; name: string; defaultDeliveryCharge?: number; scheduleLabel?: string };
type SimpleOption = { id: string; name: string };

export type CustomerRow = {
  id: string;
  customerCode: string;
  name: string;
  phone: string;
  areaName: string | null;
  address: string | null;
  shiftName: string | null;
  billingType: string;
  status: string;
  products: { id: string; name: string; quantity: number; isAlternate: boolean }[];
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const STATUS_BADGE: Record<string, string> = {
  ACTIVE:   "bg-emerald-100 text-emerald-700 border-emerald-200",
  INACTIVE: "bg-slate-100 text-slate-500 border-slate-200",
  RECOVERY: "bg-amber-100 text-amber-700 border-amber-200",
  DISABLED: "bg-rose-100 text-rose-700 border-rose-200",
  ON_CALL:  "bg-sky-100 text-sky-700 border-sky-200",
};

const STATUS_LABEL: Record<string, string> = {
  ACTIVE: "Active", INACTIVE: "Inactive", RECOVERY: "Recovery", DISABLED: "Disabled",
  ON_CALL: "On call",
};

// ── Toggle button ─────────────────────────────────────────────────────────────

function StatusToggle({
  customerId,
  status,
  onDeactivateClick,
  onActivate,
}: {
  customerId: string;
  status: string;
  onDeactivateClick: (id: string) => void;
  onActivate: (id: string) => void;
}) {
  if (status !== "ACTIVE" && status !== "INACTIVE") return null;
  const isActive = status === "ACTIVE";

  return (
    <button
      onClick={() => isActive ? onDeactivateClick(customerId) : onActivate(customerId)}
      title={isActive ? "Mark as Inactive (stops deliveries)" : "Mark as Active (resumes deliveries)"}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors disabled:opacity-50",
        isActive
          ? "border-slate-200 bg-slate-50 text-slate-500 hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600"
          : "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
      )}
    >
      {isActive
        ? <><CircleMinus className="size-3" />Deactivate</>
        : <><CircleCheck className="size-3" />Activate</>
      }
    </button>
  );
}

// ── Deactivation reason dialog ────────────────────────────────────────────────

function DeactivateDialog({
  open,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState<string>(NO_REASON);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl space-y-4">
        <div>
          <p className="font-semibold text-base">Deactivate Customer</p>
          <p className="text-sm text-muted-foreground mt-1">
            Select a reason for deactivation.
          </p>
        </div>
        <Select value={reason} onValueChange={setReason}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Select a reason" />
          </SelectTrigger>
          <SelectContent>
            {DEACTIVATION_REASONS.map((r) => (
              <SelectItem key={r} value={r}>{r}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            className="rounded-md border border-border px-4 py-1.5 text-sm text-muted-foreground hover:bg-muted transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(reason)}
            className="rounded-md bg-rose-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-rose-700 transition-colors"
          >
            Deactivate
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main client ───────────────────────────────────────────────────────────────

export function CustomersClient({
  initial,
  products: productOptions,
  areas,
  shifts,
  initialSearch = "",
}: {
  initial: CustomerRow[];
  products: ProductOption[];
  areas: AreaOption[];
  shifts: SimpleOption[];
  /** Pre-fills the search box, so `/customers?find=<id>` opens with that one
   *  customer already showing instead of leaving you to hunt for them. */
  initialSearch?: string;
}) {
  const router = useRouter();
  const [customers, setCustomers]       = useState<CustomerRow[]>(initial);
  const [search, setSearch]             = useState(initialSearch);
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [editId, setEditId]             = useState<string | null>(null);
  const [deactivateId, setDeactivateId] = useState<string | null>(null);
  const [_pending, startTransition]     = useTransition();

  // Re-sync when the server sends a fresh list (an edit saved, a refresh).
  //
  // router.refresh() re-renders the server component and merges the new payload
  // "without losing unaffected client-side React (e.g. useState)" — so this
  // copy, taken once at mount, would otherwise keep showing the row as it was
  // when the page was first opened. An edited quantity only appeared after the
  // component happened to remount, which reads as the save not having worked.
  //
  // Adjusting state during render is React's recommended way to reset state on a
  // prop change; same pattern as attendance-client and invoice-detail-client.
  const [syncedFrom, setSyncedFrom] = useState(initial);
  if (syncedFrom !== initial) {
    setSyncedFrom(initial);
    setCustomers(initial);
  }

  function handleSaved(_id: string) {
    setEditId(null);
    router.refresh();
  }

  function handleDeactivateClick(id: string) {
    setDeactivateId(id);
  }

  function handleActivate(id: string) {
    startTransition(async () => {
      const res = await toggleCustomerActive(id, "INACTIVE");
      if (!res.ok) toast.error(res.error);
      else setCustomers((prev) => prev.map((c) => c.id === id ? { ...c, status: "ACTIVE" } : c));
    });
  }

  function handleDeactivateConfirm(reason: string) {
    if (!deactivateId) return;
    const id = deactivateId;
    setDeactivateId(null);
    startTransition(async () => {
      const res = await toggleCustomerActive(id, "ACTIVE", reason || undefined);
      if (!res.ok) toast.error(res.error);
      else setCustomers((prev) => prev.map((c) => c.id === id ? { ...c, status: "INACTIVE" } : c));
    });
  }

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return customers.filter((c) => {
      if (statusFilter !== "ALL" && c.status !== statusFilter) return false;
      if (!q) return true;
      return (
        c.name.toLowerCase().includes(q) ||
        c.phone.includes(q) ||
        c.customerCode.toLowerCase().includes(q) ||
        (c.areaName?.toLowerCase().includes(q) ?? false) ||
        (c.address?.toLowerCase().includes(q) ?? false) ||
        (c.shiftName?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [customers, search, statusFilter]);

  const counts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const c of customers) map[c.status] = (map[c.status] ?? 0) + 1;
    return map;
  }, [customers]);

  return (
    <div className="space-y-4 p-4 sm:p-6">

      {/* Search + filter bar */}
      <Card>
        <CardContent className="p-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search by name, phone, code, address, area or shift…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9 h-9"
              />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="h-9 w-full sm:w-40 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All ({customers.length})</SelectItem>
                <SelectItem value="ACTIVE">Active ({counts.ACTIVE ?? 0})</SelectItem>
                <SelectItem value="INACTIVE">Inactive ({counts.INACTIVE ?? 0})</SelectItem>
                <SelectItem value="RECOVERY">Recovery ({counts.RECOVERY ?? 0})</SelectItem>
                <SelectItem value="DISABLED">Disabled ({counts.DISABLED ?? 0})</SelectItem>
              </SelectContent>
            </Select>
            {(search || statusFilter !== "ALL") && (
              <button
                onClick={() => { setSearch(""); setStatusFilter("ALL"); }}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                Clear filters
              </button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Results count */}
      <p className="text-xs text-muted-foreground px-1">
        Showing {filtered.length} of {customers.length} customers
      </p>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-24">Code</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Address</TableHead>
                  <TableHead>Shift</TableHead>
                  <TableHead>Products</TableHead>
                  <TableHead className="w-20">Type</TableHead>
                  <TableHead className="w-48">Status</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={9}
                      className="h-24 text-center text-sm text-muted-foreground"
                    >
                      {search || statusFilter !== "ALL"
                        ? "No customers match your search."
                        : <>No customers yet. Click <strong>Add Customer</strong> to create one.</>}
                    </TableCell>
                  </TableRow>
                ) : (
                  filtered.map((c) => (
                    <TableRow
                      key={c.id}
                      className={cn(
                        "transition-colors",
                        c.status === "INACTIVE" && "opacity-60"
                      )}
                    >
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {c.customerCode}
                      </TableCell>

                      <TableCell>
                        <span className="font-medium text-sm">{c.name}</span>
                      </TableCell>

                      <TableCell className="text-sm text-muted-foreground tabular-nums">
                        {c.phone}
                      </TableCell>

                      <TableCell className="text-sm text-muted-foreground max-w-[260px]">
                        <span className="line-clamp-2" title={c.address ?? undefined}>
                          {c.address || "—"}
                        </span>
                      </TableCell>

                      <TableCell className="text-sm text-muted-foreground max-w-[140px]">
                        <span className="truncate block" title={c.shiftName ?? undefined}>
                          {c.shiftName ?? "—"}
                        </span>
                      </TableCell>

                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {c.products.length === 0 ? (
                            <span className="text-xs text-muted-foreground">—</span>
                          ) : (
                            c.products.map((p) => (
                              <Badge key={p.id} variant="secondary" className="text-xs">
                                {p.name} · {p.quantity}{p.isAlternate ? " (alt)" : ""}
                              </Badge>
                            ))
                          )}
                        </div>
                      </TableCell>

                      <TableCell>
                        <Badge variant="outline" className="text-xs">
                          {c.billingType === "CREDIT" ? "Credit" : "Daily"}
                        </Badge>
                      </TableCell>

                      <TableCell>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span
                            className={cn(
                              "inline-block rounded-full border px-2 py-0.5 text-[11px] font-semibold",
                              STATUS_BADGE[c.status] ?? STATUS_BADGE.INACTIVE
                            )}
                          >
                            {STATUS_LABEL[c.status] ?? c.status}
                          </span>
                          <StatusToggle
                            customerId={c.id}
                            status={c.status}
                            onDeactivateClick={handleDeactivateClick}
                            onActivate={handleActivate}
                          />
                        </div>
                      </TableCell>

                      <TableCell>
                        <button
                          onClick={() => setEditId(c.id)}
                          title="Edit customer"
                          className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                        >
                          <Pencil className="size-3.5" />
                        </button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <EditCustomerSheet
        customerId={editId}
        open={!!editId}
        onClose={() => setEditId(null)}
        onSaved={handleSaved}
        products={productOptions}
        areas={areas}
        shifts={shifts}
      />

      <DeactivateDialog
        open={!!deactivateId}
        onCancel={() => setDeactivateId(null)}
        onConfirm={handleDeactivateConfirm}
      />
    </div>
  );
}
