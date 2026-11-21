"use server";

import { requireRole, FULL_ACCESS } from "@/lib/auth";

import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { getDateRangePKT, todayPKTString, dateRangeFromToPKT, pktDateWithCurrentTime } from "@/lib/pkt";
import { recentRangeDays, DEFAULT_RECENT_RANGE, type RecentRange, type DateWindow } from "@/lib/expense-ranges";
import { getHeadBalances, checkHeadFunds, guardHeadFundsTx, CONTRA_SETTLEMENT_NOTE, VISIBLE_HEADS } from "@/lib/head-balances";
import { PAYMENT_HEAD_LABELS, OWNERS_HEAD, type PaymentHeadName } from "@/lib/payment-heads";
import { TAXONOMY, SALARY_CATEGORY, VENDOR_CATEGORY, isFreeTextItemCategory, pickerItems, currentItemName } from "@/lib/expense-taxonomy";
import { VENDOR_PAYMENT_CATEGORY, expenseLine, salaryLineFor, vendorKind, vendorPaymentLine } from "@/lib/expense-report-lines";
import { DEPARTMENTS_KEY, isDepartment } from "@/lib/expense-departments";
import { ownerName } from "@/lib/farm-owners";
import { chitSetProblem, chitBytesRemaining, fmtBytes } from "@/lib/expense-chits";
import { lockVendor, applyVendorPayment, reverseVendorPayment } from "@/lib/vendor-settlement";
import { syncRidersToEmployees } from "@/lib/rider-employees";

export type CategoryOption = { id: string; name: string; type: string | null };


export type EmployeeOption = { id: string; name: string; role: string };
export type VendorOption = { id: string; name: string; outstanding: number };
export type RiderOption = { id: string; name: string };

export type HeadBalance = {
  head: string;
  label: string;
  balance: number;
};

export type ExpenseEntry = {
  id: string;
  date: string;
  description: string;
  categoryName: string;
  item: string | null;
  head: string;
  headKey: string;
  amount: number;
  chitReceived: boolean;
  /** Every chit photo on this expense, oldest first. */
  chitUrls: string[];
  kind: "expense" | "salary";
  vendorId: string | null;
  employeeId: string | null;
};

export type BudgetRow = {
  categoryId: string;
  categoryName: string;
  budget: number;
  spent: number;
  daysLeft: number;
};

export type ExpensesPageData = {
  categories: CategoryOption[];
  headBalances: HeadBalance[];
  recentExpenses: ExpenseEntry[];
  budgetRows: BudgetRow[];
  employees: EmployeeOption[];
  vendors: VendorOption[];
  riders: RiderOption[];
  salaryCategoryId: string | null;
  vendorPaymentCategoryId: string | null;
  riderCategoryId: string | null;
  /** Items added from the page, per category, on top of the fixed list. */
  extraItems: Record<string, string[]>;
  dbReady: boolean;
};

/** Where the items people add from the Daily Expenses page are kept. */
const EXTRA_ITEMS_KEY = "expenses.extraItems";

async function readExtraItems(): Promise<Record<string, string[]>> {
  try {
    const row = await db.appSetting.findUnique({ where: { key: EXTRA_ITEMS_KEY } });
    const raw = row ? JSON.parse(row.value) : {};
    const out: Record<string, string[]> = {};
    if (raw && typeof raw === "object") {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === "string" && x.trim() !== "");
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Add an item under a category, for the Item dropdown. The category itself
 * stays fixed — only its list of items grows. Salary, vendor and free-text
 * categories pick their item another way and take none.
 */
export async function addExpenseItem(categoryName: string, item: string): Promise<ExpenseResult & { item?: string }> {
  await requireRole(FULL_ACCESS);
  const cat = (categoryName ?? "").trim();
  const name = (item ?? "").trim().replace(/\s+/g, " ");
  if (!TAXONOMY.some((t) => t.name === cat)) return { ok: false, error: "Unknown category." };
  if (cat === SALARY_CATEGORY || cat === VENDOR_CATEGORY || isFreeTextItemCategory(cat)) return { ok: false, error: "This category does not use a fixed item list." };
  if (name.length < 2 || name.length > 60) return { ok: false, error: "Give the item a name of 2 to 60 characters." };
  try {
    const extra = await readExtraItems();
    // Against the list as the dropdown shows it, so an old name ("Egg Crates")
    // finds the item it became instead of coming back as a second one.
    const have = pickerItems(cat, extra[cat]);
    const wanted = currentItemName(cat, name).toLowerCase();
    const dup = have.find((x) => x.toLowerCase() === wanted);
    if (dup) return { ok: true, item: dup };
    extra[cat] = [...(extra[cat] ?? []), name];
    const value = JSON.stringify(extra);
    await db.appSetting.upsert({ where: { key: EXTRA_ITEMS_KEY }, create: { key: EXTRA_ITEMS_KEY, value }, update: { value } });
    revalidatePath("/payments/expenses");
    return { ok: true, item: name };
  } catch (e) {
    console.error("[addExpenseItem]", e);
    return { ok: false, error: "Could not add the item." };
  }
}

// One definition of a row in the recent feed, used by the page load and by the
// filtered refetch below — two copies would drift the moment either changed.
const RECENT_EXPENSE_INCLUDE = {
  category: true,
  chits: { orderBy: { createdAt: "asc" }, select: { url: true } },
} satisfies Prisma.ExpenseInclude;

const RECENT_SALARY_INCLUDE = {
  employee: { select: { id: true, name: true } },
} satisfies Prisma.SalaryPaymentInclude;

type RecentExpenseRow = Prisma.ExpenseGetPayload<{ include: typeof RECENT_EXPENSE_INCLUDE }>;
type RecentSalaryRow = Prisma.SalaryPaymentGetPayload<{ include: typeof RECENT_SALARY_INCLUDE }>;

function mapExpenseRows(rows: RecentExpenseRow[], vendorByName: Map<string, string>): ExpenseEntry[] {
  return rows.map((e) => {
    let vendorId: string | null = null;
    const desc = e.description ?? "";
    // Handle both old format ("Vendor Payment — Name") and new ("Vendor Payable — Name").
    const vendorMatch = desc.match(/^Vendor Pa(?:yment|yable) — (.+)$/);
    if (vendorMatch) vendorId = vendorByName.get(vendorMatch[1].toLowerCase()) ?? null;
    return {
      id: e.id,
      date: e.date.toISOString(),
      description: desc,
      categoryName: e.category.name,
      item: e.item ? currentItemName(e.category.name, e.item) : null,
      head: HEAD_LABELS[e.head] ?? e.head,
      headKey: e.head,
      amount: Number(e.amount),
      chitReceived: e.chitReceived,
      chitUrls: e.chits.map((c) => c.url),
      kind: "expense",
      vendorId,
      employeeId: null,
    };
  });
}

function mapSalaryRows(rows: RecentSalaryRow[]): ExpenseEntry[] {
  return rows.map((p) => ({
    id: p.id,
    date: p.paidAt.toISOString(),
    description: p.notes && p.notes.trim() ? p.notes : `Salary — ${p.employee?.name ?? "Employee"}`,
    categoryName: "Salary",
    item: null,
    head: HEAD_LABELS[p.head] ?? p.head,
    headKey: p.head,
    amount: Number(p.amount),
    chitReceived: false,
    chitUrls: [],
    kind: "salary",
    vendorId: null,
    employeeId: p.employeeId ?? null,
  }));
}

/**
 * What the page opens on — must match the filter's default of "30d".
 *
 * A function, not a module constant: a constant is evaluated once when the
 * server module is first imported, so on a container that stays up for days
 * "today" would freeze at boot and the window would silently go stale.
 */
function recentDefaultWindow() {
  const { from, to } = recentRangeDays(DEFAULT_RECENT_RANGE);
  return dateRangeFromToPKT(from, to);
}

const HEAD_LABELS: Record<string, string> = PAYMENT_HEAD_LABELS;

type HeadCast = PaymentHeadName;

export async function getExpensesPageData(): Promise<ExpensesPageData> {
  await requireRole(FULL_ACCESS);
  try {
    // Ensure the Type -> Category taxonomy exists (idempotent; runs once). Old
    // flat-only categories keep type=null and are simply not shown in the picker.
    const typed = await db.expenseCategory.count({ where: { type: { not: null } } });
    if (typed < TAXONOMY.length) {
      // Interactive and on `tx` — the batched array form hangs on this client
      // (see src/lib/db.ts). upsert has no createMany equivalent, so these stay
      // one statement each; it runs at most once, when the taxonomy is seeded.
      await db.$transaction(async (tx) => {
        for (const c of TAXONOMY) {
          await tx.expenseCategory.upsert({
            where: { name: c.name },
            update: { type: c.type, active: true },
            create: { name: c.name, type: c.type },
          });
        }
      });
    }

    const monthRange = getDateRangePKT("month");
    const recentWindow = recentDefaultWindow();
    const nowPKT = new Date(Date.now() + 5 * 60 * 60 * 1000);
    const daysInMonth = new Date(nowPKT.getUTCFullYear(), nowPKT.getUTCMonth() + 1, 0).getDate();
    const daysLeft = daysInMonth - nowPKT.getUTCDate();
    const month = nowPKT.getUTCMonth() + 1;
    const year = nowPKT.getUTCFullYear();

    // These reads are independent — run them in parallel (connection_limit > 1).
    const [
      categories,
      recentExpenses,
      headBalances,
      budgets,
      monthExpenseGroups,
      monthSalaryAgg,
      riders,
      vendors,
      vendorBillGroups,
      recentSalaryPayments,
    ] = await Promise.all([
      db.expenseCategory.findMany({ where: { active: true }, orderBy: { name: "asc" } }),
      // The same window the Recent Expenses filter opens on, so the first paint
      // matches the "30D" the control is showing. It used to be the newest 50
      // of all time, which no longer lines up with a labelled window.
      db.expense.findMany({
        where: { date: { gte: recentWindow.gte, lte: recentWindow.lte } },
        orderBy: { date: "desc" }, take: 300,
        include: RECENT_EXPENSE_INCLUDE,
      }),
      // Single source of truth for head balances (same on every screen).
      getHeadBalances(),
      db.monthlyBudget.findMany({ where: { month, year }, include: { category: true } }),
      db.expense.groupBy({
        by: ["categoryId"],
        where: { date: { gte: monthRange.gte, lte: monthRange.lte } },
        _sum: { amount: true },
      }),
      db.salaryPayment.aggregate({ where: { month, year }, _sum: { amount: true } }),
      db.rider.findMany({
        where: { active: true },
        include: { user: { select: { name: true } } },
        orderBy: { user: { name: "asc" } },
      }),
      db.vendor.findMany({ orderBy: { name: "asc" } }),
      db.vendorBill.groupBy({ by: ["vendorId"], _sum: { amount: true, paid: true } }),
      db.salaryPayment.findMany({
        where: { paidAt: { gte: recentWindow.gte, lte: recentWindow.lte } },
        orderBy: { paidAt: "desc" },
        take: 300,
        include: RECENT_SALARY_INCLUDE,
      }),
    ]);

    // Keep every active rider as an active Employee (create/reactivate) — the same
    // sync the Salaries tab uses — so the "whose salary" picker is always complete.
    await syncRidersToEmployees();
    const employees = await db.employee.findMany({ where: { active: true }, orderBy: { name: "asc" } });

    // headBalances comes straight from getHeadBalances() (the canonical helper).

    const spentByCategory: Record<string, number> = {};
    for (const e of monthExpenseGroups) spentByCategory[e.categoryId] = Number(e._sum.amount ?? 0);

    const vendorOutstanding: Record<string, number> = {};
    for (const g of vendorBillGroups) {
      vendorOutstanding[g.vendorId] = Number(g._sum.amount ?? 0) - Number(g._sum.paid ?? 0);
    }

    // Match flexibly so the conditional pickers fire regardless of the exact
    // category label (e.g. "Salary"/"Salaries", "Vendor Payment"/"Vendor").
    const norm = (s: string) => s.toLowerCase();
    const salaryCat =
      categories.find((c) => norm(c.name) === "salary") ??
      categories.find((c) => norm(c.name).includes("salar"));
    const vendorPayCat =
      categories.find((c) => norm(c.name) === "vendor payment") ??
      categories.find((c) => norm(c.name).includes("vendor"));
    const riderCat =
      categories.find((c) => norm(c.name) === "rider fuel") ??
      categories.find((c) => norm(c.name).includes("rider"));

    // Salary payments this month count toward the "Salary" budget.
    const monthSalaryTotal = Number(monthSalaryAgg._sum.amount ?? 0);
    if (salaryCat) {
      spentByCategory[salaryCat.id] = (spentByCategory[salaryCat.id] ?? 0) + monthSalaryTotal;
    }

    // Build a lookup map for vendor name → vendorId (case-insensitive).
    const vendorByName = new Map(vendors.map((v) => [v.name.toLowerCase(), v.id]));

    // Merge generic expenses and salary payments into one recent feed.
    const recent = [
      ...mapExpenseRows(recentExpenses, vendorByName),
      ...mapSalaryRows(recentSalaryPayments),
    ]
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 300);

    return {
      categories: categories.map((c) => ({ id: c.id, name: c.name, type: c.type ?? null })),
      headBalances,
      employees: employees.map((e) => ({ id: e.id, name: e.name, role: e.role ?? "" })),
      vendors: vendors.map((v) => ({ id: v.id, name: v.name, outstanding: vendorOutstanding[v.id] ?? 0 })),
      riders: riders.map((r) => ({ id: r.id, name: r.user.name })),
      salaryCategoryId: salaryCat?.id ?? null,
      vendorPaymentCategoryId: vendorPayCat?.id ?? null,
      riderCategoryId: riderCat?.id ?? null,
      extraItems: await readExtraItems(),
      recentExpenses: recent,
      // One row per category: a budget split by item is several rows, summed.
      budgetRows: [...budgets.reduce((m, b) => {
        const row = m.get(b.categoryId) ?? { categoryId: b.categoryId, categoryName: b.category.name, budget: 0, spent: spentByCategory[b.categoryId] ?? 0, daysLeft };
        row.budget += Number(b.amount);
        return m.set(b.categoryId, row);
      }, new Map<string, { categoryId: string; categoryName: string; budget: number; spent: number; daysLeft: number }>()).values()],
      dbReady: true,
    };
  } catch (e) {
    console.error("[getExpensesPageData]", e);
    return { categories: [], headBalances: [], recentExpenses: [], budgetRows: [], employees: [], vendors: [], riders: [], salaryCategoryId: null, vendorPaymentCategoryId: null, riderCategoryId: null, extraItems: {}, dbReady: false };
  }
}

/**
 * The Recent Expenses feed for one window and (optionally) one category.
 *
 * Filtered in the DATABASE rather than in the browser: the page load only ever
 * sent the 50 most recent rows, so filtering client-side would have searched
 * those 50 and quietly missed everything older in the chosen window.
 *
 * Salary payments carry no categoryId — they are merged in with a fixed
 * "Salary" label — so a category filter includes them only when the chosen
 * category is the salary one, and excludes them otherwise. Without that, asking
 * for "Feed" would still have shown salaries.
 */
export async function getRecentExpenses(
  range: RecentRange | DateWindow,
  categoryId: string | null,
  search?: string | null,
  head?: string | null
): Promise<ExpenseEntry[]> {
  await requireRole(FULL_ACCESS);
  try {
    const { from, to } = recentRangeDays(range);
    const window = dateRangeFromToPKT(from, to);
    const q = (search ?? "").trim();
    // The account it was paid from. Salaries carry one too, so both are narrowed.
    const onHead = head && VISIBLE_HEADS.includes(head) ? { head: head as HeadCast } : {};

    // Is the chosen category the salary one? Same flexible match the page uses,
    // so "Salary"/"Salaries" both work.
    let wantSalaries = true;
    if (categoryId) {
      const cat = await db.expenseCategory.findUnique({ where: { id: categoryId }, select: { name: true } });
      wantSalaries = !!cat && cat.name.toLowerCase().includes("salar");
    }

    // An expense's text is spread over description and item, and the search box
    // sits above a column showing both, so both are matched. insensitive because
    // nobody types "Diesel" the same way twice.
    const expenseText = q
      ? {
          OR: [
            { description: { contains: q, mode: "insensitive" as const } },
            { item: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {};

    // A salary row's description falls back to "Salary — <name>" when it has no
    // notes, so searching a person's name has to reach the employee record —
    // matching notes alone would miss every unnotated salary payment.
    const salaryText = q
      ? {
          OR: [
            { notes: { contains: q, mode: "insensitive" as const } },
            { employee: { is: { name: { contains: q, mode: "insensitive" as const } } } },
          ],
        }
      : {};

    const [expenses, salaries, vendors] = await Promise.all([
      db.expense.findMany({
        where: {
          date: { gte: window.gte, lte: window.lte },
          ...(categoryId ? { categoryId } : {}),
          ...onHead,
          ...expenseText,
        },
        orderBy: { date: "desc" },
        take: 300,
        include: RECENT_EXPENSE_INCLUDE,
      }),
      wantSalaries
        ? db.salaryPayment.findMany({
            where: { paidAt: { gte: window.gte, lte: window.lte }, ...onHead, ...salaryText },
            orderBy: { paidAt: "desc" },
            take: 300,
            include: RECENT_SALARY_INCLUDE,
          })
        : Promise.resolve([]),
      db.vendor.findMany({ select: { id: true, name: true } }),
    ]);

    const vendorByName = new Map(vendors.map((v) => [v.name.toLowerCase(), v.id]));
    return [...mapExpenseRows(expenses, vendorByName), ...mapSalaryRows(salaries)]
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 300);
  } catch (e) {
    console.error("[getRecentExpenses]", e);
    return [];
  }
}

export type ExpenseResult = { ok: true } | { ok: false; error: string };

/**
 * Attach more chit photos to an expense that already exists.
 *
 * Receipts often turn up days after the money went out, so an expense saved
 * with "no chit" has to be able to gain one later without being deleted and
 * re-entered — re-entering would move the head balance twice and lose the
 * original date.
 *
 * The 10 MB cap is per EXPENSE, not per upload, so the check runs against what
 * is already attached plus what is arriving. Checking only the new batch would
 * let ten separate 9 MB uploads through.
 *
 * chitReceived is flipped on here: the column means "we have the paperwork",
 * and leaving it false while photos hang off the row would make the two
 * disagree and the chit column lie.
 */
export async function addChitsToExpense(
  expenseId: string,
  chits: { url: string; bytes: number }[]
): Promise<ExpenseResult> {
  try {
    await requireRole(FULL_ACCESS);
    const incoming = (chits ?? []).filter((c) => c?.url);
    if (incoming.length === 0) return { ok: false, error: "No photos to attach." };

    const expense = await db.expense.findUnique({
      where: { id: expenseId },
      select: { id: true, chits: { select: { bytes: true } } },
    });
    if (!expense) return { ok: false, error: "That expense no longer exists." };

    const existing = expense.chits.map((c) => c.bytes);
    const problem = chitSetProblem([...existing, ...incoming.map((c) => c.bytes)]);
    if (problem) {
      const left = chitBytesRemaining(existing);
      return {
        ok: false,
        error: existing.length
          ? `${problem} This expense already has ${existing.length} photo${existing.length === 1 ? "" : "s"}, leaving ${fmtBytes(left)}.`
          : problem,
      };
    }

    // Interactive and on `tx` — the batched array form hangs on this client
    // (see src/lib/db.ts), and it also left these two writes un-atomic: chits
    // could be attached while the expense was never marked as having a chit.
    await db.$transaction(async (tx) => {
      await tx.expenseChit.createMany({
        data: incoming.map((c) => ({
          expenseId,
          url: c.url,
          bytes: Math.max(0, Math.round(c.bytes) || 0),
        })),
      });
      await tx.expense.update({ where: { id: expenseId }, data: { chitReceived: true } });
    });

    revalidatePath("/payments/expenses");
    return { ok: true };
  } catch (e) {
    console.error("[addChitsToExpense]", e);
    return { ok: false, error: e instanceof Error ? e.message : "Could not attach the chit." };
  }
}

export async function addExpense(data: {
  date: string;
  amount: number;
  description: string;
  categoryId: string;
  head: string;
  item?: string | null; // third-level taxonomy item / sub-item
  chitReceived: boolean;
  /** Uploaded chit photos, only kept when chitReceived. `bytes` is what the
   *  upload endpoint reported, so the 10 MB cap is checked on the whole set. */
  chits?: { url: string; bytes: number }[];
  vendorId?: string;   // Vendor Payable: also reduces the vendor's outstanding bills
  employeeId?: string; // Salary: recorded as a SalaryPayment so it shows in the Salaries tab
  salaryPeriod?: string; // "YYYY-MM" the salary is FOR — so it lands in the right month in the Salaries tab (defaults to the payment date's month)
}): Promise<ExpenseResult> {
  await requireRole(FULL_ACCESS);
  if (!data.description.trim()) return { ok: false, error: "Description is required." };
  // `Number.isFinite` is essential, not just `<= 0`: NaN fails every comparison, so a
  // NaN amount would slip past `<= 0`, pass checkHeadFunds (NaN - x > 0.005 is false),
  // and persist as Expense.amount = NaN — poisoning that head's SUM and silently
  // disabling its overdraft guard everywhere. Every sibling writer guards this.
  if (!Number.isFinite(data.amount) || data.amount <= 0) return { ok: false, error: "Amount must be greater than 0." };
  if (!data.categoryId) return { ok: false, error: "Select a category." };
  if (!data.head) return { ok: false, error: "Select a payment head." };

  // The chit photos, checked as a SET. The upload endpoint caps each file on its
  // own, but only here is the whole group visible, which is where the 10 MB total
  // actually has to hold. Same rule the browser applied before uploading.
  const chits = (data.chits ?? []).filter((c) => c?.url);
  const chitProblem = chitSetProblem(chits.map((c) => c.bytes));
  if (chitProblem) return { ok: false, error: chitProblem };

  try {
    // Block overdrawing the paying head.
    const guard = await checkHeadFunds(data.head, data.amount);
    if (!guard.ok) return guard;

    // Fall back to today if no/blank date is given (like recordPayment does) — an
    // empty string used to split to NaN and produce an Invalid Date that failed the
    // insert with a confusing error.
    //
    // The day comes from PKT but the clock time must too. This was
    //   new Date(y, m - 1, d, now.getHours(), ...)
    // which builds the instant in the SERVER'S timezone and reads the SERVER'S
    // clock — and production runs in UTC. So after 19:00 UTC, when PKT has
    // already rolled into tomorrow, it paired tomorrow's PKT day with today's
    // UTC hour and stored an expense dated a full day in the future: entered at
    // 01:33 PKT on the 8th, saved as the 9th. The row existed but fell outside
    // every window that ends at "today", so it vanished from Recent Expenses and
    // from the ledger, and looked like the save had failed.
    const dayStr = data.date || todayPKTString();
    const [y, m] = dayStr.split("-").map(Number); // only the salary period needs these
    const date = pktDateWithCurrentTime(dayStr);

    // ── Salary → SalaryPayment (canonical; the Salaries tab reads these) ──
    if (data.employeeId) {
      // The salary PERIOD (which month it's for) — explicit if given, else the payment
      // date's month. This is what the Salaries tab groups by, so a salary paid from the
      // Expenses tab now lands in the intended month instead of always the payment month.
      let salM = m, salY = y;
      if (data.salaryPeriod && /^\d{4}-\d{2}$/.test(data.salaryPeriod)) {
        const [py, pm] = data.salaryPeriod.split("-").map(Number);
        salY = py; salM = pm;
      }
      await db.$transaction(async (tx) => {
        await guardHeadFundsTx(tx, data.head, data.amount); // race-free overdraft guard
        await tx.salaryPayment.create({
          data: {
            employeeId: data.employeeId!,
            month: salM,
            year: salY,
            amount: new Prisma.Decimal(data.amount),
            head: data.head as HeadCast,
            notes: data.description.trim(),
            paidAt: date,
          },
        });
      });
      revalidatePath("/payments/salaries");
      revalidatePath("/payments/expenses");
      revalidatePath("/"); // dashboard head-balance / expenses / profit tiles
      return { ok: true };
    }

    // No ceiling on a vendor payment any more: paying more than is owed is allowed
    // here exactly as it is on the Vendors page, and the surplus becomes a credit
    // they owe us. Leaving the check here would mean Daily Expenses refused what the
    // Vendors screen accepted for the identical act.

    // ── Everything else → Expense ──
    // The expense and the vendor-bill settlement it pays for are one action, so
    // they commit together or not at all. Previously the expense was created
    // first and the bills updated after: a failure in between left cash out of
    // the head with no bills applied, or (in the vendors screen's mirror of this)
    // bills marked paid with no cash-out.
    await db.$transaction(async (tx) => {
      // Race-free overdraft guard inside the write (checkHeadFunds above is only a
      // pre-check); serialises concurrent outflows on this head.
      await guardHeadFundsTx(tx, data.head, data.amount);
      const expense = await tx.expense.create({
        data: {
          date,
          categoryId:  data.categoryId,
          amount:      new Prisma.Decimal(data.amount),
          head:        data.head as HeadCast,
          item:        data.item?.trim() || null,
          description: data.description.trim(),
          chitReceived: data.chitReceived,
          // Dropping the photos when the toggle is off matches the old behaviour:
          // "no chit received" must not leave photos behind claiming otherwise.
          chits: data.chitReceived && chits.length
            ? { create: chits.map((c) => ({ url: c.url, bytes: Math.max(0, Math.round(c.bytes) || 0) })) }
            : undefined,
          // Persist the vendor link so deleteExpense() can reverse the FIFO below.
          vendorId:    data.vendorId ?? null,
        },
      });

      // Vendor payment: the same settlement the Vendors page uses, so both entry
      // points produce an identical row set — FIFO the open bills, and bank any
      // surplus as a credit they owe us.
      if (data.vendorId) {
        await lockVendor(tx, data.vendorId);
        const v = await tx.vendor.findUnique({ where: { id: data.vendorId }, select: { name: true } });
        await applyVendorPayment(tx, {
          vendorId: data.vendorId,
          amount: data.amount,
          expenseId: expense.id,
          at: new Date(),
          vendorName: v?.name ?? "Vendor",
        });
      }
    });

    if (data.vendorId) revalidatePath("/payments/vendors");
    revalidatePath("/payments/expenses");
    revalidatePath("/"); // dashboard head-balance / expenses / profit tiles
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to save expense";
    return { ok: false, error: msg };
  }
}

export async function deleteExpense(id: string): Promise<ExpenseResult> {
  await requireRole(FULL_ACCESS);
  try {
    const exp = await db.expense.findUnique({
      where: { id },
      select: { amount: true, vendorId: true, description: true },
    });
    if (!exp) return { ok: false, error: "Expense not found." };

    // A contra-settlement expense is one half of a non-cash netting (paired with a
    // Payment that cancels it on the CASH head). Deleting it alone would un-apply the
    // bill, leave the Payment behind (inventing cash) and strand the receivable bump.
    // Refuse — there is no safe single-row reversal.
    if (exp.description?.startsWith(CONTRA_SETTLEMENT_NOTE)) {
      return {
        ok: false,
        error: "This is a vendor contra-settlement and can't be deleted on its own — it would leave money unaccounted for. Record an opposite bill/sale to reverse it instead.",
      };
    }

    await db.$transaction(async (tx) => {
      // If this expense paid a vendor, un-apply it from their bills before the
      // cash goes back to the head. Deleting used to return the money while
      // leaving VendorBill.paid untouched — the bill stayed settled and the cash
      // came back, permanently understating payables with no way to re-open it.
      //
      // Unwind newest-first (the reverse of the oldest-first FIFO application),
      // so the most recently settled bill re-opens first. The vendor's total
      // outstanding is restored exactly; if several payments interleaved on one
      // bill, the per-bill split can differ from the exact inverse, but the total
      // — which is what's owed — is always right.
      if (exp.vendorId) {
        // The shared reversal: it drops this payment's own surviving advance first,
        // then un-pays bills newest-first, and THROWS if a remainder is left rather
        // than stopping silently. The case that used to strand money: overpay 1500
        // against a 1000 bill, the 500 advance is consumed by a later 800 bill, then
        // this delete has to claw 1500 back out of documents that have moved on.
        await lockVendor(tx, exp.vendorId);
        await reverseVendorPayment(tx, { vendorId: exp.vendorId, amount: Number(exp.amount) });
      }

      await tx.expense.delete({ where: { id } });
    });

    if (exp.vendorId) revalidatePath("/payments/vendors");
    revalidatePath("/payments/expenses");
    revalidatePath("/"); // dashboard head-balance / expenses / profit tiles
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to delete expense";
    return { ok: false, error: msg };
  }
}

// Salary entries shown in the expenses feed are SalaryPayment rows.
export async function deleteSalaryPayment(id: string): Promise<ExpenseResult> {
  await requireRole(FULL_ACCESS);
  try {
    await db.salaryPayment.delete({ where: { id } });
    revalidatePath("/payments/expenses");
    revalidatePath("/payments/salaries");
    revalidatePath("/"); // dashboard head-balance / expenses / profit tiles
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to delete salary payment";
    return { ok: false, error: msg };
  }
}

// ── Monthly expenses report ─────────────────────────────────────────────────────

export type MonthlyEntry = {
  id: string;
  date: string;
  description: string;
  categoryName: string;
  item: string | null;
  head: string;
  headKey: string;
  amount: number;
  kind: "expense" | "salary";
  chitReceived: boolean;
  /** The Monthly Expenses line it is counted on (see expense-report-lines.ts). */
  line: { category: string; item: string };
};

export type MonthlyBreakdown = { name: string; amount: number };

// A category breakdown row with its monthly budget (0 = no budget set).
export type MonthlyCategory = {
  name: string;
  amount: number;
  categoryId: string | null;
  budget: number;
};

/** One budget row: a category, an item inside it ("" = the whole category). */
export type MonthlyBudgetLine = { categoryId: string; category: string; item: string; amount: number };

export type MonthlyExpensesData = {
  month: number;
  year: number;
  total: number;
  count: number;
  entries: MonthlyEntry[];
  byCategory: MonthlyCategory[];
  byHead: MonthlyBreakdown[];
  /** Every budget row this month, item by item. */
  budgets: MonthlyBudgetLine[];
  /** Active categories, for the budget form. */
  categories: { id: string; name: string }[];
  /** Department assignments someone has saved, by lineKey; the rest use the defaults. */
  departments: Record<string, string>;
  /** Items added from the Daily Expenses page, per category — they are lines too. */
  extraItems: Record<string, string[]>;
  /** What the owners paid this month: from their personal accounts (OwnerContribution)
   *  and through Meezan, their shared account. */
  ownerFunding: {
    total: number;
    byOwner: { name: string; amount: number }[];
    /** Each contribution this month — money an owner put into HBL, owed back on Meezan. */
    contributions: { id: string; date: string; owner: string; amount: number; reason: string }[];
  };
  dbReady: boolean;
};

// Every outflow in a month: generic expenses (incl. vendor payments) + salary payments.
export async function getMonthlyExpenses(month: number, year: number): Promise<MonthlyExpensesData> {
  await requireRole(FULL_ACCESS);
  try {
    const PKT = 5 * 60 * 60 * 1000; // PKT midnight = UTC − 5h
    const gte = new Date(Date.UTC(year, month - 1, 1) - PKT);
    const lte = new Date(Date.UTC(year, month, 1) - PKT - 1);

    const [expenses, salaryPayments, categories, budgets, deptSetting, ownerRows, extraItems] = await Promise.all([
      db.expense.findMany({
        where: { date: { gte, lte } },
        include: { category: { select: { name: true } }, vendor: { select: { name: true } } },
        orderBy: { date: "desc" },
      }),
      db.salaryPayment.findMany({
        where: { paidAt: { gte, lte } },
        include: { employee: { select: { name: true, category: true, role: true } } },
        orderBy: { paidAt: "desc" },
      }),
      db.expenseCategory.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
      db.monthlyBudget.findMany({ where: { month, year }, select: { categoryId: true, item: true, amount: true } }),
      db.appSetting.findUnique({ where: { key: DEPARTMENTS_KEY } }),
      db.ownerContribution.findMany({ where: { date: { gte, lte } }, select: { id: true, date: true, owner: true, amount: true, reason: true }, orderBy: { date: "asc" } }),
      readExtraItems(),
    ]);

    // A vendor payment is counted by what that vendor sells us — milk or desi
    // ghee — which is whatever they have sold us most of on the purchase page.
    const paidVendorIds = [...new Set(expenses.filter((e) => e.category.name === VENDOR_PAYMENT_CATEGORY && e.vendorId).map((e) => e.vendorId!))];
    const topProduct = new Map<string, string>();
    if (paidVendorIds.length) {
      const sold = await db.$queryRaw<{ vendorId: string; product: string; amt: number }[]>`
        SELECT p."vendorId", pr.name AS product, SUM(l.amount)::float AS amt
        FROM "OtcPurchase" p
        JOIN "OtcPurchaseLine" l ON l."purchaseId" = p.id
        JOIN "Product" pr ON pr.id = l."productId"
        WHERE p."vendorId" IN (${Prisma.join(paidVendorIds)})
        GROUP BY 1, 2`;
      const best = new Map<string, number>();
      for (const r of sold) {
        if (r.amt > (best.get(r.vendorId) ?? -1)) { best.set(r.vendorId, r.amt); topProduct.set(r.vendorId, r.product); }
      }
    }
    const lineOfExpense = (e: (typeof expenses)[number]) => {
      if (e.category.name !== VENDOR_PAYMENT_CATEGORY) return expenseLine(e.category.name, e.item);
      // Older rows carry the vendor only in the description ("Vendor Payment — X").
      const name = e.vendor?.name ?? (e.description ?? "").match(/— (.+)$/)?.[1]?.trim() ?? null;
      return vendorPaymentLine(vendorKind(e.vendorId ? topProduct.get(e.vendorId) : null, name ?? ""), name);
    };
    const ownerMap = new Map<string, number>();
    for (const o of ownerRows) ownerMap.set(o.owner, (ownerMap.get(o.owner) ?? 0) + Number(o.amount));
    const byOwner = [...ownerMap].map(([id, amount]) => ({ name: ownerName(id), amount }));
    // Paid through Meezan is the owners paying too, from their shared account.
    const throughMeezan =
      expenses.filter((e) => e.head === OWNERS_HEAD).reduce((s, e) => s + Number(e.amount), 0) +
      salaryPayments.filter((p) => p.head === OWNERS_HEAD).reduce((s, p) => s + Number(p.amount), 0);
    if (throughMeezan > 0.005) byOwner.push({ name: "Through Meezan", amount: throughMeezan });
    const ownerFunding = {
      total: byOwner.reduce((s, o) => s + o.amount, 0),
      byOwner: byOwner.sort((a, b) => b.amount - a.amount),
      contributions: ownerRows.map((o) => ({ id: o.id, date: o.date.toISOString(), owner: ownerName(o.owner), amount: Number(o.amount), reason: o.reason })),
    };

    // name → categoryId, and categoryId → budget for this month
    const catIdByName = new Map(categories.map((c) => [c.name, c.id]));
    // A category's budget is all its rows together — the whole-category one and its items'.
    const budgetByCatId = new Map<string, number>();
    for (const b of budgets) budgetByCatId.set(b.categoryId, (budgetByCatId.get(b.categoryId) ?? 0) + Number(b.amount));
    const catNameById = new Map(categories.map((c) => [c.id, c.name]));
    let departments: Record<string, string> = {};
    try { departments = deptSetting ? JSON.parse(deptSetting.value) : {}; } catch { departments = {}; }

    const entries: MonthlyEntry[] = [
      ...expenses.map((e) => ({
        id: e.id,
        date: e.date.toISOString(),
        description: e.description ?? "",
        categoryName: e.category.name,
        item: e.item ? currentItemName(e.category.name, e.item) : null,
        head: HEAD_LABELS[e.head] ?? e.head,
        headKey: e.head,
        amount: Number(e.amount),
        kind: "expense" as const,
        chitReceived: e.chitReceived,
        line: lineOfExpense(e),
      })),
      ...salaryPayments.map((p) => ({
        id: p.id,
        date: p.paidAt.toISOString(),
        description: p.notes && p.notes.trim() ? p.notes : `Salary — ${p.employee?.name ?? "Employee"}`,
        categoryName: "Salary",
        item: null,
        head: HEAD_LABELS[p.head] ?? p.head,
        headKey: p.head,
        amount: Number(p.amount),
        kind: "salary" as const,
        chitReceived: false,
        line: { category: SALARY_CATEGORY, item: salaryLineFor(p.employee) },
      })),
    ].sort((a, b) => b.date.localeCompare(a.date));

    const total = entries.reduce((s, e) => s + e.amount, 0);

    const catMap: Record<string, number> = {};
    for (const e of entries) catMap[e.categoryName] = (catMap[e.categoryName] ?? 0) + e.amount;
    // Always show every active category (zero spend shown as empty) so budgets
    // can be set for all of them, not just the ones with activity this month.
    for (const c of categories) {
      if (!(c.name in catMap)) catMap[c.name] = 0;
    }
    const byCategory: MonthlyCategory[] = Object.entries(catMap)
      .map(([name, amount]) => {
        const categoryId = catIdByName.get(name) ?? null;
        return { name, amount, categoryId, budget: categoryId ? budgetByCatId.get(categoryId) ?? 0 : 0 };
      })
      .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));

    const headMap: Record<string, number> = {};
    for (const e of entries) headMap[e.head] = (headMap[e.head] ?? 0) + e.amount;
    const byHead = Object.entries(headMap)
      .map(([name, amount]) => ({ name, amount }))
      .sort((a, b) => b.amount - a.amount);

    return {
      month, year, total, count: entries.length, entries, byCategory, byHead,
      budgets: budgets
        .filter((b) => catNameById.has(b.categoryId))
        .map((b) => ({ categoryId: b.categoryId, category: catNameById.get(b.categoryId)!, item: b.item, amount: Number(b.amount) })),
      categories,
      departments,
      extraItems,
      ownerFunding,
      dbReady: true,
    };
  } catch (e) {
    console.error("[getMonthlyExpenses]", e);
    return { month, year, total: 0, count: 0, entries: [], byCategory: [], byHead: [], budgets: [], categories: [], departments: {}, extraItems: {}, ownerFunding: { total: 0, byOwner: [], contributions: [] }, dbReady: false };
  }
}

// Set (or clear, when amount <= 0) a category's budget for a given month.
export async function setCategoryBudget(
  categoryId: string,
  month: number,
  year: number,
  amount: number
): Promise<ExpenseResult> {
  await requireRole(FULL_ACCESS);
  if (!categoryId) return { ok: false, error: "Unknown category." };
  try {
    if (!amount || amount <= 0) {
      await db.monthlyBudget.deleteMany({ where: { categoryId, item: "", month, year } });
    } else {
      await db.monthlyBudget.upsert({
        where: { categoryId_item_month_year: { categoryId, item: "", month, year } },
        update: { amount: new Prisma.Decimal(amount) },
        create: { categoryId, month, year, amount: new Prisma.Decimal(amount) },
      });
    }
    revalidatePath("/payments/monthly-expenses");
    revalidatePath("/payments/budgets");
    revalidatePath("/payments/expenses");
    revalidatePath("/"); // dashboard Budget Tracker
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to set budget." };
  }
}

/**
 * Save the month's budgets line by line, and which department each line is in.
 *
 * `lines` is the whole form: a line with 0 removes its budget. Departments are
 * not monthly — moving "Rider/Bike Fuel" to Distribution holds for every month.
 */
export async function saveMonthlyBudgets(input: {
  month: number;
  year: number;
  lines: { categoryId: string; item: string; amount: number }[];
  departments: Record<string, string>;
}): Promise<ExpenseResult> {
  await requireRole(FULL_ACCESS);
  const { month, year } = input;
  if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year) || year < 2000) {
    return { ok: false, error: "Choose a month." };
  }
  for (const l of input.lines) {
    if (!l.categoryId || !Number.isFinite(l.amount) || l.amount < 0) return { ok: false, error: "Every budget must be 0 or more." };
  }
  const departments: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.departments ?? {})) {
    if (isDepartment(v)) departments[k] = v;
  }
  try {
    await db.$transaction(async (tx) => {
      for (const l of input.lines) {
        const item = (l.item ?? "").trim();
        const amount = Math.round(l.amount * 100) / 100;
        if (amount <= 0) {
          await tx.monthlyBudget.deleteMany({ where: { categoryId: l.categoryId, item, month, year } });
        } else {
          await tx.monthlyBudget.upsert({
            where: { categoryId_item_month_year: { categoryId: l.categoryId, item, month, year } },
            update: { amount: new Prisma.Decimal(amount) },
            create: { categoryId: l.categoryId, item, month, year, amount: new Prisma.Decimal(amount) },
          });
        }
      }
      const value = JSON.stringify(departments);
      await tx.appSetting.upsert({ where: { key: DEPARTMENTS_KEY }, create: { key: DEPARTMENTS_KEY, value }, update: { value } });
    }, { maxWait: 10_000, timeout: 30_000 });
    for (const p of ["/payments/monthly-expenses", "/payments/budgets", "/payments/expenses", "/"]) revalidatePath(p);
    return { ok: true };
  } catch (e) {
    console.error("[saveMonthlyBudgets]", e);
    return { ok: false, error: e instanceof Error ? e.message : "Could not save the budgets." };
  }
}
