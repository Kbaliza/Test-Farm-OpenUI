"use client";

import { useState, useTransition, Fragment } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronRight, Loader2, ScrollText, Globe, Smartphone, HelpCircle, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RangeCalendar } from "@/components/ui/range-calendar";
import { fmtTimePKT, fmtDatePKT, todayPKTString } from "@/lib/pkt";
import { tableLabel, operationLabel, SYSTEM_ACTOR } from "@/lib/audit-labels";
import { getAuditLog, type AuditPage, type AuditEntry } from "@/app/(dashboard)/audit-log/actions";

/** In the list a value is a glance, not the record — the details row has it whole. */
const brief = (t: string) => (t.length > 48 ? t.slice(0, 45) + "…" : t);

const ALL = "__all__";

const OP_STYLE: Record<string, string> = {
  INSERT: "bg-emerald-50 text-emerald-700",
  UPDATE: "bg-sky-50 text-sky-700",
  DELETE: "bg-rose-50 text-rose-700",
};

const SOURCE = {
  web: { icon: Globe, text: "on the website" },
  mobile: { icon: Smartphone, text: "from the app" },
  unknown: { icon: HelpCircle, text: "straight to the database" },
} as const;

/** One entry, and the fields it moved. */
function Entry({ e }: { e: AuditEntry }) {
  const [open, setOpen] = useState(false);
  const src = SOURCE[e.actorSource as keyof typeof SOURCE] ?? SOURCE.unknown;
  const Icon = src.icon;
  const detail = e.changes.length > 0 || e.details.length > 0;

  return (
    <>
      <tr className="border-t border-border/60 align-top hover:bg-muted/20">
        <td className="whitespace-nowrap px-3 py-2">
          <div className="font-medium">{fmtTimePKT(e.at)}</div>
          <div className="text-[10px] text-muted-foreground">{fmtDatePKT(e.at)}</div>
        </td>
        <td className="px-3 py-2">
          <div className="font-medium">{e.actorName ?? (e.actorSource === "mobile" ? "Rider app" : "System")}</div>
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <Icon className="size-3" /> {e.actorRole ? `${e.actorRole} · ` : ""}{src.text}
          </div>
        </td>
        <td className="px-3 py-2">
          <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold", OP_STYLE[e.operation] ?? "bg-muted")}>
            {operationLabel(e.operation)}
          </span>
        </td>
        {/* Which record — and, the point of the column, whose and which thing. */}
        <td className="px-3 py-2">
          <div className="font-medium">{tableLabel(e.tableName)}</div>
          {e.customerName && <div className="text-[11px] text-foreground/80">{e.customerName}</div>}
          {e.productName && <div className="text-[11px] text-muted-foreground">{e.productName}</div>}
          {e.subject && <div className="text-[11px] text-muted-foreground">{e.subject}</div>}
        </td>
        <td className="px-3 py-2">
          {e.changes.length > 0 ? (
            <div className="space-y-0.5">
              {e.changes.slice(0, 3).map((c) => (
                <div key={c.field} className="text-[12px]">
                  <span className="text-muted-foreground">{c.label}: </span>
                  <span className="line-through opacity-60">{brief(c.beforeText)}</span>
                  <span className="mx-1">→</span>
                  <span className="font-semibold">{brief(c.afterText)}</span>
                </div>
              ))}
              {e.changes.length > 3 && (
                <div className="text-[11px] text-muted-foreground">and {e.changes.length - 3} more</div>
              )}
            </div>
          ) : e.details.length > 0 ? (
            <div className="text-[12px]">{e.action}</div>
          ) : (
            <span className="text-[12px] text-muted-foreground">—</span>
          )}
        </td>
        <td className="px-3 py-2 text-right">
          {detail && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
              {open ? "Hide" : "Details"}
            </button>
          )}
        </td>
      </tr>
      {open && (
        <tr className="border-t border-border/40 bg-muted/20">
          <td colSpan={6} className="px-3 py-2">
            <p className="mb-1.5 text-[13px]">{e.summary}</p>
            {e.changes.length > 0 ? (
              <table className="w-full text-[12px]">
                <thead className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  <tr><th className="w-48 py-0.5 pr-3 text-left font-medium">Field</th><th className="py-0.5 pr-3 text-left font-medium">Before</th><th className="py-0.5 text-left font-medium">After</th></tr>
                </thead>
                <tbody>
                  {e.changes.map((c) => (
                    <tr key={c.field}>
                      <td className="w-48 py-0.5 pr-3 text-muted-foreground">{c.label}</td>
                      <td className="max-w-md break-words py-0.5 pr-3 line-through opacity-60">{c.beforeText}</td>
                      <td className="max-w-md break-words py-0.5 font-medium">{c.afterText}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <table className="w-full text-[12px]">
                <tbody>
                  {e.details.map((d) => (
                    <tr key={d.label}>
                      <td className="w-48 py-0.5 pr-3 text-muted-foreground">{d.label}</td>
                      <td className="max-w-md break-words py-0.5">{d.text}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {e.rowId && <p className="mt-1 text-[10px] text-muted-foreground/70">record id {e.rowId}</p>}
          </td>
        </tr>
      )}
    </>
  );
}

export function AuditLogClient({ data }: { data: AuditPage }) {
  const router = useRouter();
  const params = useSearchParams();
  const [loading, start] = useTransition();
  const [q, setQ] = useState("");

  const [rows, setRows] = useState(data.entries);
  const [cursor, setCursor] = useState(data.nextCursor);

  // The filters go through the URL, so the server does the filtering. The rows
  // and the cursor are held in state only so "Load more" can append to them —
  // which means they have to be put back whenever a new set arrives. Without
  // this the table kept whatever it was first given and every filter looked
  // like it did nothing at all. Same idiom the billing page uses.
  const key = params.toString();
  const [synced, setSynced] = useState(key);
  if (synced !== key) {
    setSynced(key);
    setRows(data.entries);
    setCursor(data.nextCursor);
  }

  const get = (k: string) => params.get(k) ?? "";

  function apply(next: Record<string, string>) {
    const p = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    start(() => router.push(p.toString() ? `/audit-log?${p}` : "/audit-log", { scroll: false }));
  }

  function loadMore() {
    if (!cursor) return;
    start(async () => {
      const more = await getAuditLog({
        from: get("from"), to: get("to"), table: get("table"),
        actorId: get("actor"), operation: get("op"), rowId: get("row"),
        productId: get("product"), customer: get("customer"),
        routine: get("routine") === "1",
        cursor,
      });
      setRows((prev) => [...prev, ...more.entries]);
      setCursor(more.nextCursor);
    });
  }

  // The free-text box narrows what is already on screen; the customer box above
  // asks the server. Both are useful, and they are not the same thing.
  const shown = q.trim()
    ? rows.filter((r) => {
        const hay = `${r.summary} ${r.actorName ?? ""} ${tableLabel(r.tableName)} ${r.customerName ?? ""} ${r.productName ?? ""} ${r.subject ?? ""} ${r.changes.map((c) => c.label).join(" ")}`.toLowerCase();
        return hay.includes(q.trim().toLowerCase());
      })
    : rows;

  const [customerBox, setCustomerBox] = useState(get("customer"));
  const [syncedCustomer, setSyncedCustomer] = useState(get("customer"));
  if (syncedCustomer !== get("customer")) {
    setSyncedCustomer(get("customer"));
    setCustomerBox(get("customer"));
  }

  const anyFilter = ["table", "actor", "op", "from", "to", "product", "customer", "row", "routine"].some((k) => get(k));

  return (
    <div className="space-y-3 p-4 sm:p-6">
      <div className="flex flex-wrap items-end gap-2">
        {/* Customer — asks the server, so it reaches the whole log, not this page. */}
        <Input
          value={customerBox}
          onChange={(e) => setCustomerBox(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") apply({ customer: customerBox }); }}
          onBlur={() => { if (customerBox !== get("customer")) apply({ customer: customerBox }); }}
          placeholder="Customer name or code…"
          className="h-8 w-full text-xs sm:w-52"
        />
        <Select value={get("product") || ALL} onValueChange={(v) => apply({ product: v === ALL ? "" : v })}>
          <SelectTrigger className="h-8 w-40 text-xs">
            <SelectValue>{data.products.find((p) => p.id === get("product"))?.name ?? "Any product"}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Any product</SelectItem>
            {data.products.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={get("table") || ALL} onValueChange={(v) => apply({ table: v === ALL ? "" : v })}>
          <SelectTrigger className="h-8 w-44 text-xs">
            <SelectValue>{get("table") ? tableLabel(get("table")) : "Everything"}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Everything</SelectItem>
            {data.tables.map((t) => <SelectItem key={t} value={t}>{tableLabel(t)}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={get("actor") || ALL} onValueChange={(v) => apply({ actor: v === ALL ? "" : v })}>
          <SelectTrigger className="h-8 w-44 text-xs">
            <SelectValue>
              {get("actor") === SYSTEM_ACTOR
                ? "System / scripts"
                : data.actors.find((a) => a.id === get("actor"))?.name ?? "Anyone"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Anyone</SelectItem>
            {data.actors.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={get("op") || ALL} onValueChange={(v) => apply({ op: v === ALL ? "" : v })}>
          <SelectTrigger className="h-8 w-32 text-xs">
            <SelectValue>{get("op") ? operationLabel(get("op")) : "Any change"}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Any change</SelectItem>
            <SelectItem value="INSERT">Added</SelectItem>
            <SelectItem value="UPDATE">Edited</SelectItem>
            <SelectItem value="DELETE">Deleted</SelectItem>
          </SelectContent>
        </Select>
        {/* The window is picked on the calendar below. The server still treats each
            end on its own — a start with no end means "since then" — so an existing
            link carrying only `from` keeps working; the calendar simply always sets
            both, because it cannot know you meant the range open-ended. */}
        <div className="flex h-8 items-center text-xs text-muted-foreground">
          {get("from") || get("to") ? (
            <span>
              {get("from") || "the beginning"} <span className="text-muted-foreground/60">to</span> {get("to") || "now"}
            </span>
          ) : (
            <span>All dates</span>
          )}
        </div>
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Narrow this page…"
          className="h-8 w-full text-xs sm:w-44"
        />
        <label className="flex h-8 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground" title="Bills rebuilt on open, rounds re-saved, settings — rows the software writes by itself">
          <input type="checkbox" className="size-3.5" checked={get("routine") === "1"} onChange={(e) => apply({ routine: e.target.checked ? "1" : "" })} />
          Show routine changes
        </label>
        {anyFilter && (
          <Button size="sm" variant="outline" className="h-8 gap-1 text-xs" onClick={() => start(() => router.push("/audit-log", { scroll: false }))}>
            <X className="size-3" /> Clear
          </Button>
        )}
        {loading && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
      </div>

      <RangeCalendar
        className="max-w-xs"
        from={get("from")}
        to={get("to")}
        maxDate={todayPKTString()}
        onApply={(f, t) => apply({ from: f, to: t })}
      />

      {data.customer && data.customer.matched === 0 && (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] font-medium text-amber-800">
          No customer matches “{data.customer.query}”, so nothing can be shown. Check the spelling or the code.
        </p>
      )}
      {data.customer && data.customer.matched > 1 && (
        <p className="text-[11px] text-muted-foreground">
          “{data.customer.query}” matches {data.customer.matched} customers — showing all of them.
        </p>
      )}

      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full text-[13px]">
          <thead className="bg-muted/50 text-[10px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-semibold">When</th>
              <th className="px-3 py-2 text-left font-semibold">Who</th>
              <th className="px-3 py-2 text-left font-semibold">Did</th>
              <th className="px-3 py-2 text-left font-semibold">To what</th>
              <th className="px-3 py-2 text-left font-semibold">What changed</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-10 text-center text-sm text-muted-foreground">
                  <ScrollText className="mx-auto mb-2 size-6 opacity-40" />
                  Nothing recorded for these filters.
                </td>
              </tr>
            ) : (
              shown.map((e) => <Fragment key={e.id}><Entry e={e} /></Fragment>)
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-[11px] text-muted-foreground">
          Showing {shown.length} entr{shown.length === 1 ? "y" : "ies"} · kept {data.retentionMonths} months · entries can never be edited or deleted
        </p>
        {cursor && (
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={loadMore} disabled={loading}>
            Load more
          </Button>
        )}
      </div>
    </div>
  );
}
