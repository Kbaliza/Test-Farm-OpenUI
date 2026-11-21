import { PrismaClient, ProductUnit, ShiftType } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  // Products
  const products = [
    { name: "Cow Milk", unit: ProductUnit.LITER, defaultRate: 220 },
    { name: "Buffalo Milk", unit: ProductUnit.LITER, defaultRate: 280 },
    { name: "Mix Milk", unit: ProductUnit.LITER, defaultRate: 250 },
    { name: "Eggs", unit: ProductUnit.PIECE, defaultRate: 25 },
    { name: "Ghee", unit: ProductUnit.KG, defaultRate: 3500 },
    { name: "Yoghurt", unit: ProductUnit.KG, defaultRate: 260 },
    { name: "Skim Milk", unit: ProductUnit.LITER, defaultRate: 0 },
    { name: "Cream", unit: ProductUnit.KG, defaultRate: 0 },
  ];
  for (const p of products) {
    await db.product.upsert({
      where: { name: p.name },
      update: { unit: p.unit, defaultRate: p.defaultRate },
      create: p,
    });
  }

  // Shifts
  await db.shift.upsert({
    where: { name: "Morning" },
    update: {},
    create: { name: "Morning", type: ShiftType.MORNING, startTime: "06:00" },
  });
  await db.shift.upsert({
    where: { name: "Evening" },
    update: {},
    create: { name: "Evening", type: ShiftType.EVENING, startTime: "17:00" },
  });

  // Areas
  const areas = [
    { name: "DHA Phase 5", city: "Lahore", defaultDeliveryCharge: 0 },
    { name: "Gulberg", city: "Lahore", defaultDeliveryCharge: 50 },
    { name: "Bahria Town", city: "Lahore", defaultDeliveryCharge: 100 },
  ];
  for (const a of areas) {
    await db.area.upsert({
      where: { name: a.name },
      update: a,
      create: a,
    });
  }

  // Expense categories
  const categories = [
    "Rider Fuel",
    "Animal Feed",
    "Salaries",
    "Medical",
    "Vendor Payments",
    "Agriculture",
    "Fixed costs",
    "Other",
  ];
  for (const name of categories) {
    await db.expenseCategory.upsert({
      where: { name },
      update: {},
      create: { name },
    });
  }

  console.log("Seed complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
