"use client";

import { useEffect, useState, useTransition } from "react";
import { RangeCalendar } from "@/components/ui/range-calendar";
import { ReconciliationFlow, ReasonSummary } from "@/components/inventory/reconciliation-flow";
import { ReconciliationDetail } from "@/components/inventory/reconciliation-detail";
import { todayPKTString, yesterdayPKTString, addDaysToDateStr } from "@/lib/pkt";
import {
  getReconciliationSummary,
  getCurrentMilkInventory,
  type ReconciliationSummary,
  type MilkInventorySnapshot,
} from "@/app/(dashboard)/inventory/reconciliation/actions";
import styles from "./reconciliation.module.css";

type Preset = "today" | "yesterday" | "7" | "30" | "month" | "custom";
type Tab = "summary" | "detailed";

const PRESETS: [Preset, string][] = [["today", "Today"], ["yesterday", "Yesterday"], ["7", "7 days"], ["30", "30 days"], ["month", "This month"]];

// Production Reconciliation, in the approved design. One date range drives the
// Summary; the Detailed tab shows the range's first day. The dates are picked on a
// calendar rather than typed: a typed box re-queries the whole chain on every
// keystroke, and a half-typed year is a date too.
export function ReconciliationClient({
  summary: initialSummary,
  inventory: initialInventory,
  fontClass = "",
}: {
  summary: ReconciliationSummary;
  inventory: MilkInventorySnapshot | null;
  fontClass?: string;
}) {
  const [from, setFrom] = useState(initialSummary.from);
  const [to, setTo] = useState(initialSummary.to);
  const [preset, setPreset] = useState<Preset>("today");
  const [summary, setSummary] = useState(initialSummary);
  const [inventory, setInventory] = useState(initialInventory);
  const [tab, setTab] = useState<Tab>("summary");
  const [calOpen, setCalOpen] = useState(false);
  const [loading, startLoading] = useTransition();
  // The Detailed tab's day. When the range is one day it is the same summary;
  // otherwise that one day is fetched on its own.
  const [daySummary, setDaySummary] = useState<ReconciliationSummary | null>(null);
  const [dayLoading, startDayLoading] = useTransition();

  function load(nextFrom: string, nextTo: string, next: Preset) {
    setFrom(nextFrom); setTo(nextTo); setPreset(next); setCalOpen(false);
    startLoading(async () => {
      const [s, inv] = await Promise.all([getReconciliationSummary(nextFrom, nextTo), getCurrentMilkInventory()]);
      setSummary(s);
      setInventory(inv);
    });
  }

  function applyPreset(p: Preset) {
    const today = todayPKTString();
    if (p === "today") return load(today, today, p);
    if (p === "yesterday") { const y = yesterdayPKTString(); return load(y, y, p); }
    if (p === "7") return load(addDaysToDateStr(today, -6), today, p);
    if (p === "30") return load(addDaysToDateStr(today, -29), today, p);
    if (p === "month") return load(today.slice(0, 8) + "01", today, p);
  }

  const day = summary.from;
  const single = summary.from === summary.to;
  useEffect(() => {
    if (tab !== "detailed" || single) return;
    let cancelled = false;
    startDayLoading(async () => {
      const s = await getReconciliationSummary(day, day);
      if (!cancelled) setDaySummary(s);
    });
    return () => { cancelled = true; };
  }, [tab, day, single]);

  const f = summary.flow;
  const empty =
    [f.produced, f.purchased, f.received, f.toRetail, f.riderLoad, f.delivered, f.returned, f.wasteTotal].every((v) => Math.abs(v) < 0.0005);
  const detail = single ? summary : daySummary && daySummary.from === day ? daySummary : null;

  return (
    <div className={`${styles.root} ${fontClass}`}>
      <div className="wrap">
        <div className="eyebrow">BANOORI DAIRY · OPERATIONS</div>
        <h1>Production Reconciliation</h1>
        <p className="lead">Follow every stage from milk receiving to delivery, returns and current inventory.</p>

        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "summary"} className={`tab ${tab === "summary" ? "on" : ""}`} onClick={() => setTab("summary")}>Summary</button>
          <button type="button" role="tab" aria-selected={tab === "detailed"} className={`tab ${tab === "detailed" ? "on" : ""}`} onClick={() => setTab("detailed")}>Detailed</button>
        </div>

        <div className="daterow">
          <button type="button" className="datebox" onClick={() => setCalOpen((o) => !o)} aria-expanded={calOpen}>
            <span className="dlab">From</span><span className="dval">{from}</span>
          </button>
          <button type="button" className="datebox" onClick={() => setCalOpen((o) => !o)} aria-expanded={calOpen}>
            <span className="dlab">To</span><span className="dval">{to}</span>
          </button>
          <div className="quick">
            {PRESETS.map(([k, l]) => (
              <button type="button" key={k} className={preset === k ? "on" : ""} disabled={loading} onClick={() => applyPreset(k)}>{l}</button>
            ))}
          </div>
          <span className="day-tag">
            {loading ? <span className="loading-tag">Loading…</span> : summary.days > 1 ? `${summary.days} days` : summary.from}
          </span>
        </div>
        {calOpen && (
          <div className="calpop">
            <RangeCalendar from={from} to={to} maxDate={todayPKTString()} onApply={(a, b) => load(a, b, "custom")} />
          </div>
        )}

        {summary.error && <div className="errbox">{summary.error}</div>}

        {tab === "summary" ? (
          <div>
            <div className="sec-lab">
              Milk flow summary (L)
              <span className="hint">Follow the flow from top to bottom. Select a wastage or missing figure for its breakdown.</span>
            </div>
            {empty ? (
              <div className="empty-flow">No production records for this date range. Choose a range with available records.</div>
            ) : (
              <ReconciliationFlow s={summary} inventory={inventory} />
            )}
            <div className="edit-day-note">
              {summary.days > 1
                ? `${summary.days} days combined. Detailed shows the From date (${summary.from}) and its farm figures.`
                : `Showing ${summary.from}. Open Detailed for product and rider records.`}
            </div>

            <details className="reason-collapse">
              <summary>Reasons &amp; loss breakdown</summary>
              <p className="reason-intro">
                Every wastage reason below is the one written on the entry when the milk was written off. Missing milk has
                no reason on record — it is the gap between two recorded figures, and is listed as exactly that.
              </p>
              <ReasonSummary s={summary} />
            </details>
            <p className="footer-note">BANOORI DAIRY · FARM TO CUSTOMER</p>
          </div>
        ) : detail ? (
          <ReconciliationDetail s={detail} day={day} />
        ) : (
          <div className="empty-flow">{dayLoading || loading ? "Loading…" : "Could not load this day."}</div>
        )}
      </div>
    </div>
  );
}
