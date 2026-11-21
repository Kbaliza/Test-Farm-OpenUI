"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Search, PhoneCall, Pencil } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EditCustomerSheet } from "./edit-customer-sheet";
import type { ProductOption } from "./products-picker";

// Same shapes the main Customers tab declares — both hand them to the same sheet.
type AreaOption = { id: string; name: string; defaultDeliveryCharge?: number; scheduleLabel?: string };
type SimpleOption = { id: string; name: string };

export type OnCallCustomerRow = {
  id: string;
  customerCode: string;
  name: string;
  phone: string;
  areaName: string | null;
  shiftName: string | null;
  products: { id: string; name: string; quantity: number; unit: string }[];
};

const uLabel = (u: string) => (u === "LITER" ? "L" : u === "KG" ? "kg" : "pc");

export function OnCallCustomersClient({
  rows,
  products,
  areas,
  shifts,
  initialSearch = "",
}: {
  rows: OnCallCustomerRow[];
  products: ProductOption[];
  areas: AreaOption[];
  shifts: SimpleOption[];
  /** Pre-fills the search box, so `/customers?find=<id>` opens with that one
   *  customer already showing instead of leaving you to hunt for them. */
  initialSearch?: string;
}) {
  const router = useRouter();
  const [search, setSearch] = useState(initialSearch);
  // The same sheet the main Customers tab uses, so an on-call customer is edited
  // exactly as any other — one form, one set of rules.
  const [editId, setEditId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return rows;
    return rows.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.phone.includes(q) ||
        c.customerCode.toLowerCase().includes(q) ||
        (c.areaName?.toLowerCase().includes(q) ?? false) ||
        (c.shiftName?.toLowerCase().includes(q) ?? false)
    );
  }, [rows, search]);

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div className="flex items-start gap-2 rounded-lg border border-sky-200 bg-sky-50/50 px-3 py-2 text-xs text-sky-900">
        <PhoneCall className="mt-0.5 size-3.5 shrink-0" />
        <p>
          On-call customers are <strong>never added to a shift automatically</strong>. When one phones in,
          open <strong>Pre-Delivery</strong> for their shift, click <strong>Add customer</strong>, and they
          appear at the top of that dialog with the quantities saved below — one click to add them for the day.
        </p>
      </div>

      <Card>
        <CardContent className="p-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by name, phone, code, area or shift…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-9 pl-9"
            />
          </div>
        </CardContent>
      </Card>

      <p className="px-1 text-xs text-muted-foreground">
        {filtered.length} of {rows.length} on-call customer{rows.length !== 1 ? "s" : ""}
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
                  <TableHead>Saved quantities</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="h-24 text-center text-sm text-muted-foreground">
                      {search ? "No customers match your search." : "No on-call customers yet — set a customer's status to “On call” to list them here."}
                    </TableCell>
                  </TableRow>
                ) : (
                  filtered.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="font-mono text-xs text-muted-foreground">{c.customerCode}</TableCell>
                      <TableCell className="text-sm font-medium">{c.name}</TableCell>
                      <TableCell className="text-sm tabular-nums text-muted-foreground">{c.phone}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{c.areaName ?? "—"}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{c.shiftName ?? "—"}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {c.products.length
                          ? c.products.map((p) => `${p.name} ${p.quantity}${uLabel(p.unit)}`).join(" · ")
                          : <span className="italic opacity-50">No products saved</span>}
                      </TableCell>
                      <TableCell>
                        <button
                          onClick={() => setEditId(c.id)}
                          title="Edit customer"
                          className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
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
        open={editId !== null}
        onClose={() => setEditId(null)}
        onSaved={() => { setEditId(null); router.refresh(); }}
        products={products}
        areas={areas}
        shifts={shifts}
      />
    </div>
  );
}
