"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Send, Copy, Phone, Check, Search, Shuffle,
  MessageCircle, Users, ClipboardList, FileDown,
} from "lucide-react";
import { toast } from "sonner";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { normalizePhone } from "@/lib/whatsapp";
import { markBillSent } from "@/app/(dashboard)/billing/invoices/actions";

// The rows the dialog needs — a subset of BillingCustomerRow so callers can pass
// their existing data straight through.
export type BillDispatchCustomer = {
  id: string;
  customerCode: string;
  name: string;
  phone: string;
  shiftName: string;
  shiftId: string | null;
  totalDue: number;
  invoiceId: string | null;
  generated: boolean;
  billSent: boolean;   // persisted "already sent" flag (from Invoice.billSentAt)
};

/* ── Message templates ──────────────────────────────────────────────────────
   Same facts, different wording, so WhatsApp doesn't flag identical broadcasts.
   ctx = { name, business, period, amount, dueDate }. */
type MsgCtx = { name: string; business: string; period: string; amount: string; dueDate: string };
const TEMPLATES: ((c: MsgCtx) => string)[] = [
  ({ name, business, period, amount, dueDate }) =>
`Dear ${name},

Thank you for being a valued customer of ${business}. Your invoice for ${period} has been generated, with a total amount of Rs ${amount}. Kindly clear your dues by ${dueDate} to ensure uninterrupted daily delivery.

We appreciate your prompt payment.

Best regards,
${business} Team`,

  ({ name, business, period, amount, dueDate }) =>
`Assalam-o-Alaikum ${name},

We hope you're enjoying fresh milk from ${business}. A friendly reminder that your bill for ${period} comes to Rs ${amount}, due by ${dueDate}. Please settle it on time so your deliveries continue without any break.

Shukriya for your continued trust.

Warm regards,
Team ${business}`,

  ({ name, business, period, amount, dueDate }) =>
`Hello ${name},

Your latest ${business} invoice is ready. For ${period}, the total due is Rs ${amount}, payable on or before ${dueDate}. We request you to clear the balance before the due date to keep your service active.

Thank you for choosing us.

Regards,
${business}`,

  ({ name, business, period, amount, dueDate }) =>
`Dear ${name},

A quick note from ${business}: your account statement for ${period} shows an outstanding amount of Rs ${amount}. The due date is ${dueDate}. Timely payment helps us keep your morning and evening deliveries running smoothly.

Thank you for your cooperation.

Best wishes,
${business} Team`,

  ({ name, business, period, amount, dueDate }) =>
`Dear valued customer ${name},

Thank you for using ${business}. Your invoice for ${period} has been issued with a total of Rs ${amount}, and the due date is ${dueDate}. Kindly ensure payment before then to avoid any interruption in service.

We value your business.

Sincerely,
${business} Team`,
];

const fmtPKR = (n: number) =>
  Math.abs(Math.round(n)).toLocaleString("en-PK");

function renderMessage(idx: number, ctx: MsgCtx) {
  const t = TEMPLATES[((idx % TEMPLATES.length) + TEMPLATES.length) % TEMPLATES.length];
  return t(ctx);
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      return true;
    } catch {
      return false;
    }
  }
}

// ── One customer row ─────────────────────────────────────────────────────────
function DispatchRow({
  c, ctxBase, tmplIdx, sent, onShuffle, onToggleSent,
}: {
  c: BillDispatchCustomer;
  ctxBase: Omit<MsgCtx, "name" | "amount">;
  tmplIdx: number;
  sent: boolean;
  onShuffle: (id: string) => void;
  onToggleSent: (id: string, val: boolean) => void;
}) {
  const [flash, setFlash] = useState<"phone" | "msg" | "">("");
  const flashFor = (k: "phone" | "msg") => {
    setFlash(k);
    setTimeout(() => setFlash((cur) => (cur === k ? "" : cur)), 1400);
  };

  const message = useMemo(
    () => renderMessage(tmplIdx, { ...ctxBase, name: c.name, amount: fmtPKR(c.totalDue) }),
    [tmplIdx, ctxBase, c.name, c.totalDue]
  );

  const normalized = normalizePhone(c.phone);
  const waHref = normalized
    ? `https://wa.me/${normalized}?text=${encodeURIComponent(message)}`
    : null;

  return (
    <div
      className={cn(
        "rounded-xl border bg-card p-3.5 shadow-sm",
        sent ? "border-primary/40" : "border-border"
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold text-foreground">{c.name}</span>
            <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              {c.shiftName}
            </span>
          </div>
          <div className="mt-0.5 font-mono text-[12px] text-muted-foreground">
            {c.customerCode} · {c.phone}
          </div>
        </div>
        <div className="text-right">
          <div className="stat-label">Total due</div>
          <div className={cn("text-lg font-bold tabular-nums", c.totalDue > 0 ? "text-rose-600" : "text-emerald-600")}>
            {c.totalDue > 0 ? `₨ ${fmtPKR(c.totalDue)}` : "Clear"}
          </div>
        </div>
      </div>

      {/* message preview */}
      <div className="mt-3 rounded-lg border border-border bg-muted/40 p-2.5">
        <div className="mb-1 flex items-center justify-between">
          <span className="stat-label">Message · template {(tmplIdx % TEMPLATES.length) + 1}</span>
          <button
            type="button"
            onClick={() => onShuffle(c.id)}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-muted"
          >
            <Shuffle className="size-3" /> Shuffle
          </button>
        </div>
        <p className="max-h-24 overflow-y-auto whitespace-pre-wrap text-[12.5px] leading-relaxed text-muted-foreground">
          {message}
        </p>
      </div>

      {/* actions */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          type="button" variant="outline" size="sm" className="h-8 text-[13px]"
          onClick={async () => { if (await copyText(c.phone)) flashFor("phone"); }}
        >
          {flash === "phone" ? <Check className="mr-1 size-3.5" /> : <Phone className="mr-1 size-3.5" />}
          {flash === "phone" ? "Copied" : "Copy no."}
        </Button>
        <Button
          type="button" variant="outline" size="sm" className="h-8 text-[13px]"
          onClick={async () => { if (await copyText(message)) flashFor("msg"); }}
        >
          {flash === "msg" ? <Check className="mr-1 size-3.5" /> : <Copy className="mr-1 size-3.5" />}
          {flash === "msg" ? "Copied" : "Copy message"}
        </Button>
        {waHref ? (
          <a
            href={waHref}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => onToggleSent(c.id, true)}
            className="inline-flex h-8 items-center gap-1 rounded-lg bg-[#25D366] px-2.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
          >
            <MessageCircle className="size-3.5" /> WhatsApp
          </a>
        ) : (
          <span
            title="No valid phone number on file"
            className="inline-flex h-8 cursor-not-allowed items-center gap-1 rounded-lg border border-border px-2.5 text-[13px] font-medium text-muted-foreground opacity-60"
          >
            <MessageCircle className="size-3.5" /> WhatsApp
          </span>
        )}
        {c.invoiceId ? (
          <a
            href={`/print/invoice/${c.invoiceId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-8 items-center gap-1 rounded-lg border border-border px-2.5 text-[13px] font-medium text-foreground transition-colors hover:bg-muted"
          >
            <FileDown className="size-3.5" /> PDF
          </a>
        ) : null}

        <label className="ml-auto inline-flex cursor-pointer select-none items-center gap-1.5 text-[13px] text-muted-foreground">
          <input
            type="checkbox"
            checked={sent}
            onChange={(e) => onToggleSent(c.id, e.target.checked)}
            className="size-4 accent-primary"
          />
          Sent
        </label>
      </div>
    </div>
  );
}

// ── The dialog ───────────────────────────────────────────────────────────────
export function BillDispatchDialog({
  customers,
  shifts,
  periodLabel,
  dueDate,
  businessName,
}: {
  customers: BillDispatchCustomer[];
  shifts: { id: string; name: string }[];
  periodLabel: string;
  dueDate: string;
  businessName: string;
}) {
  const [open, setOpen] = useState(false);
  const [shiftFilter, setShiftFilter] = useState<string>(""); // "" = all
  const [q, setQ] = useState("");
  // Seeded from the persisted Invoice.billSentAt flag, re-seeded each time the
  // dialog opens (in handleOpenChange) so it reflects what the whole team has sent.
  const [sentIds, setSentIds] = useState<Set<string>>(() => new Set(customers.filter((c) => c.billSent).map((c) => c.id)));
  const [tmplMap, setTmplMap] = useState<Record<string, number>>({});

  const handleOpenChange = useCallback((v: boolean) => {
    if (v) setSentIds(new Set(customers.filter((c) => c.billSent).map((c) => c.id)));
    setOpen(v);
  }, [customers]);

  // Only send to customers who (a) have a generated invoice (a real bill + PDF)
  // AND (b) actually owe money. A Clear (0) or in-credit (negative) customer must
  // never get a "please pay Rs X" message — fmtPKR strips the sign, so without the
  // `totalDue > 0` guard a customer 500 in credit would be asked to pay Rs 500.
  const sendable = useMemo(
    () => customers.filter((c) => c.generated && c.invoiceId && c.totalDue > 0),
    [customers]
  );
  const notGenerated = customers.filter((c) => !c.generated || !c.invoiceId).length;
  const settledCount = customers.filter((c) => c.generated && c.invoiceId && c.totalDue <= 0).length;

  const ctxBase = useMemo(
    () => ({ business: businessName, period: periodLabel, dueDate }),
    [businessName, periodLabel, dueDate]
  );

  // Rotate a starting template so neighbours differ; keep each customer's choice.
  useEffect(() => {
    if (!open) return;
    setTmplMap((prev) => {
      const next = { ...prev };
      const start = Math.floor(Math.random() * TEMPLATES.length);
      sendable.forEach((c, i) => {
        if (next[c.id] == null) next[c.id] = (start + i) % TEMPLATES.length;
      });
      return next;
    });
  }, [open, sendable]);

  const shuffleOne = useCallback((id: string) => {
    setTmplMap((m) => {
      const cur = m[id] ?? 0;
      let n = cur;
      while (n === cur && TEMPLATES.length > 1) n = Math.floor(Math.random() * TEMPLATES.length);
      return { ...m, [id]: n };
    });
  }, []);

  const toggleSent = useCallback((id: string, val: boolean) => {
    const invoiceId = customers.find((c) => c.id === id)?.invoiceId;
    // Optimistic UI, then persist so the flag survives refresh and is shared.
    const apply = (on: boolean) => setSentIds((s) => {
      const next = new Set(s);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
    apply(val);
    if (!invoiceId) return;
    markBillSent(invoiceId, val)
      .then((res) => { if (!res.ok) { apply(!val); toast.error(res.error ?? "Couldn't save sent status."); } })
      .catch(() => { apply(!val); toast.error("Couldn't save sent status."); });
  }, [customers]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return sendable
      .filter((c) => !shiftFilter || c.shiftId === shiftFilter)
      .filter((c) => {
        if (!needle) return true;
        return (
          c.name.toLowerCase().includes(needle) ||
          c.customerCode.toLowerCase().includes(needle) ||
          String(c.phone).includes(needle)
        );
      });
  }, [sendable, shiftFilter, q]);

  const totals = useMemo(() => {
    const due = filtered.reduce((s, c) => s + (c.totalDue > 0 ? c.totalDue : 0), 0);
    const sent = filtered.filter((c) => sentIds.has(c.id)).length;
    return { due, sent, count: filtered.length };
  }, [filtered, sentIds]);

  const copyAllNumbers = async () => {
    const nums = filtered.map((c) => c.phone).filter(Boolean).join("\n");
    if (!nums) { toast.error("No numbers to copy."); return; }
    if (await copyText(nums)) toast.success(`Copied ${filtered.length} number${filtered.length !== 1 ? "s" : ""}.`);
  };

  const shiftCount = (id: string) => sendable.filter((c) => c.shiftId === id).length;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" className="shrink-0">
          <Send className="mr-1.5 size-4" />
          Send bills
        </Button>
      </DialogTrigger>

      {/* sm:max-w-5xl overrides the base DialogContent's sm:max-w-sm — without it
          the dialog stays narrow (~384px) on desktop. */}
      <DialogContent className="flex h-[90vh] w-[96vw] max-w-5xl flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl">
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle className="text-base">Send bills</DialogTitle>
          <p className="text-xs text-muted-foreground">{periodLabel} · due {dueDate}</p>
        </DialogHeader>

        {/* summary strip */}
        <div className="grid grid-cols-3 gap-2 px-5 py-3">
          {[
            { k: "Customers", v: String(totals.count), Icon: Users },
            { k: "Total due", v: `₨ ${fmtPKR(totals.due)}`, Icon: ClipboardList },
            { k: "Sent", v: `${totals.sent}/${totals.count}`, Icon: Check },
          ].map(({ k, v, Icon }) => (
            <div key={k} className="rounded-xl border border-border bg-card px-3 py-2">
              <div className="flex items-center gap-1.5 stat-label">
                <Icon className="size-3" /> {k}
              </div>
              <div className="mt-0.5 text-[15px] font-bold tabular-nums text-foreground">{v}</div>
            </div>
          ))}
        </div>

        {/* controls */}
        <div className="flex flex-wrap items-center gap-2 px-5 pb-3">
          <div className="relative min-w-[180px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search name, phone or code…"
              className="w-full rounded-xl border border-border bg-background py-2 pl-9 pr-3 text-sm outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <div className="flex flex-wrap items-center gap-1 rounded-full border border-border bg-card p-0.5">
            <ShiftTab active={shiftFilter === ""} onClick={() => setShiftFilter("")} label="All" n={sendable.length} />
            {shifts.map((s) => (
              <ShiftTab key={s.id} active={shiftFilter === s.id} onClick={() => setShiftFilter(s.id)} label={s.name} n={shiftCount(s.id)} />
            ))}
          </div>
          <Button type="button" variant="outline" size="sm" className="h-9" onClick={copyAllNumbers}>
            <Copy className="mr-1.5 size-3.5" /> Copy all numbers
          </Button>
        </div>

        {/* list */}
        <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-5 pb-4">
          {filtered.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
              {sendable.length === 0
                ? "No invoices have been generated for this period yet."
                : "No customers match this filter."}
            </div>
          ) : (
            filtered.map((c) => (
              <DispatchRow
                key={c.id}
                c={c}
                ctxBase={ctxBase}
                tmplIdx={tmplMap[c.id] ?? 0}
                sent={sentIds.has(c.id)}
                onShuffle={shuffleOne}
                onToggleSent={toggleSent}
              />
            ))
          )}
        </div>

        {(notGenerated > 0 || settledCount > 0) ? (
          <div className="border-t border-border px-5 py-2.5 text-[11px] text-muted-foreground">
            {notGenerated > 0 ? (
              <span>{notGenerated} customer{notGenerated !== 1 ? "s are" : " is"} not yet generated for this period and can&apos;t be sent — generate their bills first. </span>
            ) : null}
            {settledCount > 0 ? (
              <span>{settledCount} settled / in-credit customer{settledCount !== 1 ? "s are" : " is"} hidden — nothing due, so no reminder is sent.</span>
            ) : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ShiftTab({ active, onClick, label, n }: { active: boolean; onClick: () => void; label: string; n: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full px-3 py-1 text-[13px] font-semibold transition-colors",
        active ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
      )}
    >
      {label}<span className="ml-1.5 opacity-60">{n}</span>
    </button>
  );
}
