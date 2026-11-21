/**
 * Remove one rider-cash collection that was recorded by mistake.
 *
 * A rider-cash row on /payments/rider-cash IS a Payment row with head
 * RIDER_CASH. There is no delete button on that page, so a mistaken entry has to
 * come out from here.
 *
 * Deleting it does two things, and both are the point:
 *   • the customer's balance goes UP by the amount, because the collection was
 *     crediting a payment he never made;
 *   • "cash with riders" goes DOWN by the amount, because the rider was being
 *     shown as carrying money he never took.
 *
 * Guards, because this is money:
 *   • only a PENDING row may go — one already handed over or confirmed received
 *     has been counted into the Rider Cash box and, for older rows, may have a
 *     paired head transfer behind it. Those are refused outright; they are undone
 *     on the page first.
 *   • an ambiguous match is refused rather than guessed at. Pass --id to name one.
 *
 * The deletion is recorded in the audit log automatically (actor: system).
 *
 *   npx tsx scripts/remove-rider-cash-entry.ts                 # report only
 *   npx tsx scripts/remove-rider-cash-entry.ts --apply
 *   npx tsx scripts/remove-rider-cash-entry.ts --id <paymentId> --apply
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });

const APPLY = process.argv.includes("--apply");
const ID_ARG = (() => {
  const i = process.argv.indexOf("--id");
  return i >= 0 ? process.argv[i + 1] : null;
})();

// The entry as the office described it.
const TARGET = {
  customerCode: "C-1892",
  amount: 2800,
  /** Used only to narrow and to show what was found — not to match exactly. */
  around: "2026-08-31",
};

function rs(n: number) {
  return "Rs " + Math.round(n).toLocaleString("en-PK");
}

async function main() {
  const candidates = await db.payment.findMany({
    where: ID_ARG
      ? { id: ID_ARG }
      : {
          head: "RIDER_CASH",
          amount: TARGET.amount,
          customer: { customerCode: TARGET.customerCode },
        },
    select: {
      id: true, amount: true, date: true, head: true, notes: true,
      receivedAt: true, receivedByName: true, handedOverAt: true, handedToName: true,
      customer: { select: { id: true, customerCode: true, name: true } },
      rider: { select: { user: { select: { name: true } } } },
    },
    orderBy: { date: "desc" },
  });

  console.log(`Looking for: ${TARGET.customerCode}, ${rs(TARGET.amount)}, RIDER_CASH, around ${TARGET.around}`);
  console.log(`Matches: ${candidates.length}\n`);

  for (const p of candidates) {
    const status = p.receivedAt ? "RECEIVED" : p.handedOverAt ? "HANDED OVER" : "pending";
    console.log(`  id            ${p.id}`);
    console.log(`  customer      ${p.customer?.customerCode ?? "—"} · ${p.customer?.name ?? "—"}`);
    console.log(`  rider         ${p.rider?.user?.name ?? "—"}`);
    console.log(`  amount        ${rs(Number(p.amount))}`);
    console.log(`  collected at  ${p.date.toISOString()}`);
    console.log(`  status        ${status}`);
    console.log(`  handed over   ${p.handedOverAt?.toISOString() ?? "—"} ${p.handedToName ?? ""}`);
    console.log(`  received      ${p.receivedAt?.toISOString() ?? "—"} ${p.receivedByName ?? ""}`);
    console.log(`  notes         ${p.notes ?? "—"}\n`);
  }

  if (candidates.length === 0) {
    console.log("Nothing matched. Check the customer code and the amount.");
    return;
  }
  if (candidates.length > 1 && !ID_ARG) {
    console.log("More than one row matches. Re-run with --id <paymentId> naming the one to remove.");
    return;
  }

  const p = candidates[0];

  // Refuse anything that has already moved into the Rider Cash box.
  if (p.receivedAt) {
    console.log(`REFUSED: this cash was confirmed received on ${p.receivedAt.toISOString()}` +
      `${p.receivedByName ? ` by ${p.receivedByName}` : ""}. Undo the receipt on the rider-cash page first.`);
    return;
  }
  if (p.handedOverAt) {
    console.log(`REFUSED: this cash was handed over on ${p.handedOverAt.toISOString()}` +
      `${p.handedToName ? ` to ${p.handedToName}` : ""}. Deal with that on the page first.`);
    return;
  }
  if (p.head !== "RIDER_CASH") {
    console.log(`REFUSED: this is a ${p.head} payment, not rider cash.`);
    return;
  }

  // A pending row should have no paired sweep. Check rather than assume.
  const xfer = await db.headTransfer.findFirst({
    where: { fromHead: "RIDER_CASH", toHead: "CASH", amount: p.amount },
    select: { id: true, date: true, notes: true },
  });
  if (xfer) {
    console.log(`CAREFUL: a RIDER_CASH → CASH transfer of the same amount exists ` +
      `(${xfer.id}, ${xfer.date.toISOString()}, "${xfer.notes ?? ""}"). ` +
      `It may be unrelated, but check it before removing this row.`);
  }

  const before = await db.payment.aggregate({
    _sum: { amount: true },
    where: { customerId: p.customer!.id },
  });
  console.log(`This customer's payments total ${rs(Number(before._sum.amount ?? 0))} today.`);
  console.log(`Removing this row raises what he owes by ${rs(Number(p.amount))}, ` +
    `and lowers cash with riders by the same.`);

  if (!APPLY) {
    console.log("\nReport only. Re-run with --apply to remove it.");
    return;
  }

  await db.payment.delete({ where: { id: p.id } });
  const after = await db.payment.aggregate({
    _sum: { amount: true },
    where: { customerId: p.customer!.id },
  });
  console.log(`\nRemoved ${p.id}.`);
  console.log(`This customer's payments now total ${rs(Number(after._sum.amount ?? 0))}.`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => db.$disconnect());
