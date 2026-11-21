"use client";

import { useState, useMemo, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Search, RotateCcw } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { reactivateCustomer } from "@/app/(dashboard)/customers/actions";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ALL_DEACTIVATION_REASONS } from "@/lib/deactivation-reasons";

const NONE_KEY = "__NONE__";

export type LostCustomerRow = {
  id: string;
  customerCode: string;
  name: string;
  phone: string;
  areaName: string | null;
  shiftName: string | null;
  status: string;
  totalSales: number;
  deactivationReason: string | null;
};

function fmt(n: number) {
  return n.toLocaleString("en-PK");
}

export function LostCustomersClient(
  { rows, initialSearch = "" }:
  { rows: LostCustomerRow[];
  /** Pre-fills the search box, so `/customers?find=<id>` opens with that one
   *  customer already showing instead of leaving you to hunt for them. */
    initialSearch?: string }
) {
  const [search, setSearch] = useState(initialSearch);
  const [reasonFilter, setReasonFilter] = useState("ALL");
  const router = useRouter();
  const [, start] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);

  function handleReactivate(id: string, name: string) {
    if (!window.confirm(`Reactivate "${name}"? They will move back to the active customer list.`)) return;
    setBusyId(id);
    start(async () => {
      const res = await reactivateCustomer(id);
      setBusyId(null);
      if (res.ok) {
        toast.success(`${name} reactivated`);
        router.refresh();
      } else {
        toast.error(res.error ?? "Could not reactivate customer.");
      }
    });
  }

  // Live count per reason (+ a "no reason recorded" bucket) for the filter labels.
  const reasonCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const c of rows) {
      const key = c.deactivationReason ?? NONE_KEY;
      m[key] = (m[key] ?? 0) + 1;
    }
    return m;
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return rows.filter((c) => {
      if (reasonFilter !== "ALL" && (c.deactivationReason ?? NONE_KEY) !== reasonFilter) return false;
      if (!q) return true;
      return (
        c.name.toLowerCase().includes(q) ||
        c.phone.includes(q) ||
        c.customerCode.toLowerCase().includes(q) ||
        (c.areaName?.toLowerCase().includes(q) ?? false) ||
        (c.shiftName?.toLowerCase().includes(q) ?? false) ||
        (c.deactivationReason?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [rows, search, reasonFilter]);

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <Card>
        <CardContent className="p-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search by name, phone, code, area or reason…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9 h-9"
              />
            </div>
            <Select value={reasonFilter} onValueChange={setReasonFilter}>
              <SelectTrigger className="h-9 w-full sm:w-64 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All reasons ({rows.length})</SelectItem>
                {ALL_DEACTIVATION_REASONS.map((r) => (
                  <SelectItem key={r} value={r}>{r} ({reasonCounts[r] ?? 0})</SelectItem>
                ))}
                {(reasonCounts[NONE_KEY] ?? 0) > 0 && (
                  <SelectItem value={NONE_KEY}>No reason recorded ({reasonCounts[NONE_KEY]})</SelectItem>
                )}
              </SelectContent>
            </Select>
            {(search || reasonFilter !== "ALL") && (
              <button
                onClick={() => { setSearch(""); setReasonFilter("ALL"); }}
                className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
              >
                Clear filters
              </button>
            )}
          </div>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground px-1">
        {filtered.length} of {rows.length} lost customer{rows.length !== 1 ? "s" : ""}
      </p>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-24">Code</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Area</TableHead>
                  <TableHead>Shift</TableHead>
                  <TableHead className="text-right">Total Sales</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Deactivation Reason</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={9}
                      className="h-24 text-center text-sm text-muted-foreground"
                    >
                      {search ? "No customers match your search." : "No lost customers."}
                    </TableCell>
                  </TableRow>
                ) : (
                  filtered.map((c) => (
                    <TableRow key={c.id} className="opacity-70">
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {c.customerCode}
                      </TableCell>
                      <TableCell className="font-medium text-sm">{c.name}</TableCell>
                      <TableCell className="text-sm text-muted-foreground tabular-nums">
                        {c.phone}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {c.areaName ?? "—"}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {c.shiftName ?? "—"}
                      </TableCell>
                      <TableCell className="text-right text-sm tabular-nums">
                        ₨ {fmt(c.totalSales)}
                      </TableCell>
                      <TableCell>
                        <span className="inline-block rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-[11px] font-semibold text-rose-700">
                          {c.status === "INACTIVE" ? "Inactive" : c.status === "DISABLED" ? "Disabled" : c.status}
                        </span>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground max-w-[240px]">
                        <span className="block truncate" title={c.deactivationReason ?? undefined}>
                          {c.deactivationReason ?? <span className="italic opacity-50">No reason provided</span>}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 gap-1.5 text-xs"
                          disabled={busyId === c.id}
                          onClick={() => handleReactivate(c.id, c.name)}
                        >
                          <RotateCcw className={busyId === c.id ? "size-3.5 animate-spin" : "size-3.5"} />
                          {busyId === c.id ? "Reactivating…" : "Reactivate"}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
