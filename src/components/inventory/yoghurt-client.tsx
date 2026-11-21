"use client";

import { useState, useTransition, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { FlaskConical, Trash2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  logYoghurtBatch,
  deleteYoghurtBatch,
  getMilkInStorage,
  type YoghurtBatchEntry,
  type RetailStockByDate,
} from "@/app/(dashboard)/inventory/yoghurt/actions";
import { todayPKTString, toDateStrPKT, fmtDatePKT, fmtTimePKT } from "@/lib/pkt";

function fmt(n: number) {
  return n % 1 === 0 ? n.toFixed(0) : n.toFixed(1);
}

function StatTile({
  label,
  value,
  unit,
  color,
}: {
  label: string;
  value: number;
  unit: string;
  color: string;
}) {
  return (
    <div className={`rounded-xl border border-border p-4 ${color}`}>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-2 text-2xl font-bold">
        {fmt(value)}{" "}
        <span className="text-sm font-medium text-muted-foreground">{unit}</span>
      </p>
    </div>
  );
}

export function YoghurtClient({
  initialEntries,
}: {
  initialEntries: YoghurtBatchEntry[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [retailStock, setRetailStock] = useState<RetailStockByDate | null>(null);
  const [retailStockError, setRetailStockError] = useState(false);
  useEffect(() => {
    getMilkInStorage().then((result) => {
      setRetailStockError(result.fetchError === true);
      setRetailStock(result);
    });
  }, []);

  const [buffaloMilk, setBuffaloMilk] = useState("");
  const [cowMilk, setCowMilk] = useState("");
  const [mixMilk, setMixMilk] = useState("");
  const [boilingWaste, setBoilingWaste] = useState("");
  const [yoghurtProduced, setYoghurtProduced] = useState("");
  const [productionWaste, setProductionWaste] = useState("");
  const [notes, setNotes] = useState("");

  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  function handleSort(key: string) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  }

  const sorted = useMemo(() => {
    if (!sortKey) return initialEntries;
    return [...initialEntries].sort((a, b) => {
      const av = (a as Record<string, unknown>)[sortKey];
      const bv = (b as Record<string, unknown>)[sortKey];
      if (typeof av === "number" && typeof bv === "number")
        return sortDir === "asc" ? av - bv : bv - av;
      const as_ = String(av ?? ""), bs_ = String(bv ?? "");
      return sortDir === "asc" ? as_.localeCompare(bs_) : bs_.localeCompare(as_);
    });
  }, [initialEntries, sortKey, sortDir]);

  const forDate = initialEntries.filter(
    (e) => toDateStrPKT(e.date) === todayPKTString()
  );
  const totalMilk = forDate.reduce(
    (s, e) => s + e.buffaloMilk + e.cowMilk + e.mixMilk,
    0
  );
  const totalYoghurt = forDate.reduce((s, e) => s + e.yoghurtProduced, 0);
  const totalBoilingWaste = forDate.reduce((s, e) => s + e.boilingWaste, 0);
  const totalProductionWaste = forDate.reduce((s, e) => s + e.productionWaste, 0);

  function handleSubmit() {
    const buffalo = parseFloat(buffaloMilk) || 0;
    const cow = parseFloat(cowMilk) || 0;
    const mix = parseFloat(mixMilk) || 0;
    const boiling = parseFloat(boilingWaste) || 0;
    const yoghurt = parseFloat(yoghurtProduced);
    const production = parseFloat(productionWaste) || 0;

    if (buffalo + cow + mix <= 0) {
      toast.error("Enter at least one milk quantity.");
      return;
    }
    if (isNaN(yoghurt) || yoghurt <= 0) {
      toast.error("Enter yogurt produced.");
      return;
    }

    startTransition(async () => {
      const res = await logYoghurtBatch({
        date: todayPKTString(),
        buffaloMilk: buffalo,
        cowMilk: cow,
        mixMilk: mix,
        boilingWaste: boiling,
        yoghurtProduced: yoghurt,
        productionWaste: production,
        notes,
      });
      if (res.ok) {
        toast.success("Batch logged.");
        setBuffaloMilk("");
        setCowMilk("");
        setMixMilk("");
        setBoilingWaste("");
        setYoghurtProduced("");
        setProductionWaste("");
        setNotes("");
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  function handleDelete(id: string) {
    startTransition(async () => {
      const res = await deleteYoghurtBatch(id);
      if (res.ok) {
        toast.success("Batch removed.");
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      {/* ── Stat tiles ── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          label="Milk Used"
          value={totalMilk}
          unit="L"
          color="bg-sky-50/60 ring-1 ring-sky-100"
        />
        <StatTile
          label="Yogurt Produced"
          value={totalYoghurt}
          unit="kg"
          color="bg-purple-50/60 ring-1 ring-purple-100"
        />
        <StatTile
          label="Boiling Waste"
          value={totalBoilingWaste}
          unit="L"
          color="bg-amber-50/60 ring-1 ring-amber-100"
        />
        <StatTile
          label="Production Waste"
          value={totalProductionWaste}
          unit="kg"
          color="bg-rose-50/60 ring-1 ring-rose-100"
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[380px_1fr]">
        {/* ── Entry form ── */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <FlaskConical className="size-4 text-muted-foreground" />
              Log Batch
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label>Buffalo Milk (L)</Label>
              <Input
                type="number"
                min="0"
                step="0.1"
                placeholder="0"
                className="mt-1"
                value={buffaloMilk}
                onChange={(e) => setBuffaloMilk(e.target.value)}
              />
              {retailStockError ? (
                <p className="mt-1 text-xs text-rose-500">Could not load retail stock</p>
              ) : retailStock !== null ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  In storage: <span className="font-medium text-foreground">{fmt(retailStock.buffalo)} L</span>
                </p>
              ) : null}
            </div>

            <div>
              <Label>Cow Milk (L)</Label>
              <Input
                type="number"
                min="0"
                step="0.1"
                placeholder="0"
                className="mt-1"
                value={cowMilk}
                onChange={(e) => setCowMilk(e.target.value)}
              />
              {retailStockError ? (
                <p className="mt-1 text-xs text-rose-500">Could not load retail stock</p>
              ) : retailStock !== null ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  In storage: <span className="font-medium text-foreground">{fmt(retailStock.cow)} L</span>
                </p>
              ) : null}
            </div>

            <div>
              <Label>Mix Milk (L)</Label>
              <Input
                type="number"
                min="0"
                step="0.1"
                placeholder="0"
                className="mt-1"
                value={mixMilk}
                onChange={(e) => setMixMilk(e.target.value)}
              />
              {retailStockError ? (
                <p className="mt-1 text-xs text-rose-500">Could not load retail stock</p>
              ) : retailStock !== null ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  In storage: <span className="font-medium text-foreground">{fmt(retailStock.mix)} L</span>
                </p>
              ) : null}
            </div>

            <div>
              <Label>Boiling Waste (L)</Label>
              <Input
                type="number"
                min="0"
                step="0.1"
                placeholder="0"
                className="mt-1"
                value={boilingWaste}
                onChange={(e) => setBoilingWaste(e.target.value)}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Milk lost during boiling. Recorded in Wastage.
              </p>
            </div>

            <div>
              <Label>Total Yogurt Produced (kg)</Label>
              <Input
                type="number"
                min="0"
                step="0.1"
                placeholder="0"
                className="mt-1"
                value={yoghurtProduced}
                onChange={(e) => setYoghurtProduced(e.target.value)}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Added to Inventory Summary as produced.
              </p>
            </div>

            <div>
              <Label>Production Waste / Spillage (kg)</Label>
              <Input
                type="number"
                min="0"
                step="0.1"
                placeholder="0"
                className="mt-1"
                value={productionWaste}
                onChange={(e) => setProductionWaste(e.target.value)}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Yoghurt lost during production. Recorded in Wastage.
              </p>
            </div>

            <div>
              <Label>Notes (optional)</Label>
              <Input
                placeholder="Any remarks…"
                className="mt-1"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
              />
            </div>

            <Button className="w-full" onClick={handleSubmit} disabled={pending}>
              <Plus className="mr-1.5 size-4" />
              {pending ? "Saving…" : "Log Batch"}
            </Button>
          </CardContent>
        </Card>

        {/* ── History table ── */}
        <div>
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Recent Batches
          </h3>
          {initialEntries.length === 0 ? (
            <div className="flex h-32 flex-col items-center justify-center gap-2 rounded-xl border border-dashed text-muted-foreground">
              <FlaskConical className="size-6 opacity-40" />
              <p className="text-sm">No batches logged yet.</p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/40">
                    <th
                      onClick={() => handleSort("date")}
                      className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
                    >
                      <span className="inline-flex items-center gap-1">
                        Date
                        <span className={sortKey === "date" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                          {sortKey === "date" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                        </span>
                      </span>
                    </th>
                    <th
                      onClick={() => handleSort("buffaloMilk")}
                      className="px-3 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
                    >
                      <span className="inline-flex items-center gap-1 justify-end">
                        Buffalo
                        <span className={sortKey === "buffaloMilk" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                          {sortKey === "buffaloMilk" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                        </span>
                      </span>
                    </th>
                    <th
                      onClick={() => handleSort("cowMilk")}
                      className="px-3 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
                    >
                      <span className="inline-flex items-center gap-1 justify-end">
                        Cow
                        <span className={sortKey === "cowMilk" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                          {sortKey === "cowMilk" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                        </span>
                      </span>
                    </th>
                    <th
                      onClick={() => handleSort("mixMilk")}
                      className="px-3 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
                    >
                      <span className="inline-flex items-center gap-1 justify-end">
                        Mix
                        <span className={sortKey === "mixMilk" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                          {sortKey === "mixMilk" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                        </span>
                      </span>
                    </th>
                    <th
                      onClick={() => handleSort("boilingWaste")}
                      className="px-3 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
                    >
                      <span className="inline-flex items-center gap-1 justify-end">
                        Boil Waste
                        <span className={sortKey === "boilingWaste" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                          {sortKey === "boilingWaste" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                        </span>
                      </span>
                    </th>
                    <th
                      onClick={() => handleSort("yoghurtProduced")}
                      className="px-3 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
                    >
                      <span className="inline-flex items-center gap-1 justify-end">
                        Yoghurt
                        <span className={sortKey === "yoghurtProduced" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                          {sortKey === "yoghurtProduced" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                        </span>
                      </span>
                    </th>
                    <th
                      onClick={() => handleSort("productionWaste")}
                      className="px-3 py-2.5 text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
                    >
                      <span className="inline-flex items-center gap-1 justify-end">
                        Prod Waste
                        <span className={sortKey === "productionWaste" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                          {sortKey === "productionWaste" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                        </span>
                      </span>
                    </th>
                    <th
                      onClick={() => handleSort("notes")}
                      className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer select-none hover:bg-muted/60"
                    >
                      <span className="inline-flex items-center gap-1">
                        Notes
                        <span className={sortKey === "notes" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                          {sortKey === "notes" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                        </span>
                      </span>
                    </th>
                    <th className="px-3 py-2.5" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {sorted.map((e) => (
                    <tr key={e.id} className="hover:bg-muted/20">
                      <td className="px-3 py-3 text-xs text-muted-foreground whitespace-nowrap">
                        <div>{fmtDatePKT(e.date)}</div>
                        <div className="text-[10px]">{fmtTimePKT(e.date)}</div>
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums">
                        {fmt(e.buffaloMilk)}{" "}
                        <span className="text-xs text-muted-foreground">L</span>
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums">
                        {fmt(e.cowMilk)}{" "}
                        <span className="text-xs text-muted-foreground">L</span>
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums">
                        {fmt(e.mixMilk)}{" "}
                        <span className="text-xs text-muted-foreground">L</span>
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums text-amber-700">
                        {fmt(e.boilingWaste)}{" "}
                        <span className="text-xs font-normal text-muted-foreground">L</span>
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums font-semibold text-purple-700">
                        {fmt(e.yoghurtProduced)}{" "}
                        <span className="text-xs font-normal text-muted-foreground">kg</span>
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums text-rose-700">
                        {fmt(e.productionWaste)}{" "}
                        <span className="text-xs font-normal text-muted-foreground">kg</span>
                      </td>
                      <td className="max-w-[120px] truncate px-3 py-3 text-xs text-muted-foreground">
                        {e.notes ?? "—"}
                      </td>
                      <td className="px-3 py-3 text-right">
                        <button
                          onClick={() => handleDelete(e.id)}
                          disabled={pending}
                          className="rounded p-1 text-muted-foreground hover:bg-rose-50 hover:text-rose-600 transition-colors"
                          title="Delete batch"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

