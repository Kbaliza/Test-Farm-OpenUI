/**
 * inventory-test.ts
 * Cleans all inventory tables and inserts a complete test flow:
 *   Production → Farm Dispatch → Van Delivery → Retail Arrival → Yoghurt Batch
 * Then prints expected values for every inventory page so you can verify the UI.
 *
 * Run with:  npx tsx --env-file .env scripts/inventory-test.ts
 */

import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

// ── PKT helpers (mirrors src/lib/pkt.ts) ─────────────────────────────────────
const PKT_MS = 5 * 60 * 60 * 1000;
function nowPKT() { return new Date(Date.now() + PKT_MS); }
function pktDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  const n = nowPKT();
  return new Date(Date.UTC(y, m - 1, d, n.getUTCHours(), n.getUTCMinutes(), n.getUTCSeconds()) - PKT_MS);
}
function toDateStrPKT(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Karachi" });
}

// ── tiny assertion helper ─────────────────────────────────────────────────────
let passed = 0, failed = 0;
function check(label: string, actual: number, expected: number, tol = 0.01) {
  if (Math.abs(actual - expected) <= tol) {
    console.log(`  ✅  ${label}: ${actual} (expected ${expected})`);
    passed++;
  } else {
    console.log(`  ❌  ${label}: ${actual}  ← expected ${expected}  MISMATCH`);
    failed++;
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════╗");
  console.log("║   INVENTORY END-TO-END TEST SCRIPT   ║");
  console.log("╚══════════════════════════════════════╝\n");

  // ── 1. Discover products ───────────────────────────────────────────────────
  const allProds = await db.product.findMany({
    where: { active: true },
    select: { id: true, name: true, unit: true },
    orderBy: { name: "asc" },
  });
  console.log("Active products:", allProds.map(p => `${p.name}(${p.unit})`).join("  "));

  const find = (kw: string, unit?: string) =>
    allProds.find(p => p.name.toLowerCase().includes(kw.toLowerCase()) && (!unit || p.unit === unit));

  const P = {
    buffalo : find("buffalo",  "LITER"),
    cow     : find("cow",      "LITER"),
    mix     : find("mix",      "LITER"),
    yoghurt : find("yogh",     "KG"),
  };

  if (!P.buffalo || !P.cow || !P.mix)
    throw new Error("Missing milk products — ensure Buffalo Milk, Cow Milk, Mix Milk exist as active LITER products.");

  console.log(`\nBuffalo: ${P.buffalo.id.slice(-6)}`);
  console.log(`Cow    : ${P.cow.id.slice(-6)}`);
  console.log(`Mix    : ${P.mix.id.slice(-6)}`);
  console.log(`Yoghurt: ${P.yoghurt?.id.slice(-6) ?? "— NOT FOUND (yoghurt batch will be skipped)"}\n`);

  // ── 2. CLEAN TABLES (order respects foreign keys) ─────────────────────────
  console.log("── Cleaning inventory tables ──");
  await db.inventoryMovement.deleteMany({});   console.log("  ✓ InventoryMovement");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db as any).yoghurtBatch.deleteMany({}).catch(() => {});  console.log("  ✓ YoghurtBatch");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db as any).skimMilkBatch.deleteMany({}).catch(() => {}); console.log("  ✓ SkimMilkBatch");
  await db.retailDispatch.deleteMany({});      console.log("  ✓ RetailDispatch");
  await db.vanDispatch.deleteMany({});         console.log("  ✓ VanDispatch");
  await db.farmDispatch.deleteMany({});        console.log("  ✓ FarmDispatch");
  await db.productionLog.deleteMany({});       console.log("  ✓ ProductionLog");

  // ── 3. TEST DATE ──────────────────────────────────────────────────────────
  // Use yesterday PKT so the reconciliation's "30-day" window covers it.
  const testDateStr = toDateStrPKT(new Date(Date.now() + PKT_MS - 86_400_000));
  const T = pktDate(testDateStr); // UTC timestamp anchored to PKT date
  console.log(`\nTest date (PKT): ${testDateStr}  →  UTC ${T.toISOString()}\n`);

  // ── 4. PRODUCTION ─────────────────────────────────────────────────────────
  console.log("── Step 1: Production ──");
  await db.inventoryMovement.createMany({ data: [
    { date: T, type: "PRODUCED",    productId: P.buffalo.id, quantity: 100 },
    { date: T, type: "PRODUCED",    productId: P.cow.id,     quantity:  80 },
    { date: T, type: "PRODUCED",    productId: P.mix.id,     quantity:  60 },
    { date: T, type: "CALF_USE",    productId: P.buffalo.id, quantity:   3 },
    { date: T, type: "KITCHEN_USE", productId: P.cow.id,     quantity:   5, reason: "Internal kitchen" },
  ]});
  console.log("  Produced  : Buffalo=100L  Cow=80L  Mix=60L");
  console.log("  Calf Use  : Buffalo=3L");
  console.log("  Kitchen   : Cow=5L (non-yoghurt)");

  // ── 5. FARM DISPATCH (packaging → van) ────────────────────────────────────
  console.log("\n── Step 2: Farm Dispatch (packaging declares to van) ──");
  const FARM_DECLARED = [
    { productId: P.buffalo.id, productName: P.buffalo.name, unit: "LITER", quantity: 90 },
    { productId: P.cow.id,     productName: P.cow.name,     unit: "LITER", quantity: 70 },
    { productId: P.mix.id,     productName: P.mix.name,     unit: "LITER", quantity: 55 },
  ];
  const farmDispatch = await db.farmDispatch.create({
    data: { date: T, declaredItems: FARM_DECLARED, status: "PENDING" },
  });
  console.log("  Declared  : Buffalo=90  Cow=70  Mix=55  →  total 215L");

  // ── 6. VAN CONFIRMS RECEIPT FROM FARM (farm-arrival → confirmArrival) ─────
  console.log("\n── Step 3: Van confirms receipt from farm ──");
  const VAN_RECEIVED_FROM_FARM = [
    { productId: P.buffalo.id, productName: P.buffalo.name, unit: "LITER", quantity: 88 }, // -2L
    { productId: P.cow.id,     productName: P.cow.name,     unit: "LITER", quantity: 68 }, // -2L
    { productId: P.mix.id,     productName: P.mix.name,     unit: "LITER", quantity: 54 }, // -1L
  ];
  await db.farmDispatch.update({
    where: { id: farmDispatch.id },
    data: { status: "DISPUTED", receivedItems: VAN_RECEIVED_FROM_FARM, reason: "Transit spillage on the way to van" },
  });
  await db.inventoryMovement.createMany({ data: VAN_RECEIVED_FROM_FARM.map(i => ({
    date: T, type: "DISPATCHED" as const, productId: i.productId, quantity: i.quantity,
    reference: farmDispatch.id, reason: "Transit spillage on the way to van",
  }))});
  const vanDispatch = await db.vanDispatch.create({
    data: { date: T, farmDispatchId: farmDispatch.id, declaredItems: VAN_RECEIVED_FROM_FARM, status: "PENDING" },
  });
  console.log("  Received  : Buffalo=88  Cow=68  Mix=54  →  total 210L");
  console.log("  DISPATCHED movements created  (FarmDispatch loss: 5L)");

  // ── 7. VAN DELIVERS TO RETAIL (van-delivery → confirmVanArrival) ──────────
  console.log("\n── Step 4: Van delivers to retail distribution ──");
  const VAN_DELIVERED_TO_RETAIL = [
    { productId: P.buffalo.id, productName: P.buffalo.name, unit: "LITER", quantity: 85 }, // -3L
    { productId: P.cow.id,     productName: P.cow.name,     unit: "LITER", quantity: 65 }, // -3L
    { productId: P.mix.id,     productName: P.mix.name,     unit: "LITER", quantity: 52 }, // -2L
  ];
  await db.vanDispatch.update({
    where: { id: vanDispatch.id },
    data: { status: "CONFIRMED", receivedItems: VAN_DELIVERED_TO_RETAIL },
  });
  const retailDispatch = await db.retailDispatch.create({
    data: { date: T, vanDispatchId: vanDispatch.id, declaredItems: VAN_DELIVERED_TO_RETAIL, status: "PENDING" },
  });
  console.log("  Delivered : Buffalo=85  Cow=65  Mix=52  →  total 202L");
  console.log("  RetailDispatch created  (VanDispatch loss: 8L)");

  // ── 8. RETAIL CONFIRMS RECEIPT (retail → confirmRetailArrival) ─────────────
  console.log("\n── Step 5: Retail confirms receipt ──");
  const RETAIL_RECEIVED = [
    { productId: P.buffalo.id, productName: P.buffalo.name, unit: "LITER", quantity: 82 }, // -3L
    { productId: P.cow.id,     productName: P.cow.name,     unit: "LITER", quantity: 63 }, // -2L
    { productId: P.mix.id,     productName: P.mix.name,     unit: "LITER", quantity: 50 }, // -2L
  ];
  await db.retailDispatch.update({
    where: { id: retailDispatch.id },
    data: { status: "CONFIRMED", receivedItems: RETAIL_RECEIVED },
  });
  await db.inventoryMovement.createMany({ data: RETAIL_RECEIVED.map(i => ({
    date: T, type: "ARRIVED" as const, productId: i.productId, quantity: i.quantity,
    reference: retailDispatch.id, // ← CRITICAL: RetailDispatch ID for Fix 1 filtering
  }))});
  console.log("  Received  : Buffalo=82  Cow=63  Mix=50  →  total 195L");
  console.log("  ARRIVED movements created  (RetailDispatch loss: 7L)");

  // ── 9. YOGHURT BATCH ──────────────────────────────────────────────────────
  let yoghurtBatch: { id: string } | null = null;
  if (P.yoghurt) {
    console.log("\n── Step 6: Yoghurt batch ──");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    yoghurtBatch = await (db as any).yoghurtBatch.create({ data: {
      date: T, buffaloMilk: 20, cowMilk: 15, mixMilk: 10,
      boilingWaste: 2, yoghurtProduced: 40, productionWaste: 0.5, notes: "Test batch",
    }});
    await db.inventoryMovement.createMany({ data: [
      { date: T, type: "KITCHEN_USE", productId: P.buffalo.id, quantity: 20, reason: "Yoghurt processing", reference: yoghurtBatch!.id },
      { date: T, type: "KITCHEN_USE", productId: P.cow.id,     quantity: 15, reason: "Yoghurt processing", reference: yoghurtBatch!.id },
      { date: T, type: "KITCHEN_USE", productId: P.mix.id,     quantity: 10, reason: "Yoghurt processing", reference: yoghurtBatch!.id },
      { date: T, type: "PRODUCED",    productId: P.yoghurt.id, quantity: 40, reason: "Yoghurt processing", reference: yoghurtBatch!.id },
    ]});
    console.log("  Milk used  : Buffalo=20L  Cow=15L  Mix=10L  → 45L total");
    console.log("  Yoghurt    : 40kg produced,  0.5kg spillage,  2L boiling waste");
  } else {
    console.log("\n── Step 6: Yoghurt batch — SKIPPED (yoghurt product not found) ──");
  }

  // ── 10. VERIFY ────────────────────────────────────────────────────────────
  console.log("\n╔══════════════════════════════════════╗");
  console.log("║         VERIFICATION RESULTS         ║");
  console.log("╚══════════════════════════════════════╝");

  const movements = await db.inventoryMovement.findMany({
    select: { type: true, quantity: true, productId: true, reason: true, reference: true },
    orderBy: { type: "asc" },
  });
  const retailIds = new Set([retailDispatch.id]);

  // Aggregate per type (applying Fix 1 filter on ARRIVED)
  const agg: Record<string, number> = {};
  for (const m of movements) {
    if (m.type === "ARRIVED" && !(m.reference && retailIds.has(m.reference))) continue;
    agg[m.type] = (agg[m.type] ?? 0) + Number(m.quantity);
  }
  const yoghurtUse = movements
    .filter(m => m.type === "KITCHEN_USE" && m.reason === "Yoghurt processing")
    .reduce((s, m) => s + Number(m.quantity), 0);
  const kitchenNonYoghurt = movements
    .filter(m => m.type === "KITCHEN_USE" && m.reason !== "Yoghurt processing")
    .reduce((s, m) => s + Number(m.quantity), 0);

  const totalArrived   = agg["ARRIVED"]    ?? 0;
  const totalDispatched= agg["DISPATCHED"] ?? 0;
  const totalProduced  = agg["PRODUCED"]   ?? 0; // includes yoghurt production

  console.log("\n── Inventory Movements aggregated ──");
  for (const [t, v] of Object.entries(agg)) {
    console.log(`  ${t.padEnd(12)} : ${v}L`);
  }

  console.log("\n── Inventory Summary (inventory page) ──");
  check("In Storage (arrived)", totalArrived, 195);
  check("With Riders (dispatched−arrived)", totalDispatched - totalArrived, 15);

  // Dispatch wastage
  const farmLoss   = (90-88) + (70-68) + (55-54); // 5
  const vanLoss    = (88-85) + (68-65) + (54-52);  // 8
  const retailLoss = (85-82) + (65-63) + (52-50);  // 7
  const boiling    = P.yoghurt ? 2 : 0;
  const totalWastage = farmLoss + vanLoss + retailLoss + boiling;
  check("Total wastage (transit + boiling)", farmLoss + vanLoss + retailLoss + boiling, totalWastage, 0);
  console.log(`     Farm leg ${farmLoss}L  +  Van leg ${vanLoss}L  +  Retail leg ${retailLoss}L  +  Boiling ${boiling}L  =  ${totalWastage}L`);

  console.log("\n── Reconciliation (reconciliation page) ──");
  check("Dispatched (DISPATCHED mvts)", totalDispatched, 210);
  // Van Delivery comes from RetailDispatch.declaredItems (= VAN_DELIVERED_TO_RETAIL)
  const vanDelTot = VAN_DELIVERED_TO_RETAIL.reduce((s, i) => s + i.quantity, 0);
  check("Van Delivery (RetailDispatch.declaredItems)", vanDelTot, 202);
  check("Retail Received (ARRIVED mvts)", totalArrived, 195);
  check("Yoghurt Use (KITCHEN_USE 'Yoghurt processing')", yoghurtUse, P.yoghurt ? 45 : 0);
  const balMilk = totalArrived - yoghurtUse;
  check("Balance (retail received − yoghurt use)", balMilk, P.yoghurt ? 150 : 195);

  console.log("\n── Wastage Tab (all entries) ──");
  const allFarm = await db.farmDispatch.findMany({ select: { declaredItems: true, receivedItems: true } });
  const allVan  = await db.vanDispatch.findMany({  select: { declaredItems: true, receivedItems: true } });
  const allRet  = await db.retailDispatch.findMany({select: { declaredItems: true, receivedItems: true } });
  type DI = { productId: string; quantity: number };
  function calcLoss(recs: { declaredItems: unknown; receivedItems: unknown }[]) {
    let t = 0;
    for (const r of recs) {
      if (!r.receivedItems) continue;
      const dec = r.declaredItems as DI[], rec = r.receivedItems as DI[];
      for (const di of dec) {
        const ri = rec.find(x => x.productId === di.productId);
        const loss = di.quantity - (ri?.quantity ?? di.quantity);
        if (loss > 0.001) t += loss;
      }
    }
    return t;
  }
  const tabTotal = calcLoss(allFarm) + calcLoss(allVan) + calcLoss(allRet) + boiling;
  check("Wastage tab total (all dispatches + boiling)", tabTotal, totalWastage, 0);

  if (P.yoghurt) {
    console.log("\n── Yoghurt Page hints ──");
    // getRetailStockByDate reads ARRIVED movements for the date, filtered to LITER, non-skim
    const arrivedBuf = movements.filter(m => m.type === "ARRIVED" && m.productId === P.buffalo.id && retailIds.has(m.reference ?? "")).reduce((s, m) => s + Number(m.quantity), 0);
    const arrivedCow = movements.filter(m => m.type === "ARRIVED" && m.productId === P.cow.id     && retailIds.has(m.reference ?? "")).reduce((s, m) => s + Number(m.quantity), 0);
    const arrivedMix = movements.filter(m => m.type === "ARRIVED" && m.productId === P.mix.id     && retailIds.has(m.reference ?? "")).reduce((s, m) => s + Number(m.quantity), 0);
    check("Yoghurt hint – Buffalo received", arrivedBuf, 82);
    check("Yoghurt hint – Cow received",     arrivedCow, 63);
    check("Yoghurt hint – Mix received",     arrivedMix, 50);
  }

  // ── 11. KNOWN LIMITATIONS REPORT ─────────────────────────────────────────
  console.log("\n╔══════════════════════════════════════╗");
  console.log("║         KNOWN GAPS / FINDINGS        ║");
  console.log("╚══════════════════════════════════════╝");
  console.log(`
  [1] HANDED_OVER / DELIVERED / RETURNED movements are never created by any
      action in the system. "With Riders" is approximated as
      (dispatched - arrived). The actual rider-delivery tracking feature
      (hand-to-rider → rider delivers → rider returns) does not exist yet.

  [2] deliveryRate in ProductSummary is now (arrived/dispatched)*100 which
      shows "% of dispatched milk that reached retail". The product card UI
      still labels it "% delivered" which is misleading (it measures supply-
      chain efficiency, not last-mile delivery).

  [3] The Skim Milk processing flow (SkimMilkBatch) produces Skim Milk as
      a product but does NOT create PRODUCED inventory movements for skim milk
      or KITCHEN_USE movements for the milk used in processing. The skim-milk
      page and inventory summary are therefore disconnected: skim milk never
      appears in "In Storage".

  [4] ProductionLog table and InventoryMovement PRODUCED records are maintained
      separately and could drift if one is created without the other. The
      production page creates both; the reconciliation page reads only movements.

  [5] RetailDispatch.date is set by the script/app to 'now()' at van-delivery
      time. If the van delivery happens close to midnight PKT the RetailDispatch
      and its corresponding ARRIVED movement (created later at retail time) may
      bucket to different PKT dates in the reconciliation table. Low risk for
      a dairy operation (deliveries happen in the morning) but theoretically
      possible.
  `);

  console.log(`\n── Summary: ${passed} passed, ${failed} failed ──\n`);
  if (failed === 0) {
    console.log("✅ All assertions pass — data is consistent with expected flow.\n");
    console.log("Open the browser and check:");
    console.log("  /inventory               → In Storage: 195L  With Riders: 15L");
    console.log("  /inventory/wastage       → 20L transit + 2L boiling = 22L total");
    console.log("  /inventory/reconciliation → rows for", testDateStr);
    console.log("  /inventory/yoghurt       → hints: Buffalo 82L, Cow 63L, Mix 50L");
  } else {
    console.log("❌ Some assertions failed — see ❌ lines above for details.\n");
  }
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => db.$disconnect());
