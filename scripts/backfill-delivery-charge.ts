/**
 * Put the delivery charge back on second-half bills that froze it at zero.
 *
 * A bill takes its delivery charge at the moment it is generated, and the charge
 * only applies once the customer has actually taken a delivery in that fortnight.
 * Generate the bill on the 16th, before the first delivery of the half is
 * recorded, and the charge is fixed at nothing — and there it stays, while the
 * lines themselves go on being rebuilt from the live deliveries. The customer is
 * handed a bill listing a fortnight of milk and a delivery line reading
 * "Complimentary".
 *
 * Opening such a bill now repairs it on its own, because getInvoiceDetail works
 * the charge out fresh. This does the same thing in bulk, so the balances on
 * Recovery, the dashboard and the WhatsApp reminders stop disagreeing with the
 * bill until someone happens to open it.
 *
 *   npx tsx scripts/backfill-delivery-charge.ts          # report only
 *   npx tsx scripts/backfill-delivery-charge.ts --apply  # write
 */
import { PrismaClient, Prisma } from "@prisma/client";

const db = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
const APPLY = process.argv.includes("--apply");

function halfTwoBounds(year: number, month: number) {
  return {
    start: new Date(Date.UTC(year, month - 1, 16)),
    end: new Date(Date.UTC(year, month, 0, 23, 59, 59, 999)),
  };
}

async function main() {
  // Only half 2 — the month's delivery charge falls on the second bill.
  const invoices = await db.invoice.findMany({
    where: { half: 2, deliveryCharge: 0 },
    select: { id: true, customerId: true, year: true, month: true, status: true, totalDue: true },
    orderBy: [{ year: "asc" }, { month: "asc" }],
  });

  const fixes: { id: string; fee: number; status: string; period: string }[] = [];
  for (const inv of invoices) {
    const { start, end } = halfTwoBounds(inv.year, inv.month);
    const delivered = await db.deliveryEntry.count({
      where: {
        customerId: inv.customerId,
        date: { gte: start, lte: end },
        isReturn: false, isReplacement: false, quantity: { gt: 0 },
      },
    });
    if (!delivered) continue; // genuinely no delivery — no charge is correct

    const c = await db.customer.findUnique({
      where: { id: inv.customerId },
      select: { deliveryCharge: true, area: { select: { defaultDeliveryCharge: true } } },
    });
    const fee = Number(c?.deliveryCharge ?? 0) || Number(c?.area?.defaultDeliveryCharge ?? 0);
    if (fee <= 0) continue;

    fixes.push({ id: inv.id, fee, status: inv.status, period: `${inv.year}-${String(inv.month).padStart(2, "0")}` });
  }

  const total = fixes.reduce((s, f) => s + f.fee, 0);
  const byStatus = new Map<string, number>();
  const byPeriod = new Map<string, number>();
  for (const f of fixes) {
    byStatus.set(f.status, (byStatus.get(f.status) ?? 0) + 1);
    byPeriod.set(f.period, (byPeriod.get(f.period) ?? 0) + 1);
  }

  console.log(`Second-half bills with a zero delivery charge: ${invoices.length}`);
  console.log(`…of those, with deliveries and a charge to apply: ${fixes.length}`);
  console.log(`Total to be added: Rs ${Math.round(total).toLocaleString("en-PK")}`);
  console.log("By status:", Object.fromEntries(byStatus));
  console.log("By period:", Object.fromEntries(byPeriod));

  if (!APPLY) {
    console.log("\nReport only. Re-run with --apply to write.");
    return;
  }

  // totalDue moves with the charge, so the bill and the balance stay in step.
  let done = 0;
  for (const f of fixes) {
    await db.$transaction(async (tx) => {
      const inv = await tx.invoice.findUniqueOrThrow({ where: { id: f.id }, select: { totalDue: true } });
      await tx.invoice.update({
        where: { id: f.id },
        data: {
          deliveryCharge: new Prisma.Decimal(f.fee),
          totalDue: new Prisma.Decimal(Number(inv.totalDue) + f.fee),
        },
      });
    });
    done++;
    if (done % 50 === 0) console.log(`  …${done}/${fixes.length}`);
  }
  console.log(`Applied to ${done} bills.`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => db.$disconnect());
