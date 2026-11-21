import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  console.log("Cleaning inventory tables...");
  await db.inventoryMovement.deleteMany({});   console.log("  ✓ InventoryMovement");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db as any).yoghurtBatch.deleteMany({}).catch(() => {});   console.log("  ✓ YoghurtBatch");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db as any).skimMilkBatch.deleteMany({}).catch(() => {});  console.log("  ✓ SkimMilkBatch");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db as any).mixMilkBatch.deleteMany({}).catch(() => {});   console.log("  ✓ MixMilkBatch");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db as any).buffaloDilutionBatch.deleteMany({}).catch(() => {}); console.log("  ✓ BuffaloDilutionBatch");
  await db.retailDispatch.deleteMany({});      console.log("  ✓ RetailDispatch");
  await db.vanDispatch.deleteMany({});         console.log("  ✓ VanDispatch");
  await db.farmDispatch.deleteMany({});        console.log("  ✓ FarmDispatch");
  await db.productionLog.deleteMany({});       console.log("  ✓ ProductionLog");
  // Routes hold stock out of storage through RouteStopItem.plannedQty. Clearing the
  // movements but leaving the plans behind leaves every one of those commitments
  // with nothing backing it, so storage reads 0 for good and every route save is
  // refused for lack of stock. The two have to go together.
  await db.route.deleteMany({});               console.log("  ✓ Route (stops + planned items cascade)");
  // Retail drops hold stock out at a shop through their lines, exactly the way a
  // route holds it through plannedQty — so the consignment chain goes too, or
  // storage stays understated by whatever is sitting on a shelf that no longer
  // has a record. The marts themselves are kept, like products and customers.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const retailPays = await (db as any).retailPayment.findMany().catch(() => []);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db as any).retailPayment.deleteMany({}).catch(() => {});
  await db.payment.deleteMany({ where: { id: { in: retailPays.map((p: { paymentId: string }) => p.paymentId) } } }).catch(() => {});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db as any).retailResolutionLine.deleteMany({}).catch(() => {});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db as any).retailResolution.deleteMany({}).catch(() => {});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db as any).retailReceivable.deleteMany({}).catch(() => {});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db as any).retailPlacementLine.deleteMany({}).catch(() => {});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db as any).retailPlacement.deleteMany({}).catch(() => {});
  console.log("  ✓ Retail placements (lines, reports, receivables, payments)");
  console.log("\nDone — all inventory entries cleared.");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => db.$disconnect());
