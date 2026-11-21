"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Send, CheckCircle2, Clock, AlertTriangle, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { unitLabel, type Unit } from "@/lib/units";
import { roundQty } from "@/lib/quantity";
import { fmtTimePKT } from "@/lib/pkt";
import { sendToRetail, deleteRetailSend, deleteRetailSendLine, type PoolView } from "@/app/(dashboard)/inventory/farm-arrival/actions";
import type { PackagingLoadNeeds } from "@/app/(dashboard)/customers/pre-delivery/actions";

const fmt = (n: number) => (n % 1 === 0 ? n.toFixed(0) : n.toFixed(1));

const STATUS: Record<string, { text: string; cls: string; Icon: typeof Clock }> = {
  PENDING:   { text: "Retail to confirm",                cls: "text-amber-700",   Icon: Clock },
  CONFIRMED: { text: "Confirmed by Retail",              cls: "text-emerald-700", Icon: CheckCircle2 },
  DISPUTED:  { text: "Retail received less",             cls: "text-rose-700",    Icon: AlertTriangle },
};

// Last step on the packaging page: send to Retail from inventory. One box per
// product, like the Production entry form, each showing what inventory holds and
// capped at it. Accepted loads, mix milk made and standardised buffalo are all
// already in inventory; Retail confirms what it receives.
//
// `needs` is today's shift load: each box also shows what the shifts still need
// in Retail, and "Fill what's still needed" puts that in (capped at inventory).
export function PackagingSend({ view, needs }: { view: PoolView; needs?: PackagingLoadNeeds }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [qty, setQty] = useState<Record<string, string>>({});
  const [reviewing, setReviewing] = useState(false);

  const rows = view.lines.map((l) => {
    const raw = qty[l.productId] ?? "";
    const n = raw === "" ? 0 : Number(raw);
    return { l, raw, n, bad: raw !== "" && (!Number.isFinite(n) || n < 0), over: n > l.available + 0.0005 };
  });
  const toSend = rows.filter((r) => r.n > 0 && !r.bad);
  const invalid = rows.some((r) => r.bad || r.over);

  const stillNeeded = new Map((needs?.isToday ? needs.lines : []).map((l) => [l.productId, l.stillToSend]));
  const canFillNeeded = view.lines.some((l) => l.available > 0 && (stillNeeded.get(l.productId) ?? 0) > 0);

  // What is being typed counts against the shift's need straight away, so the
  // packer sees 150 fall to 50 as he types 100 — and the Shift loads card above
  // hears it too, instead of the two disagreeing until the send goes through.
  const typedKey = JSON.stringify(
    Object.fromEntries(rows.filter((r) => r.n > 0 && !r.bad).map((r) => [r.l.productId, r.n])),
  );
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("packaging:typing", { detail: JSON.parse(typedKey) }));
  }, [typedKey]);

  /** "4.5 kg Desi Ghee" — how a line reads in a confirm box. */
  const label = (it: PoolView["sentToday"][number]["items"][number]) =>
    `${fmt(Number(it.quantity))} ${unitLabel(it.unit as Unit)} ${it.productName}`;

  function removeSend(s: PoolView["sentToday"][number]) {
    const what = s.items.map(label).join(", ");
    if (!window.confirm(`Delete this send? ${what} goes back into inventory, and Retail will not see it.`)) return;
    start(async () => {
      const res = await deleteRetailSend(s.id);
      if (!res.ok) { toast.error(res.error); return; }
      toast.success("Send deleted — the stock is back in inventory.");
      router.refresh();
    });
  }

  function removeLine(s: PoolView["sentToday"][number], it: PoolView["sentToday"][number]["items"][number]) {
    const only = s.items.length === 1;
    const ask = only
      ? `Remove ${label(it)}? It is the only thing on this send, so the whole send goes and the stock returns to inventory.`
      : `Remove ${label(it)} from this send? It goes back into inventory; the rest of the send stays.`;
    if (!window.confirm(ask)) return;
    start(async () => {
      const res = await deleteRetailSendLine(s.id, it.productId);
      if (!res.ok) { toast.error(res.error); return; }
      toast.success(`${it.productName} taken off the send — it is back in inventory.`);
      router.refresh();
    });
  }

  /** One table of sends. A pending send can be taken back, item by item or whole. */
  function sendTable(heading: string, list: PoolView["sentToday"], older = false) {
    if (list.length === 0) return null;
    return (
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-1.5 text-left font-medium">{heading}</th>
              <th className="px-3 py-1.5 text-left font-medium">Quantities</th>
              <th className="px-3 py-1.5 text-left font-medium">Retail</th>
              <th className="px-3 py-1.5 text-right font-medium"><span className="sr-only">Undo</span></th>
            </tr>
          </thead>
          <tbody>
            {list.map((s) => {
              const st = STATUS[s.status] ?? STATUS.PENDING;
              const pending = s.status === "PENDING";
              return (
                <tr key={s.id} className="border-t border-border/60">
                  <td className="whitespace-nowrap px-3 py-1.5">
                    {fmtTimePKT(s.at)}
                    {older && <span className="block text-[10px] text-muted-foreground">{s.at.slice(0, 10)}</span>}
                  </td>
                  <td className="px-3 py-1.5">
                    {s.items.map((it) => (
                      <span key={it.productId} className="mr-3 inline-block">
                        {it.productName} <span className="font-semibold">{fmt(Number(it.quantity))} {unitLabel(it.unit)}</span>
                        {pending && (
                          <button
                            type="button"
                            onClick={() => removeLine(s, it)}
                            disabled={busy}
                            className="ml-1 align-middle text-muted-foreground hover:text-rose-600 disabled:opacity-30"
                            title={`Remove ${it.productName} from this send — it goes back into inventory`}
                          >
                            <Trash2 className="size-3" />
                          </button>
                        )}
                      </span>
                    ))}
                  </td>
                  <td className="px-3 py-1.5">
                    <span className={`inline-flex items-center gap-1 text-xs ${st.cls}`}>
                      <st.Icon className="size-3" /> {st.text}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    {/* Nothing at all once Retail has confirmed: a disabled bin invites
                        a click and answers with a refusal. */}
                    {pending && (
                      <button
                        type="button"
                        onClick={() => removeSend(s)}
                        disabled={busy}
                        className="inline-grid size-7 place-items-center rounded-md border border-border text-muted-foreground hover:border-rose-200 hover:text-rose-600 disabled:opacity-30"
                        title="Delete this send — the stock goes back into inventory"
                      >
                        <Trash2 className="size-3" />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  function fillNeeded() {
    setQty(Object.fromEntries(
      view.lines
        .map((l) => [l.productId, Math.min(l.available, stillNeeded.get(l.productId) ?? 0)] as const)
        .filter(([, q]) => q > 0)
        .map(([pid, q]) => [pid, fmt(Math.round(q * 1000) / 1000)]),
    ));
    setReviewing(false);
  }

  function fillAll() {
    setQty(Object.fromEntries(view.lines.map((l) => [l.productId, fmt(l.available)])));
    setReviewing(false);
  }

  function send() {
    start(async () => {
      const res = await sendToRetail(toSend.map((r) => ({ productId: r.l.productId, quantity: r.n })));
      if (res.ok) {
        toast.success("Sent to Retail — they confirm it on the Retail screen.");
        setQty({});
        setReviewing(false);
        router.refresh();
      } else {
        toast.error(res.error);
        setReviewing(false);
      }
    });
  }

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Send className="size-4" /> Send to Retail
        </CardTitle>
        <div className="flex flex-wrap gap-2">
          {canFillNeeded && (
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={fillNeeded}>
              Fill what&apos;s still needed
            </Button>
          )}
          {view.lines.some((l) => l.available > 0) && (
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={fillAll}>
              Fill everything in inventory
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {view.lines.length === 0 ? (
          <p className="rounded-lg border border-dashed px-4 py-5 text-sm text-muted-foreground">
            Nothing in inventory yet. Accept a load from production at the top of the page first.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
              {rows.map(({ l, raw, n, over, bad }) => (
                <label key={l.productId} className="block rounded-md border border-border bg-card px-2.5 py-1.5">
                  <span className="block truncate text-xs font-medium">{l.name}</span>
                  <span className="block text-[11px] text-muted-foreground">
                    In inventory: <span className="font-semibold text-foreground">{fmt(l.available)} {unitLabel(l.unit as Unit)}</span>
                  </span>
                  <Input
                    type="number" min="0" step="0.1" inputMode="decimal" placeholder="0"
                    value={raw}
                    onChange={(e) => { setQty((q) => ({ ...q, [l.productId]: e.target.value })); setReviewing(false); }}
                    disabled={l.available <= 0}
                    aria-invalid={over || bad}
                    className="mt-1 h-8 text-sm font-semibold"
                  />
                  {(stillNeeded.get(l.productId) ?? 0) > 0 && (() => {
                    const left = Math.max(0, roundQty(stillNeeded.get(l.productId)! - (bad ? 0 : n)));
                    return left > 0 ? (
                      <span className="block text-[11px] text-amber-700">
                        Shifts still need: <span className="font-semibold">{fmt(left)} {unitLabel(l.unit as Unit)}</span>
                      </span>
                    ) : (
                      <span className="block text-[11px] font-semibold text-emerald-700">
                        Covers what the shifts need
                      </span>
                    );
                  })()}
                  {over && <span className="mt-0.5 block text-[10px] text-rose-600">Only {fmt(l.available)} here</span>}
                </label>
              ))}
            </div>

            {!reviewing ? (
              <div className="flex justify-end">
                <Button size="sm" onClick={() => setReviewing(true)} disabled={busy || invalid || toSend.length === 0}>
                  <Send className="mr-1 size-4" /> Send to Retail
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-emerald-300 bg-emerald-50/60 px-3 py-2">
                <p className="text-sm">
                  Send{" "}
                  {toSend.map((r, i) => (
                    <span key={r.l.productId}>
                      {i > 0 && ", "}
                      <span className="font-semibold">{fmt(r.n)} {unitLabel(r.l.unit as Unit)} {r.l.name}</span>
                    </span>
                  ))}{" "}
                  to Retail?
                </p>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => setReviewing(false)} disabled={busy}>Back</Button>
                  <Button size="sm" onClick={send} disabled={busy}>
                    <CheckCircle2 className="mr-1 size-4" />{busy ? "Sending…" : "Yes, confirm"}
                  </Button>
                </div>
              </div>
            )}
          </>
        )}

        {sendTable("Sent today", view.sentToday)}
        {/* Sends from earlier days nobody has confirmed. Both this page and the
            Retail page show only today, so without this they cannot be seen at
            all — let alone cleared. */}
        {view.stillWaiting.length > 0 && sendTable("Still waiting on Retail", view.stillWaiting, true)}
      </CardContent>
    </Card>
  );
}
