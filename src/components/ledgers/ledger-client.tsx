"use client";

import { useState, useTransition, useMemo, useEffect, useRef, type ReactNode } from "react";
import { toast } from "sonner";
import { ChevronsUpDown, Download, Search, ArrowUp, ArrowDown, Undo2, CalendarDays } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  getLedgerData,
  getBilledReturns,
  type LedgerSelectors,
  type LedgerData,
  type LedgerRow,
  type BilledReturn,
} from "@/app/(dashboard)/ledgers/actions";
import { todayPKTString, yesterdayPKTString, addDaysToDateStr } from "@/lib/pkt";
import { useAppRefresh } from "@/lib/use-app-refresh";
import { RangeCalendar } from "@/components/ui/range-calendar";
import { FARM_OWNERS } from "@/lib/farm-owners";

// ── constants ─────────────────────────────────────────────────────────────────

const TYPE_OPTIONS = [
  { value: "customer", label: "Customer" },
  { value: "product",  label: "Product / Inventory" },
  { value: "head",     label: "Payment Head" },
  { value: "vendor",   label: "Vendor" },
  { value: "retail",   label: "Retail Mart" },
  { value: "wastage",  label: "Wastage" },
  { value: "employee", label: "Employee Salary" },
  { value: "expense",  label: "Expense Category" },
  { value: "owner",    label: "Owner (Personal Account)" },
  { value: "farmsale", label: "Farm Sales Buyer" },
];

const HEAD_OPTIONS: { id: string; name: string; sub?: string }[] = [
  // Kept FIRST so it is the default when you switch to Payment Head. The id is the
  // ALL_HEADS sentinel from lib/head-balances, not a real head.
  { id: "__all_heads__", name: "All Accounts", sub: "every head combined" },
  { id: "RIDER_CASH", name: "Rider Cash" },
  { id: "HBL",        name: "HBL" },
  { id: "MEEZAN",     name: "Meezan", sub: "owed to owners" },
  { id: "JAZZCASH",   name: "JazzCash" },
  { id: "EASYPAISA",  name: "Easypaisa" },
  { id: "CASH",       name: "Cash" },
];

const BADGE_COLORS: Record<string, string> = {
  blue:   "bg-blue-50 text-blue-700",
  green:  "bg-emerald-50 text-emerald-700",
  red:    "bg-rose-50 text-rose-700",
  amber:  "bg-amber-50 text-amber-700",
  purple: "bg-violet-50 text-violet-700",
  gray:   "bg-slate-100 text-slate-600",
};

type Preset = "today" | "yesterday" | "7" | "15" | "30" | "month" | "all" | "custom";
const PRESETS: [Preset, string][] = [
  ["today", "Today"], ["yesterday", "Yesterday"], ["7", "7 days"], ["15", "15 days"],
  ["30", "30 days"], ["month", "This month"], ["all", "All"],
];

/** The range a preset stands for. "All" is no start date — the whole history. */
function presetRange(p: Preset): [string, string] {
  const today = todayPKTString();
  if (p === "today") return [today, today];
  if (p === "yesterday") { const y = yesterdayPKTString(); return [y, y]; }
  if (p === "7") return [addDaysToDateStr(today, -6), today];
  if (p === "15") return [addDaysToDateStr(today, -14), today];
  if (p === "30") return [addDaysToDateStr(today, -29), today];
  if (p === "month") return [today.slice(0, 8) + "01", today];
  return ["", today];
}

// ── categories: what each row IS, in words that fit the ledger ─────────────────
//
// A product row carries its category from the server (from the movement that wrote
// it). For the money ledgers it is simply which side the row sits on, named the way
// that ledger already names its columns.

type Cat = { key: string; label: string; dot: string; pill: string };
const CAT_STYLE = {
  in:       { dot: "bg-emerald-600", pill: "bg-emerald-50 text-emerald-700" },
  out:      { dot: "bg-blue-600",    pill: "bg-blue-50 text-blue-700" },
  returned: { dot: "bg-teal-600",    pill: "bg-teal-50 text-teal-700" },
  wasted:   { dot: "bg-rose-600",    pill: "bg-rose-50 text-rose-700" },
  billed:   { dot: "bg-rose-600",    pill: "bg-rose-50 text-rose-700" },
  paid:     { dot: "bg-emerald-600", pill: "bg-emerald-50 text-emerald-700" },
  earned:   { dot: "bg-rose-600",    pill: "bg-rose-50 text-rose-700" },
};
const cat = (key: keyof typeof CAT_STYLE, label: string): Cat => ({ key, label, ...CAT_STYLE[key] });

function categoriesFor(type: string): Cat[] {
  if (type === "product") return [cat("in", "In"), cat("out", "Out"), cat("returned", "Returned"), cat("wasted", "Wasted")];
  if (type === "customer" || type === "vendor" || type === "retail") return [cat("billed", "Billed"), cat("paid", "Paid")];
  if (type === "head") return [cat("in", "In"), cat("out", "Out")];
  if (type === "employee") return [cat("earned", "Earned"), cat("paid", "Paid / deducted")];
  return [];
}

function rowCategory(type: string, r: LedgerRow): string | null {
  if (r.id === "opening") return null;
  if (type === "product") return r.category ?? null;
  if (type === "customer" || type === "vendor" || type === "retail") return r.debit > 0 ? "billed" : r.credit > 0 ? "paid" : null;
  if (type === "head") return r.credit > 0 ? "in" : r.debit > 0 ? "out" : null;
  if (type === "employee") return r.debit > 0 ? "earned" : r.credit > 0 ? "paid" : null;
  return null;
}

/** How each ledger names its two sides in the totals footer. */
function sideLabels(type: string): { debit?: string; credit?: string; money: boolean } {
  switch (type) {
    case "product":  return { credit: "In", debit: "Out", money: false };
    case "customer":
    case "vendor":
    case "retail":   return { debit: "Billed", credit: "Paid", money: true };
    case "head":     return { credit: "In", debit: "Out", money: true };
    case "employee": return { debit: "Earned", credit: "Paid / deducted", money: true };
    case "wastage":  return { debit: "Wasted value", money: true };
    case "expense":  return { debit: "Spent", money: true };
    case "owner":    return { credit: "Put in", money: true };
    case "farmsale": return { debit: "Sales", money: true };
  }
  return { money: true };
}

// ── helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number) {
  return Math.abs(n).toLocaleString("en-PK");
}

function fmtQty(n: number) {
  return (Math.round(n * 1000) / 1000).toLocaleString("en-PK");
}

function fmtDateTime(iso: string) {
  const d = new Date(iso);
  return {
    date: d.toLocaleDateString("en-GB", { timeZone: "Asia/Karachi", day: "2-digit", month: "short", year: "2-digit" }),
    time: d.toLocaleTimeString("en-US",  { timeZone: "Asia/Karachi", hour: "2-digit", minute: "2-digit" }),
  };
}

const unitOf = (rows: LedgerRow[]) => rows.find((r) => r.qty)?.qty?.split(" ")[1] ?? "";

// ── small pieces ──────────────────────────────────────────────────────────────

// Over-the-Counter line detail shown under a ledger row's description: the
// products transacted plus a cash/credit chip.
function LedgerDetail({ products, mode }: { products?: string; mode?: "cash" | "credit" }) {
  if (!products && !mode) return null;
  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
      {mode ? (
        <span
          className={`inline-block rounded px-1 py-px text-[9px] font-semibold uppercase tracking-wide ${
            mode === "credit" ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"
          }`}
        >
          {mode}
        </span>
      ) : null}
      {products ? <span className="text-[10px] text-muted-foreground">{products}</span> : null}
    </div>
  );
}

const Dash = () => <span className="text-muted-foreground/60">—</span>;

function WhenCell({ iso }: { iso: string }) {
  const { date, time } = fmtDateTime(iso);
  return <><div className="font-semibold">{date}</div><div className="text-[11px] text-muted-foreground">{time}</div></>;
}

function CatPill({ c }: { c?: Cat }) {
  if (!c) return <Dash />;
  return <span className={cn("rounded-full px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-wide", c.pill)}>{c.label}</span>;
}

// ── columns per ledger type — the same columns each ledger always had ─────────

type Col = {
  key: string;
  label: string;
  right?: boolean;
  cell: (r: LedgerRow) => ReactNode;
  sort?: (r: LedgerRow) => string | number;
  className?: string;
};

const WHEN: Col = { key: "when", label: "Date / Time", cell: (r) => <WhenCell iso={r.date} />, sort: (r) => r.date, className: "whitespace-nowrap" };

function columnsFor(type: string, cats: Cat[], unit = ""): Col[] {
  const catOf = (r: LedgerRow) => cats.find((c) => c.key === rowCategory(type, r));
  const by: Col = { key: "by", label: "By", cell: (r) => <span className="text-muted-foreground">{r.by ?? "—"}</span>, sort: (r) => (r.by ?? "").toLowerCase() };

  if (type === "product") {
    return [
      WHEN,
      { key: "desc", label: "Description", cell: (r) => <span className="font-medium">{r.description}</span>, sort: (r) => r.description.toLowerCase(), className: "min-w-[240px] whitespace-normal" },
      { key: "cat", label: "Category", cell: (r) => <CatPill c={catOf(r)} />, sort: (r) => rowCategory(type, r) ?? "" },
      // The unit sits in the heading, not on every number: "−5,906.6 L" wrapped onto
      // two lines on a phone.
      { key: "in", label: `In (+)${unit ? ` ${unit}` : ""}`, right: true, className: "whitespace-nowrap", cell: (r) => (r.credit > 0 ? <span className="font-semibold text-emerald-700">+{fmtQty(r.credit)}</span> : <Dash />), sort: (r) => r.credit },
      { key: "out", label: `Out (−)${unit ? ` ${unit}` : ""}`, right: true, className: "whitespace-nowrap", cell: (r) => (r.debit > 0 ? <span className="font-semibold text-rose-700">−{fmtQty(r.debit)}</span> : <Dash />), sort: (r) => r.debit },
      { key: "bal", label: `Balance${unit ? ` ${unit}` : ""}`, right: true, className: "whitespace-nowrap", cell: (r) => <span className={cn("font-semibold", r.balance < 0 ? "text-rose-700" : "text-foreground")}>{fmtQty(r.balance)}</span>, sort: (r) => r.balance },
      by,
    ];
  }
  if (type === "customer") {
    return [
      WHEN,
      {
        key: "desc", label: "Description", className: "min-w-[240px] whitespace-normal", sort: (r) => r.description.toLowerCase(),
        cell: (r) => {
          const qtyRate = [r.qty, r.rate].filter((x) => x && x !== "—").join(" · ");
          return (
            <>
              <p className="font-medium">{r.description}</p>
              {qtyRate ? <p className="mt-0.5 text-[10px] text-muted-foreground">{qtyRate}</p> : null}
              <LedgerDetail products={r.products} mode={r.mode} />
            </>
          );
        },
      },
      { key: "cat", label: "Category", cell: (r) => <CatPill c={catOf(r)} />, sort: (r) => rowCategory(type, r) ?? "" },
      { key: "debit", label: "Billed", right: true, cell: (r) => (r.debit > 0 ? <span className="font-semibold text-rose-700">Rs {fmt(r.debit)}</span> : <Dash />), sort: (r) => r.debit },
      { key: "credit", label: "Paid", right: true, cell: (r) => (r.credit > 0 ? <span className="font-semibold text-emerald-700">Rs {fmt(r.credit)}</span> : <Dash />), sort: (r) => r.credit },
      { key: "note", label: "Notes", cell: (r) => <span className="text-muted-foreground">{r.note ?? "—"}</span>, className: "max-w-[180px] whitespace-normal" },
      {
        key: "bal", label: "Running Balance", right: true, sort: (r) => r.balance,
        cell: (r) => <span className={cn("font-semibold", r.balance > 0 ? "text-rose-700" : r.balance === 0 ? "text-muted-foreground" : "text-emerald-700")}>Rs {fmt(r.balance)}</span>,
      },
    ];
  }
  if (type === "head") {
    return [
      WHEN,
      { key: "desc", label: "Description", cell: (r) => <span className="font-medium">{r.description}</span>, sort: (r) => r.description.toLowerCase(), className: "min-w-[220px] whitespace-normal" },
      { key: "cat", label: "Category", cell: (r) => <CatPill c={catOf(r)} />, sort: (r) => rowCategory(type, r) ?? "" },
      { key: "ref", label: "Reference", cell: (r) => <span className="text-muted-foreground">{r.reference ?? "—"}</span>, sort: (r) => (r.reference ?? "").toLowerCase() },
      { key: "credit", label: "In (+)", right: true, cell: (r) => (r.credit > 0 ? <span className="font-semibold text-emerald-700">+ Rs {fmt(r.credit)}</span> : <Dash />), sort: (r) => r.credit },
      { key: "debit", label: "Out (−)", right: true, cell: (r) => (r.debit > 0 ? <span className="font-semibold text-rose-700">− Rs {fmt(r.debit)}</span> : <Dash />), sort: (r) => r.debit },
      { key: "bal", label: "Balance", right: true, cell: (r) => <span className="font-semibold text-blue-700">Rs {fmt(r.balance)}</span>, sort: (r) => r.balance },
    ];
  }
  if (type === "vendor" || type === "retail") {
    // A mart statement has the same shape as a vendor's: dated rows, debit when they
    // owe us, credit when they pay, running balance.
    return [
      WHEN,
      {
        key: "desc", label: "Description", className: "min-w-[260px] whitespace-normal", sort: (r) => r.description.toLowerCase(),
        cell: (r) => <><p className="font-medium">{r.description}</p><LedgerDetail products={r.products} mode={r.mode} /></>,
      },
      { key: "cat", label: "Category", cell: (r) => <CatPill c={catOf(r)} />, sort: (r) => rowCategory(type, r) ?? "" },
      { key: "debit", label: "Billed", right: true, cell: (r) => (r.debit > 0 ? <span className="font-semibold text-rose-700">Rs {fmt(r.debit)}</span> : <Dash />), sort: (r) => r.debit },
      { key: "credit", label: "Paid", right: true, cell: (r) => (r.credit > 0 ? <span className="font-semibold text-emerald-700">Rs {fmt(r.credit)}</span> : <Dash />), sort: (r) => r.credit },
      { key: "bal", label: "Running Balance", right: true, cell: (r) => <span className={cn("font-semibold", r.balance > 0 ? "text-rose-700" : "text-muted-foreground")}>Rs {fmt(r.balance)}</span>, sort: (r) => r.balance },
      { key: "note", label: "Notes", cell: (r) => <span className="text-muted-foreground">{r.note ?? "—"}</span>, className: "max-w-[180px] whitespace-normal" },
    ];
  }
  if (type === "employee") {
    return [
      WHEN,
      { key: "desc", label: "Description", cell: (r) => <span className="font-medium">{r.description}</span>, sort: (r) => r.description.toLowerCase(), className: "min-w-[220px] whitespace-normal" },
      { key: "cat", label: "Category", cell: (r) => <CatPill c={catOf(r)} />, sort: (r) => rowCategory(type, r) ?? "" },
      {
        key: "amt", label: "Amount", right: true, sort: (r) => (r.debit > 0 ? r.debit : -r.credit),
        cell: (r) => {
          const isEarn = r.debit > 0;
          return <span className={cn("font-semibold", isEarn ? "text-rose-700" : "text-emerald-700")}>{isEarn ? "" : "−"} Rs {fmt(isEarn ? r.debit : r.credit)}</span>;
        },
      },
      { key: "note", label: "Note", cell: (r) => <span className="text-muted-foreground">{r.note ?? "—"}</span>, className: "max-w-[200px] whitespace-normal" },
      by,
    ];
  }
  if (type === "wastage") {
    return [
      WHEN,
      {
        key: "desc", label: "Description", className: "min-w-[220px] whitespace-normal", sort: (r) => r.description.toLowerCase(),
        cell: (r) => <span className="font-medium">{r.description}{r.by ? <span className="font-normal text-muted-foreground"> · {r.by}</span> : null}</span>,
      },
      { key: "qty", label: "Qty", right: true, cell: (r) => <span className="text-muted-foreground">{r.qty ?? "—"}</span> },
      { key: "rate", label: "Rate", right: true, cell: (r) => <span className="text-muted-foreground">{r.rate ?? "—"}</span> },
      { key: "debit", label: "Value", right: true, cell: (r) => <span className="font-semibold text-rose-700">Rs {fmt(r.debit)}</span>, sort: (r) => r.debit },
      { key: "bal", label: "Running Total", right: true, cell: (r) => <span className="font-semibold text-rose-700">Rs {fmt(r.balance)}</span>, sort: (r) => r.balance },
    ];
  }
  if (type === "expense") {
    return [
      WHEN,
      { key: "desc", label: "Description", cell: (r) => <span className="font-medium">{r.description}</span>, sort: (r) => r.description.toLowerCase(), className: "min-w-[220px] whitespace-normal" },
      { key: "debit", label: "Amount", right: true, cell: (r) => <span className="font-semibold text-rose-700">Rs {fmt(r.debit)}</span>, sort: (r) => r.debit },
      { key: "head", label: "Head", cell: (r) => <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700">{r.head ?? "—"}</span>, sort: (r) => (r.head ?? "").toLowerCase() },
      { key: "bal", label: "Running Total", right: true, cell: (r) => <span className="font-semibold text-blue-700">Rs {fmt(r.balance)}</span>, sort: (r) => r.balance },
    ];
  }
  if (type === "owner") {
    // Money an owner put in from their own pocket. Every row is money IN, so there
    // is no debit column and the running total is simply what the farm owes them.
    return [
      WHEN,
      { key: "desc", label: "What it was for", cell: (r) => <span className="font-medium">{r.description}</span>, sort: (r) => r.description.toLowerCase(), className: "min-w-[240px] whitespace-normal" },
      { key: "credit", label: "Amount Put In", right: true, cell: (r) => (r.credit > 0 ? <span className="font-semibold text-emerald-700">Rs {fmt(r.credit)}</span> : <Dash />), sort: (r) => r.credit },
      { key: "bal", label: "Total Owed", right: true, cell: (r) => <span className="font-semibold text-violet-700">Rs {fmt(r.balance)}</span>, sort: (r) => r.balance },
      { key: "ref", label: "Credited To", cell: (r) => <span className="text-muted-foreground">{r.reference ?? "—"}</span> },
      { key: "by", label: "Recorded By", cell: (r) => <span className="text-muted-foreground">{r.by ?? "—"}</span>, sort: (r) => (r.by ?? "").toLowerCase() },
    ];
  }
  if (type === "farmsale") {
    // Every farm sale is paid in full, so the last money column is a cumulative
    // total of business done — "Running total", not "Balance".
    return [
      WHEN,
      {
        key: "desc", label: "Item", className: "min-w-[220px] whitespace-normal", sort: (r) => r.description.toLowerCase(),
        cell: (r) => <><p className="font-medium">{r.description}</p>{r.note && <p className="text-[11px] text-muted-foreground">{r.note}</p>}</>,
      },
      { key: "ref", label: "Invoice / Category", cell: (r) => <span className="text-muted-foreground">{r.reference ?? "—"}</span> },
      { key: "qty", label: "Qty", right: true, cell: (r) => <span className="text-muted-foreground">{r.qty ?? "—"}</span> },
      { key: "rate", label: "Rate", right: true, cell: (r) => <span className="text-muted-foreground">{r.rate ?? "—"}</span> },
      { key: "debit", label: "Amount", right: true, cell: (r) => (r.debit > 0 ? <span className="font-semibold text-emerald-700">Rs {fmt(r.debit)}</span> : <Dash />), sort: (r) => r.debit },
      { key: "bal", label: "Running Total", right: true, cell: (r) => <span className="font-semibold text-violet-700">Rs {fmt(r.balance)}</span>, sort: (r) => r.balance },
      { key: "head", label: "Paid Into", cell: (r) => <span className="text-muted-foreground">{r.head ?? "—"}</span> },
    ];
  }
  return [WHEN, { key: "desc", label: "Description", cell: (r) => r.description }];
}

// ── CSV export ────────────────────────────────────────────────────────────────

function exportCSV(data: LedgerData) {
  const keys: (keyof LedgerRow)[] = ["date","description","debit","credit","balance","qty","rate","reference","head","note","by","products","mode"];
  const csvRows = [
    keys.join(","),
    ...data.rows.map((r) =>
      keys.map((k) => `"${(r[k] ?? "").toString().replace(/"/g, '""')}"`).join(",")
    ),
  ];
  const blob = new Blob([csvRows.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `ledger-${data.entityInfo.name.replace(/\s+/g, "-")}.csv`;
  a.click();
}

// ── PDF export (print-to-PDF via a formatted print window) ───────────────────

function exportPDF(data: LedgerData) {
  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleDateString("en-GB", { timeZone: "Asia/Karachi", day: "2-digit", month: "short", year: "numeric" });

  const tableRows = data.rows.map((r) => `
    <tr>
      <td>${fmtDate(r.date)}</td>
      <td>${(r.description ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;")}</td>
      <td class="num">${r.debit  > 0 ? "Rs " + r.debit.toLocaleString("en-PK")  : "—"}</td>
      <td class="num">${r.credit > 0 ? "Rs " + r.credit.toLocaleString("en-PK") : "—"}</td>
      <td class="num">Rs ${Math.abs(r.balance).toLocaleString("en-PK")}</td>
      ${r.head ? `<td>${r.head}</td>` : ""}
    </tr>`).join("");

  const hasHead = data.rows.some((r) => r.head);
  const headCol = hasHead ? "<th>Head</th>" : "";

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Ledger — ${data.entityInfo.name}</title>
<style>
  body { font-family: Arial, sans-serif; font-size: 11px; margin: 20px; color: #111; }
  h1 { font-size: 16px; margin-bottom: 2px; }
  .meta { color: #666; font-size: 10px; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; }
  th { background: #f5f5f5; text-align: left; padding: 6px 8px; border-bottom: 2px solid #ddd; font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; }
  td { padding: 5px 8px; border-bottom: 1px solid #eee; }
  .num { text-align: right; }
  tr:nth-child(even) td { background: #fafafa; }
  .summary { display: flex; gap: 24px; margin-bottom: 16px; }
  .card { border: 1px solid #ddd; border-radius: 6px; padding: 8px 14px; min-width: 100px; }
  .card-label { font-size: 9px; color: #888; text-transform: uppercase; }
  .card-value { font-size: 14px; font-weight: bold; margin-top: 2px; }
  @media print { @page { margin: 12mm; } }
</style></head><body>
<h1>${data.entityInfo.name} — Ledger</h1>
<p class="meta">${data.entityInfo.meta} &nbsp;·&nbsp; Generated ${new Date().toLocaleDateString("en-GB")}</p>
<div class="summary">${data.summary.map((s) =>
  `<div class="card"><div class="card-label">${s.label}</div><div class="card-value">${s.value}</div></div>`
).join("")}</div>
<table>
  <thead><tr><th>Date</th><th>Description</th><th>Debit</th><th>Credit</th><th>Balance</th>${headCol}</tr></thead>
  <tbody>${tableRows}</tbody>
</table>
</body></html>`;

  const w = window.open("", "_blank");
  if (!w) return;
  w.document.write(html);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 500);
}

// ── Searchable entity select ──────────────────────────────────────────────────

function SearchableSelect({
  options,
  value,
  onChange,
  placeholder = "— select —",
}: {
  options: { id: string; label: string; sub?: string }[];
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const selected = options.find((o) => o.id === value) ?? null;
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? options.filter(
          (o) =>
            o.label.toLowerCase().includes(q) ||
            (o.sub?.toLowerCase().includes(q) ?? false)
        )
      : options;
    return list.slice(0, 50);
  }, [options, query]);

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-9 min-w-[230px] items-center justify-between gap-2 rounded-md border border-border bg-background px-3 text-xs font-semibold focus:outline-none focus:ring-1 focus:ring-ring"
        >
          <span className={cn("truncate", !selected && "font-normal text-muted-foreground")}>
            {selected
              ? selected.label + (selected.sub ? ` — ${selected.sub}` : "")
              : placeholder}
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] min-w-[260px] p-0">
        <div className="relative border-b border-border p-2">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            className="h-8 pl-7 text-xs"
          />
        </div>
        <div className="max-h-60 overflow-y-auto p-1">
          {matches.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs text-muted-foreground">
              No matches.
            </p>
          ) : (
            matches.map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => {
                  onChange(o.id);
                  setOpen(false);
                  setQuery("");
                }}
                className={cn(
                  "flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted",
                  value === o.id && "bg-muted"
                )}
              >
                <span className="truncate font-medium">{o.label}</span>
                {o.sub ? (
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {o.sub}
                  </span>
                ) : null}
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ── summary + header ──────────────────────────────────────────────────────────

function SummaryCards({ cards }: { cards: { label: string; value: string; sub: string; color: string }[] }) {
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
      {cards.map((c) => (
        <div key={c.label} className="rounded-xl border border-border border-l-4 bg-card p-3.5 shadow-sm" style={{ borderLeftColor: c.color }}>
          <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">{c.label}</p>
          <p className="mt-1.5 break-words text-xl font-bold leading-tight tabular-nums" style={{ color: c.color }}>{c.value}</p>
          <p className="mt-1.5 text-[11px] text-muted-foreground">{c.sub}</p>
        </div>
      ))}
    </div>
  );
}

function EntityHeader({
  initials, name, meta, avatarBg, avatarTc, chips,
}: {
  initials: string; name: string; meta: string; avatarBg: string; avatarTc: string; chips: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3.5 rounded-xl border border-border bg-card px-4 py-3.5 shadow-sm">
      <div className="flex size-11 shrink-0 items-center justify-center rounded-lg text-sm font-bold" style={{ background: avatarBg, color: avatarTc }}>
        {initials}
      </div>
      <div className="min-w-0">
        <p className="text-base font-bold">{name}</p>
        <p className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
          <span className="inline-block size-1.5 rounded-full bg-emerald-600" /> {meta}
        </p>
      </div>
      <div className="flex flex-1 flex-wrap justify-end gap-2">{chips}</div>
    </div>
  );
}

function Th({
  k, label, right, sortable = true, sortKey, sortDir, onSort,
}: {
  k: string; label: string; right?: boolean; sortable?: boolean;
  sortKey: string; sortDir: 1 | -1; onSort: (k: string) => void;
}) {
  return (
    <th
      onClick={sortable ? () => onSort(k) : undefined}
      className={cn(
        "sticky top-0 whitespace-nowrap bg-muted/50 px-4 py-2.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground",
        right ? "text-right" : "text-left",
        sortable && "cursor-pointer select-none hover:text-foreground",
      )}
    >
      {label}
      {sortable && sortKey === k && (sortDir === 1 ? <ArrowUp className="ml-1 inline size-3 text-primary" /> : <ArrowDown className="ml-1 inline size-3 text-primary" />)}
    </th>
  );
}

// ── main client ───────────────────────────────────────────────────────────────

export function LedgerClient({
  selectors,
  initialType = "",
  initialEntityId = "",
  initialData = null,
}: {
  selectors: LedgerSelectors;
  initialType?: string;
  initialEntityId?: string;
  /** A ledger opened from a link, already loaded on the server (its whole history). */
  initialData?: LedgerData | null;
}) {
  const [type,     setType]     = useState(initialType);
  const [entityId, setEntityId] = useState(initialEntityId);
  const [preset,   setPreset]   = useState<Preset>("all");
  const [from,     setFrom]     = useState("");
  const [to,       setTo]       = useState(todayPKTString());
  const [calOpen,  setCalOpen]  = useState(false);
  const [data,     setData]     = useState<LedgerData | null>(initialData);
  const [loading,  startLoad]   = useTransition();

  // Table filters — all on what is already loaded; none of them re-queries.
  const [search,   setSearch]   = useState("");
  const [catKey,   setCatKey]   = useState("all");
  const [source,   setSource]   = useState("all");
  const [sortKey,  setSortKey]  = useState("when");
  const [sortDir,  setSortDir]  = useState<1 | -1>(1);

  // Billed Returns (product ledger only)
  const [billedOnly, setBilledOnly] = useState(false);
  const [billedProducts, setBilledProducts] = useState<string[]>(initialType === "product" && initialEntityId ? [initialEntityId] : []);
  const [billedRows, setBilledRows] = useState<BilledReturn[] | null>(null);
  const [billedLoading, startBilled] = useTransition();

  // Only the newest request may land: a slow answer for a range you have already
  // left must not overwrite the one you are looking at.
  const reqId = useRef(0);

  function fetchLedger(t: string, id: string, f: string, tt: string) {
    if (!t || !id) return;
    const mine = ++reqId.current;
    startLoad(async () => {
      const res = await getLedgerData(t, id, f || undefined, tt || undefined);
      if (mine !== reqId.current) return;
      if (res.ok) setData(res.data);
      else { setData(null); toast.error(res.error); }
    });
  }

  // Entity options for the currently selected type
  const entityOptions = useMemo(() => {
    if (type === "customer") return selectors.customers;
    if (type === "product")  return selectors.products;
    if (type === "head")     return HEAD_OPTIONS;
    if (type === "vendor")   return selectors.vendors;
    if (type === "retail")   return selectors.retailVendors;
    if (type === "wastage")  return [{ id: "__wastage__", name: "All wastage" }];
    if (type === "employee") return selectors.employees;
    if (type === "expense")  return selectors.expenseCategories;
    if (type === "owner")    return FARM_OWNERS.map((o) => ({ id: o.id, name: o.name, sub: "personal account" }));
    if (type === "farmsale") return selectors.farmSaleBuyers;
    return [];
  }, [type, selectors]);

  function resetTable() {
    setSearch(""); setCatKey("all"); setSource("all"); setSortKey("when"); setSortDir(1);
    setBilledOnly(false); setBilledRows(null);
  }

  function handleTypeChange(t: string) {
    setType(t);
    // Wastage is a single global view — no entity to pick, so it opens at once.
    const id = t === "wastage" ? "__wastage__" : "";
    setEntityId(id);
    setData(null);
    resetTable();
    if (id) fetchLedger(t, id, from, to);
  }

  function handleEntityChange(id: string) {
    setEntityId(id);
    setData(null);
    resetTable();
    setBilledProducts(type === "product" ? [id] : []);
    fetchLedger(type, id, from, to);
  }

  function applyRange(f: string, t: string, p: Preset) {
    setFrom(f); setTo(t); setPreset(p); setCalOpen(false);
    setBilledRows(null);
    fetchLedger(type, entityId, f, t);
  }

  // Topbar Refresh re-runs the currently open ledger so its rows/balances reflect
  // any new payments, sales, wastage, etc. recorded since it was loaded.
  useAppRefresh(() => {
    if (!type || !entityId) return;
    fetchLedger(type, entityId, from, to);
    setBilledRows(null);
  });

  // Billed Returns across the picked products. The ledger already carries the open
  // product's own, so that case needs no extra request.
  const billedKey = billedProducts.join(",");
  const ownOnly = billedProducts.length === 1 && billedProducts[0] === entityId;
  useEffect(() => {
    if (!billedOnly || type !== "product" || !data || ownOnly) return;
    let cancelled = false;
    startBilled(async () => {
      const res = await getBilledReturns(billedProducts, from || undefined, to || undefined);
      if (cancelled) return;
      if (res.ok) setBilledRows(res.rows);
      else toast.error(res.error);
    });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [billedOnly, billedKey, data, from, to, ownOnly]);
  const billedList = useMemo<BilledReturn[] | null>(
    () => (ownOnly ? data?.billedReturns ?? [] : billedRows),
    [ownOnly, data, billedRows],
  );

  const cats = useMemo(() => categoriesFor(data?.type ?? ""), [data?.type]);
  const columns = useMemo(() => (data ? columnsFor(data.type, cats, data.type === "product" ? unitOf(data.rows) : "") : []), [data, cats]);
  const sides = sideLabels(data?.type ?? "");

  const sources = useMemo(() => {
    if (!data) return [];
    return [...new Set(data.rows.map((r) => r.by).filter((b): b is string => !!b && b !== "—"))].sort((a, b) => a.localeCompare(b));
  }, [data]);

  const catCounts = useMemo(() => {
    const m: Record<string, number> = {};
    if (data) for (const r of data.rows) { const c = rowCategory(data.type, r); if (c) m[c] = (m[c] ?? 0) + 1; }
    return m;
  }, [data]);

  const shown = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    const list = data.rows.filter((r) => {
      if (catKey !== "all" && rowCategory(data.type, r) !== catKey) return false;
      if (source !== "all" && r.by !== source) return false;
      if (q) {
        const hay = [r.description, r.reference, r.by, r.note, r.products, r.head].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const col = columns.find((c) => c.key === sortKey);
    if (!col?.sort) return list;
    const s = col.sort;
    return list
      .map((r, i) => [r, i] as const)
      .sort((a, b) => {
        const va = s(a[0]), vb = s(b[0]);
        return va < vb ? -sortDir : va > vb ? sortDir : a[1] - b[1];
      })
      .map((x) => x[0]);
  }, [data, search, catKey, source, columns, sortKey, sortDir]);

  const billedShown = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = (billedList ?? []).filter((r) => !q || [r.customer, r.productName, r.reason, r.by].join(" ").toLowerCase().includes(q));
    const key = sortKey;
    const val = (r: BilledReturn): string | number =>
      key === "qty" ? r.qty : key === "reason" ? r.reason.toLowerCase() : key === "prod" ? r.productName.toLowerCase()
      : key === "by" ? r.by.toLowerCase() : key === "desc" ? r.customer.toLowerCase() : r.date;
    return list.map((r, i) => [r, i] as const)
      .sort((a, b) => { const va = val(a[0]), vb = val(b[0]); return va < vb ? -sortDir : va > vb ? sortDir : a[1] - b[1]; })
      .map((x) => x[0]);
  }, [billedList, search, sortKey, sortDir]);

  function sortBy(k: string) {
    if (sortKey === k) setSortDir((d) => (d === 1 ? -1 : 1));
    else { setSortKey(k); setSortDir(["in", "out", "bal", "debit", "credit", "amt", "qty"].includes(k) ? -1 : 1); }
  }

  const thProps = { sortKey, sortDir, onSort: sortBy };

  // Totals of what is on screen.
  const totDebit = shown.reduce((t, r) => t + r.debit, 0);
  const totCredit = shown.reduce((t, r) => t + r.credit, 0);
  const unit = data?.type === "product" ? unitOf(data.rows) : "";
  const money = (n: number) => (sides.money ? `Rs ${fmt(n)}` : `${fmtQty(n)} ${unit}`);

  const isProduct = data?.type === "product";
  const productName = (id: string) => selectors.products.find((p) => p.id === id)?.name ?? "Product";
  const billedCount = data?.billedReturns?.length ?? 0;

  // Billed Returns summary — every figure counted from the rows on screen.
  const billedSummary = useMemo(() => {
    const rows = billedShown;
    const byUnit: Record<string, number> = {};
    for (const r of rows) byUnit[r.unit] = (byUnit[r.unit] ?? 0) + r.qty;
    const qtyStr = Object.keys(byUnit).length ? Object.entries(byUnit).map(([u, q]) => `${fmtQty(q)} ${u}`).join(" · ") : "0";
    const unres = rows.filter((r) => /unresponsive/i.test(r.reason)).length;
    const refused = rows.filter((r) => /refused/i.test(r.reason)).length;
    const value = rows.reduce((t, r) => t + r.amount, 0);
    return {
      qtyStr,
      cards: [
        { label: "Billed returns", value: String(rows.length), sub: "in selected period", color: "#be123c" },
        { label: "Came back", value: qtyStr, sub: "billed, stock came back", color: "#047857" },
        { label: "Customer unresponsive", value: String(unres), sub: "no answer at the door", color: "#1d4ed8" },
        { label: "Customer refused", value: String(refused), sub: "refused delivery", color: "#b91c1c" },
        { label: "Other reasons", value: String(rows.length - unres - refused), sub: `billed value Rs ${fmt(value)}`, color: "#6b7280" },
      ],
    };
  }, [billedShown]);

  const rangeLabel = from ? (from === to ? from : `${from} – ${to}`) : `All time – ${to}`;

  return (
    <div className="space-y-4 p-4 sm:p-6">
      {/* Selector bar */}
      <div className="flex flex-wrap items-end gap-3.5 rounded-xl border border-border bg-card px-4 py-3.5 shadow-sm">
        <div>
          <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Ledger type</label>
          <select
            value={type}
            onChange={(e) => handleTypeChange(e.target.value)}
            className="h-9 min-w-[170px] rounded-md border border-border bg-background px-2.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="">— select type —</option>
            {TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>

        {type && (
          <div>
            <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
              {TYPE_OPTIONS.find((o) => o.value === type)?.label ?? "Entity"}
            </label>
            <SearchableSelect
              options={entityOptions.map((o) => ({ id: o.id, label: o.name, sub: o.sub }))}
              value={entityId}
              onChange={handleEntityChange}
            />
          </div>
        )}

        {/* From / To — picked on the calendar, never typed: a half-typed year is a
            date too, and would load a ledger for it. */}
        <Popover open={calOpen} onOpenChange={setCalOpen}>
          <PopoverTrigger asChild>
            <button type="button" className="flex items-end gap-2 text-left">
              <span>
                <span className="mb-1.5 block text-[10px] font-bold uppercase tracking-wide text-muted-foreground">From</span>
                <span className="flex h-9 min-w-[118px] items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs tabular-nums">
                  <CalendarDays className="size-3.5 text-muted-foreground" />{from || "Beginning"}
                </span>
              </span>
              <span>
                <span className="mb-1.5 block text-[10px] font-bold uppercase tracking-wide text-muted-foreground">To</span>
                <span className="flex h-9 min-w-[118px] items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs tabular-nums">
                  <CalendarDays className="size-3.5 text-muted-foreground" />{to || "Today"}
                </span>
              </span>
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-auto p-3">
            <RangeCalendar from={from} to={to} maxDate={todayPKTString()} onApply={(f, t) => applyRange(f, t, "custom")} />
          </PopoverContent>
        </Popover>

        <div>
          <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Quick range</label>
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map(([k, l]) => (
              <Button
                key={k}
                size="sm"
                variant={preset === k ? "default" : "outline"}
                className="h-9 px-3 text-xs"
                disabled={loading}
                onClick={() => { const [f, t] = presetRange(k); applyRange(f, t, k); }}
              >
                {l}
              </Button>
            ))}
          </div>
        </div>

        {data && (
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="outline" className="h-9" onClick={() => exportCSV(data)}>
              <Download className="mr-1.5 size-3.5" /> CSV
            </Button>
            <Button size="sm" variant="outline" className="h-9" onClick={() => exportPDF(data)}>
              <Download className="mr-1.5 size-3.5" /> PDF
            </Button>
          </div>
        )}
      </div>

      {!data && !loading && (
        <div className="flex h-48 items-center justify-center rounded-xl border border-dashed text-sm text-muted-foreground">
          Select a ledger type and account to view entries.
        </div>
      )}

      {loading && !data && (
        <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">Loading ledger…</div>
      )}

      {data && (
        <div className={cn("space-y-4 transition-opacity", loading && "opacity-60")}>
          <SummaryCards cards={billedOnly && isProduct ? billedSummary.cards : data.summary} />

          {billedOnly && isProduct ? (
            <EntityHeader
              initials={billedProducts.length > 1 ? String(billedProducts.length) : data.entityInfo.initials}
              name={billedProducts.map(productName).join(" + ")}
              meta="Billed returns — charged to customers, stock came back"
              avatarBg={data.entityInfo.avatarBg}
              avatarTc={data.entityInfo.avatarTc}
              chips={<span className="rounded-lg bg-emerald-700 px-3.5 py-2 text-xs font-bold text-white">Came back: {billedSummary.qtyStr}</span>}
            />
          ) : (
            <EntityHeader
              initials={data.entityInfo.initials}
              name={data.entityInfo.name}
              meta={data.entityInfo.meta}
              avatarBg={data.entityInfo.avatarBg}
              avatarTc={data.entityInfo.avatarTc}
              chips={
                <>
                  {data.entityInfo.badges.map((b, i) => (
                    <span key={i} className={cn("rounded-lg px-3 py-1.5 text-xs font-bold tabular-nums", BADGE_COLORS[b.cls] ?? BADGE_COLORS.gray)}>{b.label}</span>
                  ))}
                  {data.entityInfo.live && (
                    <span className={cn("rounded-lg px-3.5 py-1.5 text-xs font-bold tabular-nums text-white", data.entityInfo.live.negative ? "bg-rose-700" : "bg-emerald-700")}>
                      {data.entityInfo.live.label}: {data.entityInfo.live.value}
                    </span>
                  )}
                </>
              }
            />
          )}

          <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
            {/* Title */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
              <div>
                <p className="text-sm font-bold">
                  {billedOnly && isProduct ? `Billed Returns — ${billedProducts.map(productName).join(" + ")}` : `${data.entityInfo.name} — Ledger`}
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {billedOnly && isProduct
                    ? `${billedProducts.length} product${billedProducts.length === 1 ? "" : "s"} selected · ${rangeLabel}`
                    : `${data.rows.length} entries in period · ${rangeLabel}`}
                </p>
              </div>
            </div>

            {/* Filters */}
            <div className="flex flex-wrap items-center gap-2.5 border-b border-border bg-muted/30 px-4 py-3">
              {!billedOnly && cats.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {[{ key: "all", label: "All", dot: "" } as Pick<Cat, "key" | "label" | "dot">, ...cats].map((c) => {
                    const on = catKey === c.key;
                    const n = c.key === "all" ? data.rows.filter((r) => r.id !== "opening").length : catCounts[c.key] ?? 0;
                    return (
                      <button
                        key={c.key}
                        type="button"
                        onClick={() => setCatKey(c.key)}
                        className={cn(
                          "flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors",
                          on ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background text-muted-foreground hover:border-primary",
                        )}
                      >
                        {c.dot && <span className={cn("inline-block size-2 rounded-sm", c.dot)} />}
                        {c.label}
                        <span className={cn("rounded-full px-1.5 text-[10.5px] font-bold", on ? "bg-white/20" : "bg-muted")}>{n}</span>
                      </button>
                    );
                  })}
                </div>
              )}

              {billedOnly && isProduct && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="mr-0.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Products</span>
                  {selectors.products.map((p) => {
                    const on = billedProducts.includes(p.id);
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() =>
                          setBilledProducts((list) =>
                            on ? (list.length > 1 ? list.filter((x) => x !== p.id) : list) : [...list, p.id],
                          )
                        }
                        className={cn(
                          "rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors",
                          on ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background text-muted-foreground hover:border-primary",
                        )}
                      >
                        {p.name}
                      </button>
                    );
                  })}
                </div>
              )}

              {isProduct && (
                <button
                  type="button"
                  title="Charged to the customer on a stop the rider marked skipped — nobody answered, or the customer refused — so the stock came back"
                  onClick={() => {
                    setBilledOnly((v) => !v);
                    setBilledProducts((list) => (list.length ? list : [entityId]));
                    setSortKey("when"); setSortDir(1);
                  }}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-bold transition-colors",
                    billedOnly ? "border-rose-700 bg-rose-700 text-white" : "border-rose-200 bg-background text-rose-700 hover:bg-rose-50",
                  )}
                >
                  <Undo2 className="size-3.5" /> Billed Returns
                  <span className={cn("rounded-full px-1.5 text-[10.5px]", billedOnly ? "bg-white/20" : "bg-rose-50")}>{billedCount}</span>
                </button>
              )}

              <div className="hidden flex-1 sm:block" />

              {!billedOnly && sources.length > 1 && (
                <select
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  className="h-8 max-w-[210px] rounded-md border border-border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  <option value="all">All sources</option>
                  {sources.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              )}

              <div className="relative w-full sm:w-52">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input placeholder="Search entries…" className="h-8 pl-8 text-xs" value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
            </div>

            {/* Table */}
            <div className="max-h-[70vh] overflow-auto">
              {billedOnly && isProduct ? (
                <table className="w-full min-w-[720px] text-[13px]">
                  <thead>
                    <tr className="border-b border-border">
                      <Th {...thProps} k="when" label="Date / Time" />
                      <Th {...thProps} k="desc" label="Description" />
                      {billedProducts.length > 1 && <Th {...thProps} k="prod" label="Product" />}
                      <Th {...thProps} k="reason" label="Reason" />
                      <Th {...thProps} k="qty" label="Came back" right />
                      <Th {...thProps} k="by" label="By" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/60">
                    {(!ownOnly && billedLoading) || billedList === null ? (
                      <tr><td colSpan={6} className="py-12 text-center text-sm text-muted-foreground">Loading billed returns…</td></tr>
                    ) : billedShown.length === 0 ? (
                      <tr><td colSpan={6} className="py-12 text-center text-sm text-muted-foreground">No billed returns in this range.</td></tr>
                    ) : billedShown.map((r) => (
                      <tr key={r.id} className="hover:bg-muted/20">
                        <td className="whitespace-nowrap px-4 py-2.5"><WhenCell iso={r.date} /></td>
                        <td className="px-4 py-2.5">
                          <p className="font-medium">Sent to {r.customer}</p>
                          <p className="text-[11px] text-muted-foreground">billed Rs {fmt(r.amount)} · not handed over</p>
                        </td>
                        {billedProducts.length > 1 && (
                          <td className="px-4 py-2.5"><span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-bold uppercase">{r.productName}</span></td>
                        )}
                        <td className="px-4 py-2.5">
                          <span className={cn(
                            "rounded-full px-2.5 py-0.5 text-[10.5px] font-bold",
                            /refused/i.test(r.reason) ? "bg-rose-50 text-rose-700" : /unresponsive/i.test(r.reason) ? "bg-blue-50 text-blue-700" : "bg-slate-100 text-slate-600",
                          )}>{r.reason}</span>
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-right font-bold text-rose-700 tabular-nums">↩ {fmtQty(r.qty)} {r.unit}</td>
                        <td className="px-4 py-2.5 text-muted-foreground">{r.by}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <table className="w-full min-w-[720px] text-[13px]">
                  <thead>
                    <tr className="border-b border-border">
                      {columns.map((c) => <Th {...thProps} key={c.key} k={c.key} label={c.label} right={c.right} sortable={!!c.sort} />)}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/60">
                    {shown.length === 0 ? (
                      <tr>
                        <td colSpan={columns.length} className="py-12 text-center text-sm text-muted-foreground">
                          {data.rows.length === 0 ? "No entries in this range." : "Nothing matches these filters."}
                        </td>
                      </tr>
                    ) : shown.map((r) => (
                      <tr key={r.id} className={cn("hover:bg-muted/20", r.id === "opening" && "bg-muted/30")}>
                        {columns.map((c) => (
                          <td key={c.key} className={cn("px-4 py-2.5 align-middle", c.right && "text-right tabular-nums", c.className)}>{c.cell(r)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Totals of what is shown */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-muted/30 px-4 py-3">
              <span className="text-xs font-semibold text-muted-foreground">
                {billedOnly && isProduct
                  ? `${billedShown.length} ${billedShown.length === 1 ? "entry" : "entries"} shown`
                  : `${shown.length} ${shown.length === 1 ? "entry" : "entries"} shown`}
              </span>
              <span className="flex flex-wrap gap-4 text-[12.5px] font-bold tabular-nums">
                {billedOnly && isProduct ? (
                  <span className="text-rose-700">Came back: {billedSummary.qtyStr}</span>
                ) : (
                  <>
                    {sides.credit && <span className="text-emerald-700">{sides.credit} {sides.money ? "" : "+"}{money(totCredit)}</span>}
                    {sides.debit && <span className="text-rose-700">{sides.debit} {sides.money ? "" : "−"}{money(totDebit)}</span>}
                    {sides.credit && sides.debit && data.type === "product" && (
                      <span>Net {fmtQty(totCredit - totDebit)} {unit}</span>
                    )}
                  </>
                )}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
