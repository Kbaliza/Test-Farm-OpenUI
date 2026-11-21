"use client";

import { Fragment, useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { ChevronRight, Download, Copy } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { todayPKTString } from "@/lib/pkt";
import { getRiderSaleSummary, type RiderSaleSummary } from "@/app/(dashboard)/customers/rider-sale-summary/actions";
import { getRiderShiftReport, type RiderReportResult } from "@/app/(dashboard)/customers/rider-report/actions";

const UNIT_LABEL: Record<string, string> = { LITER: "ltr", KG: "Kg", PIECE: "pc" };
const fmt = (n: number) => (n % 1 === 0 ? n.toFixed(0) : n.toFixed(1));
const money = (n: number) => Math.round(n).toLocaleString("en-PK");

export function RiderSaleSummaryClient({ today }: { today: string }) {
  const [date, setDate] = useState(today);
  const [data, setData] = useState<RiderSaleSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const [expanded, setExpanded] = useState<Record<string, RiderReportResult | "loading">>({});
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!date) return;
    let cancelled = false;
    setLoading(true);
    setExpanded({});
    getRiderSaleSummary(date)
      .then((r) => { if (!cancelled) setData(r); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [date, tick]);

  function toggle(shiftId: string) {
    setExpanded((m) => {
      const next = { ...m };
      if (next[shiftId]) { delete next[shiftId]; return next; }
      next[shiftId] = "loading";
      return next;
    });
    if (!expanded[shiftId]) {
      start(async () => {
        const rep = await getRiderShiftReport(shiftId, date);
        setExpanded((m) => ({ ...m, [shiftId]: rep }));
      });
    }
  }

  function buildCsv(): string {
    if (!data) return "";
    const cols = ["Shift", ...data.products.map((p) => `${p.name} (${UNIT_LABEL[p.unit] ?? ""})`), "Sale", "Cash", "Net Receivings"];
    const esc = (v: string | number) => { const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = [cols.map(esc).join(",")];
    for (const r of data.rows) {
      lines.push([r.shiftName, ...data.products.map((p) => r.byProduct[p.id] ?? 0), Math.round(r.sale), Math.round(r.cash), Math.round(r.netReceivings)].map(esc).join(","));
    }
    lines.push(["Total", ...data.products.map((p) => data.totals.byProduct[p.id] ?? 0), Math.round(data.totals.sale), Math.round(data.totals.cash), Math.round(data.totals.netReceivings)].map(esc).join(","));
    return lines.join("\n");
  }

  function downloadCsv() {
    const csv = buildCsv();
    if (!csv) return;
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `rider-sale-summary-${date}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function copyCsv() {
    const csv = buildCsv();
    if (!csv) return;
    try { await navigator.clipboard.writeText(csv); toast.success("Copied to clipboard."); }
    catch { toast.error("Could not copy."); }
  }

  const products = data?.products ?? [];
  const hasRows = (data?.rows.length ?? 0) > 0;

  return (
    <div className="space-y-4 p-4 sm:p-6">
      {/* Controls */}
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-card p-4">
        <div>
          <Label className="text-xs">Date</Label>
          <Input type="date" className="mt-1 w-44" value={date} max={todayPKTString()} onChange={(e) => setDate(e.target.value)} />
        </div>
        <Button size="sm" onClick={() => setTick((t) => t + 1)} disabled={loading}>Get Result</Button>
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="outline" onClick={copyCsv} disabled={!hasRows}><Copy className="mr-1 size-3.5" /> Copy</Button>
          <Button size="sm" variant="outline" onClick={downloadCsv} disabled={!hasRows}><Download className="mr-1 size-3.5" /> CSV</Button>
        </div>
      </div>

      {loading ? (
        <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
      ) : !hasRows ? (
        <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No rider sales for this date.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-2 py-2" />
                <th className="px-3 py-2 font-medium">Shifts</th>
                {products.map((p) => (
                  <th key={p.id} className="px-3 py-2 text-right font-medium whitespace-nowrap">{p.name} <span className="text-[10px]">({UNIT_LABEL[p.unit] ?? ""})</span></th>
                ))}
                <th className="px-3 py-2 text-right font-medium">Sale</th>
                <th className="px-3 py-2 text-right font-medium">Cash</th>
                <th className="px-3 py-2 text-right font-medium whitespace-nowrap">Net Receivings</th>
                <th className="px-3 py-2 text-right font-medium">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data!.rows.map((r) => {
                const exp = expanded[r.shiftId];
                return (
                  <Fragment key={r.shiftId}>
                    <tr className="align-middle">
                      <td className="px-2 py-2">
                        <button onClick={() => toggle(r.shiftId)} className="rounded p-1 text-muted-foreground hover:bg-muted" aria-label="Expand">
                          <ChevronRight className={cn("size-4 transition-transform", exp && "rotate-90")} />
                        </button>
                      </td>
                      <td className="px-3 py-2">
                        <div className="font-medium">{r.shiftName}</div>
                        {r.riderName && <div className="text-[11px] text-muted-foreground">{r.riderName}</div>}
                      </td>
                      {products.map((p) => (
                        <td key={p.id} className="px-3 py-2 text-right tabular-nums">{fmt(r.byProduct[p.id] ?? 0)}</td>
                      ))}
                      <td className="px-3 py-2 text-right font-medium tabular-nums">{money(r.sale)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{money(r.cash)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{money(r.netReceivings)}</td>
                      <td className="px-3 py-2 text-right">
                        <Link
                          href={`/customers/rider-report?rider=${r.riderId ?? ""}&shift=${r.shiftId}&date=${date}`}
                          className="inline-flex items-center rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                        >
                          Detail
                        </Link>
                      </td>
                    </tr>
                    {exp && (
                      <tr>
                        <td />
                        <td colSpan={products.length + 5} className="px-3 pb-3">
                          {exp === "loading" ? (
                            <p className="py-2 text-xs text-muted-foreground">Loading customers…</p>
                          ) : !exp.ok || exp.rows.length === 0 ? (
                            <p className="py-2 text-xs text-muted-foreground">No customers for this shift.</p>
                          ) : (
                            <div className="rounded-lg border border-border bg-muted/20">
                              <table className="w-full text-xs">
                                <thead className="text-left text-[11px] text-muted-foreground">
                                  <tr>
                                    <th className="px-3 py-1.5 font-medium">Customer</th>
                                    <th className="px-3 py-1.5 font-medium">Delivered</th>
                                    <th className="px-3 py-1.5 text-right font-medium">Cash</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-border/60">
                                  {exp.rows.map((cr) => (
                                    <tr key={cr.customerId}>
                                      <td className="px-3 py-1.5">{cr.name} <span className="text-[10px] text-muted-foreground">{cr.customerCode}</span></td>
                                      <td className="px-3 py-1.5">
                                        {cr.products.filter((p) => p.delivered > 0).map((p, i) => (
                                          <span key={i} className="mr-2 whitespace-nowrap">{p.productName}: {fmt(p.delivered)} {UNIT_LABEL[p.unit] ?? ""}</span>
                                        ))}
                                        {cr.deliveredTotal === 0 && <span className="text-muted-foreground">—</span>}
                                      </td>
                                      <td className="px-3 py-1.5 text-right tabular-nums">{cr.cashCollected != null ? money(cr.cashCollected) : "—"}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              {/* Total */}
              <tr className="border-t-2 border-border bg-muted/30 font-semibold">
                <td />
                <td className="px-3 py-2">Total</td>
                {products.map((p) => (
                  <td key={p.id} className="px-3 py-2 text-right tabular-nums">{fmt(data!.totals.byProduct[p.id] ?? 0)}</td>
                ))}
                <td className="px-3 py-2 text-right tabular-nums">{money(data!.totals.sale)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{money(data!.totals.cash)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{money(data!.totals.netReceivings)}</td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
