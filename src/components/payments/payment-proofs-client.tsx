"use client";

import { useState, useMemo, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Check, X, Image as ImageIcon, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { reviewPaymentProof, type PaymentProofsData } from "@/app/(dashboard)/payments/payment-proofs/actions";
import { fmtDatePKT, fmtTimePKT } from "@/lib/pkt";

function fmt(n: number) {
  return "Rs " + Math.round(n).toLocaleString("en-PK");
}

const STATUS_CLS: Record<string, string> = {
  PENDING:  "bg-amber-100 text-amber-700",
  APPROVED: "bg-emerald-100 text-emerald-700",
  REJECTED: "bg-rose-100 text-rose-700",
};

export function PaymentProofsClient({ data }: { data: PaymentProofsData }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  function handleSort(key: string) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  }

  const sorted = useMemo(() => {
    if (!sortKey) return data.rows;
    return [...data.rows].sort((a, b) => {
      const av = (a as Record<string, unknown>)[sortKey];
      const bv = (b as Record<string, unknown>)[sortKey];
      if (typeof av === "number" && typeof bv === "number")
        return sortDir === "asc" ? av - bv : bv - av;
      const as_ = String(av ?? ""), bs_ = String(bv ?? "");
      return sortDir === "asc" ? as_.localeCompare(bs_) : bs_.localeCompare(as_);
    });
  }, [data.rows, sortKey, sortDir]);

  function review(id: string, approve: boolean) {
    const note = approve
      ? undefined
      : (window.prompt("Reason for rejecting (optional):") ?? undefined);
    if (approve && !window.confirm("Approve this proof? A real payment will be recorded against the customer's bill.")) return;
    setBusyId(id);
    start(async () => {
      const res = await reviewPaymentProof(id, approve, note);
      setBusyId(null);
      if (res.ok) { toast.success(approve ? "Payment recorded." : "Proof rejected."); router.refresh(); }
      else toast.error(res.error);
    });
  }

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <p className="text-xs text-muted-foreground">
        {data.pendingCount} pending · {data.rows.length} shown (last 30 days)
      </p>
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full border-collapse text-xs">
          <thead className="bg-muted/40">
            <tr>
              <th
                onClick={() => handleSort("createdAt")}
                className="border-b border-border px-3 py-2 text-left text-[10px] font-medium uppercase tracking-wide text-muted-foreground whitespace-nowrap cursor-pointer select-none hover:bg-muted/60"
              >
                <span className="inline-flex items-center gap-1">
                  Submitted
                  <span className={sortKey === "createdAt" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                    {sortKey === "createdAt" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                  </span>
                </span>
              </th>
              <th
                onClick={() => handleSort("customerName")}
                className="border-b border-border px-3 py-2 text-left text-[10px] font-medium uppercase tracking-wide text-muted-foreground whitespace-nowrap cursor-pointer select-none hover:bg-muted/60"
              >
                <span className="inline-flex items-center gap-1">
                  Customer
                  <span className={sortKey === "customerName" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                    {sortKey === "customerName" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                  </span>
                </span>
              </th>
              <th
                onClick={() => handleSort("amount")}
                className="border-b border-border px-3 py-2 text-right text-[10px] font-medium uppercase tracking-wide text-muted-foreground whitespace-nowrap cursor-pointer select-none hover:bg-muted/60"
              >
                <span className="inline-flex items-center justify-end gap-1">
                  Amount
                  <span className={sortKey === "amount" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                    {sortKey === "amount" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                  </span>
                </span>
              </th>
              <th
                onClick={() => handleSort("method")}
                className="border-b border-border px-3 py-2 text-left text-[10px] font-medium uppercase tracking-wide text-muted-foreground whitespace-nowrap cursor-pointer select-none hover:bg-muted/60"
              >
                <span className="inline-flex items-center gap-1">
                  Method
                  <span className={sortKey === "method" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                    {sortKey === "method" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                  </span>
                </span>
              </th>
              <th
                onClick={() => handleSort("date")}
                className="border-b border-border px-3 py-2 text-left text-[10px] font-medium uppercase tracking-wide text-muted-foreground whitespace-nowrap cursor-pointer select-none hover:bg-muted/60"
              >
                <span className="inline-flex items-center gap-1">
                  Paid on
                  <span className={sortKey === "date" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                    {sortKey === "date" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                  </span>
                </span>
              </th>
              <th className="border-b border-border px-3 py-2 text-left text-[10px] font-medium uppercase tracking-wide text-muted-foreground whitespace-nowrap">Proof</th>
              <th
                onClick={() => handleSort("status")}
                className="border-b border-border px-3 py-2 text-left text-[10px] font-medium uppercase tracking-wide text-muted-foreground whitespace-nowrap cursor-pointer select-none hover:bg-muted/60"
              >
                <span className="inline-flex items-center gap-1">
                  Status
                  <span className={sortKey === "status" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50"}>
                    {sortKey === "status" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
                  </span>
                </span>
              </th>
              <th className="border-b border-border px-3 py-2 text-left text-[10px] font-medium uppercase tracking-wide text-muted-foreground whitespace-nowrap"></th>
            </tr>
          </thead>
          <tbody>
            {data.rows.length === 0 ? (
              <tr><td colSpan={8} className="py-10 text-center text-sm text-muted-foreground">No payment proofs submitted.</td></tr>
            ) : sorted.map((p) => (
              <tr key={p.id} className="border-b border-border/50 hover:bg-muted/20">
                <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                  {fmtDatePKT(p.createdAt)}<span className="ml-1 text-[10px]">{fmtTimePKT(p.createdAt)}</span>
                </td>
                <td className="px-3 py-2">
                  <div className="font-medium">{p.customerName}</div>
                  <div className="text-[10px] text-muted-foreground">{p.customerCode}</div>
                </td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums whitespace-nowrap">{fmt(p.amount)}</td>
                <td className="px-3 py-2 whitespace-nowrap">{p.method}</td>
                <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{fmtDatePKT(p.date)}</td>
                <td className="px-3 py-2">
                  {p.screenshotUrl ? (
                    <a href={p.screenshotUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sky-700 hover:underline">
                      <ImageIcon className="size-3.5" /> View
                    </a>
                  ) : <span className="text-muted-foreground">—</span>}
                </td>
                <td className="px-3 py-2">
                  <span className={cn("inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold", STATUS_CLS[p.status] ?? STATUS_CLS.PENDING)}>{p.status}</span>
                  {p.status !== "PENDING" && p.reviewNote && <div className="mt-0.5 text-[10px] text-muted-foreground">{p.reviewNote}</div>}
                </td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  {p.status === "PENDING" ? (
                    <div className="flex justify-end gap-1.5">
                      <Button size="sm" className="h-7 text-[11px]" disabled={pending && busyId === p.id} onClick={() => review(p.id, true)}>
                        {pending && busyId === p.id ? <Loader2 className="size-3.5 animate-spin" /> : <><Check className="mr-1 size-3.5" /> Approve</>}
                      </Button>
                      <Button size="sm" variant="outline" className="h-7 text-[11px] text-rose-600 hover:bg-rose-50" disabled={pending && busyId === p.id} onClick={() => review(p.id, false)}>
                        <X className="mr-1 size-3.5" /> Reject
                      </Button>
                    </div>
                  ) : (
                    <span className="text-[11px] text-muted-foreground">{p.reviewedAt ? fmtDatePKT(p.reviewedAt) : "—"}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

