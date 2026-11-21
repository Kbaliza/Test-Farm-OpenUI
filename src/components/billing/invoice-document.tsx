import { Bike } from "lucide-react";
import { cn } from "@/lib/utils";
import { qtyLabel } from "@/lib/units";
import type { InvoiceDetail, InvoiceLineRow } from "@/app/(dashboard)/billing/invoices/actions";

// ── Business details (edit here) ────────────────────────────────────────────────
export const BRAND = {
  name: "Banoori Dairy",
  tagline: "Fresh farm milk · Door delivery",
  bankTitle: "Banoori Dairy",
  bankName: "HBL Bank",
  accountNo: "25847000094003",
  iban: "PK56HABB0025847000094003",
  wallet: "0311-3511113",
  logo: "/banoori%20dairy%20logo.png", // file in /public (spaces URL-encoded)
};

function fmt(n: number) {
  return Math.abs(Math.round(n)).toLocaleString("en-PK");
}
function fmtDay(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", { timeZone: "Asia/Karachi", day: "2-digit", month: "short" });
}
function fmtDue(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", { timeZone: "Asia/Karachi", day: "numeric", month: "long", year: "numeric" });
}

function lineType(l: InvoiceLineRow): "delivery" | "return" | "replacement" | "notDelivered" {
  if (l.isReturn) return "return";
  if (l.isReplacement) return "replacement";
  // Charged on a stop the rider marked skipped. The charge stands, but telling the
  // customer it was delivered when nobody was in is the kind of line that starts an
  // argument the bill cannot win.
  if (l.notDelivered) return "notDelivered";
  return "delivery";
}

const TYPE_TAG: Record<string, string> = {
  delivery: "bg-[#E5EBD8] text-[#2D4A2E]",
  replacement: "bg-[#F8EFD1] text-[#7A5410]",
  return: "bg-[#F1DDD0] text-[#8A3219]",
  notDelivered: "bg-[#F6E7BE] text-[#8A6508]",
};
const TYPE_LABEL: Record<string, string> = {
  delivery: "Delivered", replacement: "Replacement", return: "Returned",
  notDelivered: "Charged, not delivered",
};

// ── Printable invoice document (shared by the detail page preview & print route) ──

export function InvoiceDocument({ invoice }: { invoice: InvoiceDetail }) {
  const entries = invoice.lines.length;
  // Payments received in this period, split: first against what was owed when it
  // started, then the rest against this period's own charges.
  const paidOnOld = invoice.prevBalance > 0 ? Math.min(invoice.prevBalance, invoice.paymentsAmt) : 0;
  const paidOnNew = invoice.paymentsAmt - paidOnOld;

  return (
    <div className="mx-auto max-w-[680px] overflow-hidden rounded-md border border-[#E5DCC4] bg-[#FFFCF4] text-[#1B1612] shadow-sm print:border-0 print:shadow-none">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 border-b border-[#E5DCC4] px-8 py-6">
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={BRAND.logo} alt={BRAND.name} className="size-12 shrink-0 rounded-full object-contain" />
          <div>
            <div className="font-serif text-2xl leading-none">{BRAND.name}</div>
            <div className="mt-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#9A8E78]">{BRAND.tagline}</div>
          </div>
        </div>
        <div className="text-right">
          <div className="text-[9px] font-semibold uppercase tracking-[0.2em] text-[#9A8E78]">Statement</div>
          <div className="mt-1 font-mono text-[11px] text-[#5E5443]">{invoice.number}</div>
          <div className="mt-1 font-serif text-lg italic">{invoice.periodLabel}</div>
        </div>
      </div>

      {/* Customer */}
      <div className="grid grid-cols-2 gap-x-8 gap-y-4 border-b border-[#E5DCC4] px-8 py-5">
        <div>
          <div className="text-[9px] font-bold uppercase tracking-[0.2em] text-[#9A8E78]">Customer</div>
          <div className="mt-1 text-sm font-medium">{invoice.customer.name}</div>
          <div className="mt-0.5 font-mono text-[10px] text-[#9A8E78]">{invoice.customer.code}</div>
        </div>
        <div>
          <div className="text-[9px] font-bold uppercase tracking-[0.2em] text-[#9A8E78]">Phone</div>
          <div className="mt-1 text-sm font-medium">{invoice.customer.phone}</div>
        </div>
        {invoice.customer.address && (
          <div className="col-span-2">
            <div className="text-[9px] font-bold uppercase tracking-[0.2em] text-[#9A8E78]">Delivery address</div>
            <div className="mt-1 text-sm font-medium leading-snug">{invoice.customer.address}</div>
          </div>
        )}
      </div>

      {/* Line items */}
      <div className="px-8 pt-4">
        <div className="mb-1 flex items-baseline justify-between">
          <span className="font-serif text-sm italic text-[#5E5443]">Deliveries this period</span>
          <span className="text-[9px] font-bold uppercase tracking-[0.2em] text-[#9A8E78]">{entries} {entries === 1 ? "entry" : "entries"}</span>
        </div>
        <table className="w-full text-[11px]" style={{ fontVariantNumeric: "tabular-nums" }}>
          <thead>
            <tr className="border-b border-[#E5DCC4] text-left text-[8.5px] font-bold uppercase tracking-[0.14em] text-[#9A8E78]">
              <th className="py-2">Date</th>
              <th className="py-2">Item</th>
              <th className="py-2 text-right">Qty</th>
              <th className="py-2 text-right">Rate</th>
              <th className="py-2 text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {invoice.lines.length === 0 ? (
              <tr><td colSpan={5} className="py-6 text-center text-[#9A8E78]">No deliveries recorded for this period.</td></tr>
            ) : invoice.lines.map((l) => {
              const t = lineType(l);
              return (
                <tr key={l.id} className="border-b border-dashed border-[#EFE7D2]">
                  <td className="py-1.5 font-serif text-[12px] italic">{fmtDay(l.date)}</td>
                  <td className="py-1.5">
                    <span className="font-medium">{l.productName}</span>
                    <span className={cn("ml-1.5 rounded px-1.5 py-0.5 text-[7.5px] font-bold uppercase tracking-wide", TYPE_TAG[t])}>{TYPE_LABEL[t]}</span>
                  </td>
                  <td className="py-1.5 text-right">{qtyLabel(l.unit, l.quantity)}</td>
                  <td className={cn("py-1.5 text-right", t === "replacement" && "text-[#9A8E78]")}>{t === "replacement" ? "—" : `${fmt(l.rate)}`}</td>
                  <td className={cn("py-1.5 text-right font-semibold", t === "return" && "text-[#A14529]", t === "replacement" && "text-[#9A8E78]")}>
                    {t === "return" ? `−${fmt(l.amount)}` : `${fmt(l.amount)}`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Over-the-counter purchases on credit — a charge on this bill */}
      {invoice.otcSales.length > 0 && (
        <div className="px-8 pt-5">
          <div className="mb-1 flex items-baseline justify-between">
            <span className="font-serif text-sm italic text-[#5E5443]">Over-the-counter (on credit)</span>
            <span className="text-[9px] font-bold uppercase tracking-[0.2em] text-[#9A8E78]">{invoice.otcSales.length} {invoice.otcSales.length === 1 ? "sale" : "sales"}</span>
          </div>
          <table className="w-full text-[11px]" style={{ fontVariantNumeric: "tabular-nums" }}>
            <thead>
              <tr className="border-b border-[#E5DCC4] text-left text-[8.5px] font-bold uppercase tracking-[0.14em] text-[#9A8E78]">
                <th className="py-2">Date</th>
                <th className="py-2">Ref</th>
                <th className="py-2">Items</th>
                <th className="py-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {invoice.otcSales.map((s) => (
                <tr key={s.id} className="border-b border-dashed border-[#EFE7D2]">
                  <td className="py-1.5 font-serif text-[12px] italic">{fmtDay(s.date)}</td>
                  <td className="py-1.5 font-mono text-[10px] text-[#5E5443]">{s.invoiceNo}</td>
                  <td className="py-1.5 text-[#5E5443]">{s.products || "—"}</td>
                  <td className="py-1.5 text-right font-semibold">{fmt(s.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Summary */}
      <div className="mt-3 border-t border-[#E5DCC4] px-8 py-4">
        <SummaryRow label="Previous balance" sub="Carried forward" value={invoice.prevBalance} signed />
        {/* A payment in this period settles the previous balance first: the last
            bill is sent at the turn of the period and paid in its first days, so
            it should read as cleared rather than as still owed. Display only —
            the total below is the same either way. */}
        {paidOnOld > 0 && <SummaryRow label="Paid towards it" sub="Received after the last bill — thank you" value={-paidOnOld} signed pos />}
        {paidOnOld > 0 && (
          <SummaryRow label="Still owed from before" value={invoice.prevBalance - paidOnOld} free={invoice.prevBalance - paidOnOld < 0.5} freeLabel="Cleared ✓" />
        )}
        <SummaryRow label="This period’s deliveries" value={invoice.deliveriesAmt} />
        {invoice.returnsAmt > 0 && <SummaryRow label="Returns / credits" value={-invoice.returnsAmt} signed />}
        {/* The month’s delivery charge falls on the second bill. On the first it is
            still to come; on the second, a zero can only mean the customer took no
            delivery at all — never that the delivery was a gift, which is what this
            line used to tell them. */}
        <SummaryRow
          label="Delivery charges"
          value={invoice.deliveryCharge}
          free={invoice.deliveryCharge === 0}
          freeLabel={invoice.half === 1 ? "On 2nd invoice" : "No deliveries"}
        />
        {invoice.otcAmt > 0 && <SummaryRow label="Over-the-counter purchases" sub="On credit" value={invoice.otcAmt} />}
        {invoice.discount > 0 && <SummaryRow label="Discount" sub="Adjustment on this bill" value={-invoice.discount} signed pos />}
        {paidOnNew > 0.005 && <SummaryRow label="Payments received" sub="Thank you" value={-paidOnNew} signed pos />}
      </div>

      {/* Total */}
      <div className="relative mx-8 my-5 flex items-center justify-between overflow-hidden rounded p-5 text-[#F8EFD1]" style={{ background: "linear-gradient(135deg,#2D4A2E,#25401F)" }}>
        <div>
          <div className="text-[9px] font-bold uppercase tracking-[0.22em] text-[#F8EFD1]/65">Total balance due</div>
          <div className="font-serif text-base italic">{invoice.totalDue <= 0 ? "Fully settled" : "Payable now"}</div>
        </div>
        <div className="font-serif text-3xl font-medium tracking-tight">
          {invoice.totalDue <= 0 ? "✓ Clear" : `${fmt(invoice.totalDue)}`}
        </div>
      </div>

      {/* Payment methods */}
      <div className="px-8 pb-6">
        <div className="mb-3 text-center text-[9px] font-bold uppercase tracking-[0.22em] text-[#9A8E78]">Ways to pay</div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="rounded border border-[#E5DCC4] bg-[#FBF5E1] p-4">
            <div className="mb-2 border-b border-[#E5DCC4] pb-2 font-serif text-sm font-medium">{BRAND.bankName} Transfer</div>
            <PayLine label="Account title" value={BRAND.bankTitle} />
            <PayLine label="Account no." value={BRAND.accountNo} mono />
            <PayLine label="IBAN" value={BRAND.iban} mono />
          </div>
          <div className="rounded border border-[#E5DCC4] bg-[#FBF5E1] p-4">
            <div className="mb-2 border-b border-[#E5DCC4] pb-2 font-serif text-sm font-medium">Easypaisa · JazzCash</div>
            <PayLine label="Mobile number" value={BRAND.wallet} big />
            <PayLine label="Account title" value={BRAND.bankTitle} />
          </div>
        </div>
        <div className="mt-4 flex items-center justify-center gap-3 rounded border border-[#C8D6B8] bg-[#E5EBD8] py-3">
          <Bike className="size-5 text-[#2D4A2E]" />
          <span className="font-serif text-sm font-medium italic text-[#2D4A2E]">Or hand it to your rider on delivery</span>
        </div>
      </div>

      {/* Footer */}
      <div className="border-t border-[#E6CB85] bg-gradient-to-b from-[#F8EFD1] to-[#F2E2A8] px-8 py-6 text-center">
        <div className="font-serif text-[13px] italic leading-relaxed text-[#5C4515]">
          Fresh, hygienic milk — delivered within six hours of milking.<br />
          Kindly clear your bill by <strong className="rounded bg-[#A14529]/10 px-1 font-sans font-bold not-italic text-[#A14529]">{fmtDue(invoice.dueDate)}</strong> to avoid service interruption.
        </div>
        <div className="mt-3 font-serif text-sm font-medium italic text-[#5C4515]">— with care, {BRAND.name}</div>
      </div>
    </div>
  );
}

function SummaryRow({
  label, sub, value, signed, pos, free, freeLabel,
}: {
  label: string; sub?: string; value: number; signed?: boolean; pos?: boolean; free?: boolean; freeLabel?: string;
}) {
  return (
    <div className="flex items-baseline justify-between border-b border-dashed border-[#EFE7D2] py-2 last:border-0">
      <div className="text-[12.5px] text-[#5E5443]">
        {label}
        {sub && <small className="mt-0.5 block text-[10px] text-[#9A8E78]">{sub}</small>}
      </div>
      {free ? (
        <div className="font-serif text-sm italic text-[#3F5E3B]">{freeLabel ?? "Complimentary"}</div>
      ) : (
        <div className={cn("text-sm font-semibold tabular-nums", pos ? "text-[#3F5E3B]" : value < 0 ? "text-[#A14529]" : "text-[#1B1612]")}>
          {signed && value < 0 ? `−${fmt(value)}` : `${fmt(value)}`}
        </div>
      )}
    </div>
  );
}

function PayLine({ label, value, mono, big }: { label: string; value: string; mono?: boolean; big?: boolean }) {
  return (
    <>
      <div className="mt-2 text-[8.5px] font-bold uppercase tracking-[0.2em] text-[#9A8E78] first:mt-0">{label}</div>
      <div className={cn("mt-0.5 text-[#1B1612]", mono && "font-mono text-[10.5px] break-all", big ? "font-serif text-lg font-medium" : "text-[12px] font-medium")}>{value}</div>
    </>
  );
}
