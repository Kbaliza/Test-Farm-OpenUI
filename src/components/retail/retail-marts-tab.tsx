"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Plus, Search, Pencil, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import {
  createRetailVendor,
  updateRetailVendor,
  setRetailVendorActive,
  recordRetailReceipt,
  type RetailMartsData,
  type MartRow,
} from "@/app/(dashboard)/retail/actions";
import { fmt } from "./retail-client";

export function RetailMartsTab({
  marts,
  heads,
  onChanged,
}: {
  marts: RetailMartsData;
  heads: { head: string; label: string; balance: number }[];
  onChanged: () => void;
}) {
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<MartRow | "new" | null>(null);
  const [collecting, setCollecting] = useState<MartRow | null>(null);

  const rows = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return marts.marts;
    return marts.marts.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        (m.areaName ?? "").toLowerCase().includes(q) ||
        (m.city ?? "").toLowerCase().includes(q) ||
        (m.managerName ?? "").toLowerCase().includes(q)
    );
  }, [marts.marts, search]);

  const totalOwed = marts.marts.reduce((s, m) => s + m.balanceOwed, 0);
  const totalOut = marts.marts.reduce((s, m) => s + m.stockOutValue, 0);

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="flex flex-wrap items-center gap-2 p-3">
          <div className="relative min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search shop, manager, area…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-9 pl-9"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            <span className="font-semibold text-rose-700">₨ {fmt(totalOwed)}</span> owed ·{" "}
            <span className="font-semibold text-amber-700">₨ {fmt(totalOut)}</span> still on shelves
          </p>
          <Button size="sm" variant="outline" onClick={() => setEditing("new")}>
            <Plus className="mr-1.5 size-3.5" /> Add shop
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Shop</TableHead>
                  <TableHead>Area / City</TableHead>
                  <TableHead className="w-28 text-right">Balance owed</TableHead>
                  <TableHead className="w-28 text-right">Collected</TableHead>
                  <TableHead className="w-28 text-right">Stock out</TableHead>
                  <TableHead className="w-32" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="h-24 text-center text-sm text-muted-foreground">
                      {marts.marts.length === 0 ? "No shops yet — add one to start." : "No shops match your search."}
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((m) => (
                    <TableRow key={m.id} className={cn(!m.active && "opacity-60")}>
                      <TableCell>
                        <div className="font-medium">
                          <Link
                            href={`/ledgers?type=retail&id=${m.id}`}
                            className="underline-offset-2 hover:underline"
                            title={`Open ${m.name}'s ledger`}
                          >
                            {m.name}
                          </Link>
                          {!m.active && <span className="ml-2 text-[10px] uppercase text-muted-foreground">inactive</span>}
                        </div>
                        {(m.managerName || m.phone) && (
                          <div className="text-[11px] text-muted-foreground">
                            {[m.managerName, m.phone].filter(Boolean).join(" · ")}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {[m.areaName, m.city].filter(Boolean).join(", ") || "—"}
                      </TableCell>
                      <TableCell className={cn("text-right tabular-nums font-semibold", m.balanceOwed > 0 ? "text-rose-700" : "text-emerald-700")}>
                        {m.balanceOwed > 0 ? `₨ ${fmt(m.balanceOwed)}` : "Clear"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-emerald-700">
                        {m.collected > 0 ? `₨ ${fmt(m.collected)}` : "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-amber-700">
                        {m.stockOutValue > 0 ? (
                          <>
                            ₨ {fmt(m.stockOutValue)}
                            <span className="ml-1 text-[10px] text-muted-foreground">({m.openDrops})</span>
                          </>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          {m.balanceOwed > 0.005 && (
                            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setCollecting(m)}>
                              <Wallet className="mr-1 size-3" /> Collect
                            </Button>
                          )}
                          <button
                            type="button"
                            onClick={() => setEditing(m)}
                            title="Edit shop"
                            className="grid size-7 place-items-center rounded-md border border-border text-muted-foreground hover:bg-muted"
                          >
                            <Pencil className="size-3.5" />
                          </button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <MartDialog mart={editing} onClose={() => setEditing(null)} onSaved={onChanged} />
      <CollectDialog mart={collecting} heads={heads} onClose={() => setCollecting(null)} onSaved={onChanged} />
    </div>
  );
}

function MartDialog({
  mart,
  onClose,
  onSaved,
}: {
  mart: MartRow | "new" | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [pending, start] = useTransition();
  const isNew = mart === "new";
  const row = mart && mart !== "new" ? mart : null;
  const [form, setForm] = useState({
    name: "",
    managerName: "",
    phone: "",
    address: "",
    areaName: "",
    city: "",
    followUpDays: "3",
  });

  useEffect(() => {
    if (!mart) return;
    setForm({
      name: row?.name ?? "",
      managerName: row?.managerName ?? "",
      phone: row?.phone ?? "",
      address: "",
      areaName: row?.areaName ?? "",
      city: row?.city ?? "",
      followUpDays: String(row?.followUpDays ?? 3),
    });
  }, [mart, row]);

  function save() {
    if (!form.name.trim()) {
      toast.error("Enter the shop's name.");
      return;
    }
    start(async () => {
      const payload = { ...form, followUpDays: parseInt(form.followUpDays, 10) };
      const res = isNew ? await createRetailVendor(payload) : await updateRetailVendor(row!.id, payload);
      if (res.ok) {
        toast.success(isNew ? "Shop added." : "Shop updated.");
        onClose();
        onSaved();
      } else {
        toast.error(res.error);
      }
    });
  }

  function toggleActive() {
    if (!row) return;
    start(async () => {
      const res = await setRetailVendorActive(row.id, !row.active);
      if (res.ok) {
        toast.success(row.active ? "Shop deactivated." : "Shop reactivated.");
        onClose();
        onSaved();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Dialog open={!!mart} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isNew ? "Add a shop" : row?.name}</DialogTitle>
          <DialogDescription>
            Shops that take product on consignment. Kept separate from your suppliers.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <F label="Shop name" v={form.name} set={(v) => setForm({ ...form, name: v })} />
          <F label="Manager" v={form.managerName} set={(v) => setForm({ ...form, managerName: v })} />
          <F label="Phone" v={form.phone} set={(v) => setForm({ ...form, phone: v })} />
          <F label="Address" v={form.address} set={(v) => setForm({ ...form, address: v })} />
          <F label="Area" v={form.areaName} set={(v) => setForm({ ...form, areaName: v })} />
          <F label="City" v={form.city} set={(v) => setForm({ ...form, city: v })} />
          <div>
            <Label className="text-xs">Check back after (days)</Label>
            <Input
              type="number"
              min={0}
              max={60}
              className="mt-1"
              value={form.followUpDays}
              onChange={(e) => setForm({ ...form, followUpDays: e.target.value })}
            />
            <p className="mt-1 text-[11px] text-muted-foreground">How long before we ask this shop what sold.</p>
          </div>
        </div>

        <DialogFooter className="flex-wrap gap-2">
          {row && (
            <Button variant="outline" onClick={toggleActive} disabled={pending} className="mr-auto">
              {row.active ? "Deactivate" : "Reactivate"}
            </Button>
          )}
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={save} disabled={pending}>
            {pending ? "Saving…" : isNew ? "Add shop" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CollectDialog({
  mart,
  heads,
  onClose,
  onSaved,
}: {
  mart: MartRow | null;
  heads: { head: string; label: string; balance: number }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [pending, start] = useTransition();
  const [amount, setAmount] = useState("");
  const [head, setHead] = useState("CASH");

  useEffect(() => {
    if (!mart) return;
    setAmount("");
    setHead("CASH");
  }, [mart]);

  if (!mart) return null;
  const amt = parseFloat(amount) || 0;
  const over = amt - mart.balanceOwed > 0.005;

  function save() {
    if (amt <= 0) {
      toast.error("Enter an amount greater than zero.");
      return;
    }
    if (over) {
      toast.error(`${mart!.name} only owes ₨ ${fmt(mart!.balanceOwed)}.`);
      return;
    }
    start(async () => {
      const res = await recordRetailReceipt({ retailVendorId: mart!.id, amount: amt, head });
      if (res.ok) {
        toast.success(`₨ ${fmt(amt)} collected from ${mart!.name}.`);
        onClose();
        onSaved();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Dialog open={!!mart} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Collect from {mart.name}</DialogTitle>
          <DialogDescription>
            Owes ₨ {fmt(mart.balanceOwed)}. Payment is applied to their oldest unpaid sale first.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label className="text-xs">Amount</Label>
            <div className="mt-1 flex gap-2">
              <Input type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
              <Button type="button" variant="outline" className="shrink-0 text-xs" onClick={() => setAmount(String(mart.balanceOwed))}>
                Full
              </Button>
            </div>
            {over && <p className="mt-1 text-[11px] text-rose-600">More than they owe.</p>}
          </div>
          <div>
            <Label className="text-xs">Into</Label>
            <Select value={head} onValueChange={setHead}>
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {heads.map((h) => (
                  <SelectItem key={h.head} value={h.head}>
                    {h.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={save} disabled={pending || over || amt <= 0}>
            {pending ? "Saving…" : "Record payment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function F({ label, v, set }: { label: string; v: string; set: (x: string) => void }) {
  return (
    <div>
      <Label className="text-xs">{label}</Label>
      <Input className="mt-1" value={v} onChange={(e) => set(e.target.value)} />
    </div>
  );
}
