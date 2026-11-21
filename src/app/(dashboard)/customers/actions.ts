"use server";

import { requireRole, FULL_ACCESS } from "@/lib/auth";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  customerFormSchema,
  type CustomerFormValues,
} from "@/lib/validators/customer";
import {
  normalizeReason,
  AUTO_DEACTIVATE_DAYS,
  AUTO_DEACTIVATION_REASON,
} from "@/lib/deactivation-reasons";
import { isShiftDeliveringOnDate, weekdayOfDateStr, type AreaSchedule } from "@/lib/schedule";
import { todayPKTString } from "@/lib/pkt";
import { runningRound } from "@/lib/shift-lock";
import { Prisma } from "@prisma/client";

export type ActionResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

// A customer's rider is whoever runs their shift. Resolved on every write so
// Customer.riderId can never drift from Shift.riderId (see assignRider, which
// re-mirrors it onto the shift's customers when a shift changes hands).
async function riderOfShift(shiftId: string | null | undefined): Promise<string | null> {
  if (!shiftId) return null;
  const shift = await db.shift.findUnique({ where: { id: shiftId }, select: { riderId: true } });
  return shift?.riderId ?? null;
}

// The true next serial in the "C-0001" sequence — scoped to codes matching
// that exact pattern so legacy/test codes with other prefixes (e.g. "T-2008")
// never pollute the sequence. Deliberately NOT "last created row" (that picks
// up whichever row was touched most recently, which can be a stray test/
// legacy row with an unrelated number and make the sequence jump).
async function nextCustomerCodeValue(): Promise<string> {
  const rows = await db.$queryRaw<{ maxnum: number | null }[]>`
    SELECT MAX(CAST(substring("customerCode" from '^C-([0-9]+)$') AS INTEGER)) as maxnum
    FROM "Customer"
    WHERE "customerCode" ~ '^C-[0-9]+$'
  `;
  const next = (rows[0]?.maxnum ?? 0) + 1;
  return `C-${String(next).padStart(4, "0")}`;
}

export async function createCustomer(
  values: CustomerFormValues
): Promise<ActionResult> {
  await requireRole(FULL_ACCESS);
  const parsed = customerFormSchema.safeParse(values);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues.map((i) => i.message).join("; "),
    };
  }
  const v = parsed.data;

  try {
    // The rider always follows the SHIFT — never a value typed on the customer.
    // (The form has no rider field, and a shift can be handed to another rider,
    // so a customer-level rider silently goes stale. Keep it mirrored instead.)
    const riderId = await riderOfShift(v.shiftId);

    // customerCode is server-generated, ignoring whatever the client sent —
    // it's a locked, auto-assigned serial, not user input. Retried a few times
    // in case another create raced us for the same next number.
    let customer: { id: string } | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      const customerCode = await nextCustomerCodeValue();
      try {
        customer = await db.customer.create({
          data: {
            customerCode,
            name: v.name,
            invoiceName: v.invoiceName || null,
            phone: v.phone,
            secondPhone: v.secondPhone || null,
            email: v.email || null,
            address: v.address || null,
            locationUrl: v.locationUrl || null,

            areaId: v.areaId || null,
            shiftId: v.shiftId || null,
            riderId,

            billingType: v.billingType,
            status: v.status,
            customerType: v.customerType || null,
            deliverySequence: v.deliverySequence ?? null,

            joinDate: new Date(v.joinDate),
            openingBalance: new Prisma.Decimal(v.openingBalance),
            creditLimit: new Prisma.Decimal(v.creditLimit),
            deliveryCharge: new Prisma.Decimal(v.deliveryCharge),

            products: {
              create: v.products.map((p) => ({
                productId: p.productId,
                quantity: new Prisma.Decimal(p.quantity),
                ratePerUnit: new Prisma.Decimal(p.ratePerUnit),
                scheduleType: p.scheduleType,
                alternatePattern: p.alternatePattern.map(
                  (q) => new Prisma.Decimal(q)
                ),
                weekdays: p.weekdays,
                anchorDate: p.anchorDate ? new Date(p.anchorDate) : null,
              })),
            },
          },
        });
        break;
      } catch (e) {
        const isCodeCollision =
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === "P2002" &&
          (e.meta?.target as string[] | undefined)?.includes("customerCode");
        if (isCodeCollision && attempt < 4) continue;
        throw e;
      }
    }
    if (!customer) throw new Error("Could not generate a unique customer ID — please try again.");

    // Opening balance becomes the customer's first ledger entry
    if (Number(v.openingBalance) !== 0) {
      await db.ledgerEntry.create({
        data: {
          kind: "CUSTOMER",
          customerId: customer.id,
          description: "Opening balance",
          debit: new Prisma.Decimal(Math.max(v.openingBalance, 0)),
          credit: new Prisma.Decimal(Math.abs(Math.min(v.openingBalance, 0))),
          runningBalance: new Prisma.Decimal(v.openingBalance),
        },
      });
    }

    revalidatePath("/customers");
    revalidatePath("/ledgers");
    revalidatePath("/payments/recovery");
    revalidatePath("/"); // dashboard Active-customers count + Outstanding (opening balance)
    return { ok: true, id: customer.id };
  } catch (e: unknown) {
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      if (e.code === "P2002") {
        return {
          ok: false,
          error: "A duplicate value conflicts with an existing customer record",
        };
      }
    }
    const msg =
      e instanceof Error ? e.message : "Failed to create customer";
    return { ok: false, error: msg };
  }
}

export async function getCatalog() {
  await requireRole(FULL_ACCESS);
  try {
    const [products, areas, shifts] = await Promise.all([
      db.product.findMany({
        // Retail products are not delivered on a round — they are sold at the
        // counter and dropped at shops. Offering one here would put it on a
        // customer's standing order and then onto every route built from it.
        where: { active: true, retailOnly: false },
        orderBy: { name: "asc" },
      }),
      db.area.findMany({ orderBy: { name: "asc" } }),
      db.shift.findMany({ orderBy: { name: "asc" } }),
    ]);
    return { products, areas, shifts, dbReady: true };
  } catch {
    return { products: [], areas: [], shifts: [], dbReady: false };
  }
}

// ── Edit customer ─────────────────────────────────────────────────────────────

export type CustomerEditData = {
  id: string;
  customerCode: string;
  name: string;
  invoiceName: string;
  phone: string;
  secondPhone: string;
  email: string;
  address: string;
  locationUrl: string;
  areaId: string;
  shiftId: string;
  billingType: "CREDIT" | "DAILY";
  status: "ACTIVE" | "INACTIVE" | "RECOVERY" | "DISABLED" | "ON_CALL";
  customerType: string;
  deliverySequence: number | null;
  joinDate: string;
  creditLimit: number;
  deliveryCharge: number;
  products: {
    productId: string;
    quantity: number;
    ratePerUnit: number;
    scheduleType: "DAILY" | "ALTERNATE" | "WEEKLY";
    alternatePattern: number[];
    weekdays: number[];
    anchorDate: string | null;
  }[];
};

export async function getCustomerForEdit(
  id: string
): Promise<{ ok: true; customer: CustomerEditData } | { ok: false; error: string }> {
  await requireRole(FULL_ACCESS);
  try {
    const c = await db.customer.findUnique({
      where: { id },
      include: { products: true },
    });
    if (!c) return { ok: false, error: "Customer not found." };
    return {
      ok: true,
      customer: {
        id: c.id,
        customerCode: c.customerCode,
        name: c.name,
        invoiceName: c.invoiceName ?? "",
        phone: c.phone,
        secondPhone: c.secondPhone ?? "",
        email: c.email ?? "",
        address: c.address ?? "",
        locationUrl: c.locationUrl ?? "",
        areaId: c.areaId ?? "",
        shiftId: c.shiftId ?? "",
        billingType: c.billingType as "CREDIT" | "DAILY",
        status: c.status as "ACTIVE" | "INACTIVE" | "RECOVERY" | "DISABLED" | "ON_CALL",
        customerType: c.customerType ?? "Regular",
        deliverySequence: c.deliverySequence ?? null,
        joinDate: c.joinDate.toISOString().split("T")[0],
        creditLimit: Number(c.creditLimit),
        deliveryCharge: Number(c.deliveryCharge),
        products: c.products.map((p) => ({
          productId: p.productId,
          quantity: Number(p.quantity),
          ratePerUnit: Number(p.ratePerUnit),
          scheduleType: p.scheduleType as "DAILY" | "ALTERNATE" | "WEEKLY",
          alternatePattern: p.alternatePattern.map(Number),
          weekdays: p.weekdays,
          anchorDate: p.anchorDate ? p.anchorDate.toISOString().split("T")[0] : null,
        })),
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to load customer." };
  }
}

export async function updateCustomer(
  id: string,
  values: Omit<CustomerFormValues, "customerCode" | "openingBalance">
): Promise<ActionResult> {
  await requireRole(FULL_ACCESS);
  if (!values.name.trim()) return { ok: false, error: "Name is required." };
  if (!values.phone || values.phone.length < 7) return { ok: false, error: "Phone is required." };
  if (!values.products.length) return { ok: false, error: "Add at least one product." };

  try {
    // A customer cannot be moved on to or off a shift whose round is on the road:
    // the rider's phone shows him the customers of his shifts, so moving one takes
    // the stop off his screen mid-round (or puts a stop on it he has no milk for).
    const before = await db.customer.findUnique({ where: { id }, select: { shiftId: true } });
    const newShift = values.shiftId || null;
    if (before && before.shiftId !== newShift) {
      if (before.shiftId) {
        const road = await runningRound(before.shiftId);
        if (road && (await db.routeStop.count({ where: { routeId: road.routeId, customerId: id } })) > 0) {
          return { ok: false, error: `This customer is a stop on ${road.shiftName}, which is on the road. Move them once the round is finished.` };
        }
      }
      if (newShift) {
        const road = await runningRound(newShift);
        if (road) return { ok: false, error: `${road.shiftName} is on the road — a customer can be added to it once the round is finished.` };
      }
    }
    // Re-mirror the rider from the (possibly changed) shift — this is the fix for
    // riderId going stale when a customer is moved to a shift run by someone else.
    const riderId = await riderOfShift(values.shiftId);

    await db.$transaction(async (tx) => {
      await tx.customer.update({
        where: { id },
        data: {
          name: values.name.trim(),
          invoiceName: values.invoiceName || null,
          phone: values.phone,
          secondPhone: values.secondPhone || null,
          email: values.email || null,
          address: values.address || null,
          locationUrl: values.locationUrl || null,
          areaId: values.areaId || null,
          shiftId: values.shiftId || null,
          riderId,
          billingType: values.billingType,
          status: values.status,
          customerType: values.customerType || null,
          deliverySequence: values.deliverySequence ?? null,
          joinDate: new Date(values.joinDate),
          creditLimit: new Prisma.Decimal(values.creditLimit),
          deliveryCharge: new Prisma.Decimal(values.deliveryCharge),
        },
      });
      // Replace products atomically
      await tx.customerProduct.deleteMany({ where: { customerId: id } });
      await tx.customerProduct.createMany({
        data: values.products.map((p) => ({
          customerId: id,
          productId: p.productId,
          quantity: new Prisma.Decimal(p.quantity),
          ratePerUnit: new Prisma.Decimal(p.ratePerUnit),
          scheduleType: p.scheduleType,
          alternatePattern: p.alternatePattern.map((q) => new Prisma.Decimal(q)),
          weekdays: p.weekdays,
          anchorDate: p.anchorDate ? new Date(p.anchorDate) : null,
        })),
      });
    });
    revalidatePath("/customers");
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to update customer." };
  }
}

export async function toggleCustomerActive(
  id: string,
  currentStatus: string,
  reason?: string
): Promise<ActionResult> {
  await requireRole(FULL_ACCESS);
  if (currentStatus !== "ACTIVE" && currentStatus !== "INACTIVE") {
    return { ok: false, error: "Only ACTIVE / INACTIVE customers can be toggled here." };
  }
  const newStatus = currentStatus === "ACTIVE" ? "INACTIVE" : "ACTIVE";
  try {
    // deactivationReason is not in the generated Prisma client (prisma generate
    // failed while dev server held the DLL), so use raw SQL.
    if (newStatus === "INACTIVE") {
      // Normalize to one of the fixed deactivation reasons so the Lost-customers
      // reason filter has clean buckets (unknown/empty → "No Reason Given").
      const r = normalizeReason(reason);
      await db.$executeRaw`
        UPDATE "Customer"
        SET status = 'INACTIVE', "deactivationReason" = ${r}, "updatedAt" = NOW()
        WHERE id = ${id}
      `;
    } else {
      await db.$executeRaw`
        UPDATE "Customer"
        SET status = 'ACTIVE', "deactivationReason" = NULL, "updatedAt" = NOW()
        WHERE id = ${id}
      `;
    }
    revalidatePath("/customers");
    revalidatePath("/"); // dashboard Active / Lost customer counts
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to update status." };
  }
}

// Bring a lost customer (INACTIVE or DISABLED) back to ACTIVE from the Lost tab.
// Setting updatedAt = NOW() also gives them a fresh auto-deactivation window (see
// reconcileAutoDeactivations), so a manual reactivation isn't immediately undone.
export async function reactivateCustomer(id: string): Promise<ActionResult> {
  await requireRole(FULL_ACCESS);
  try {
    await db.$executeRaw`
      UPDATE "Customer"
      SET status = 'ACTIVE', "deactivationReason" = NULL, "updatedAt" = NOW()
      WHERE id = ${id}
    `;
    revalidatePath("/customers");
    revalidatePath("/"); // dashboard Active / Lost customer counts
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to reactivate customer." };
  }
}

// ── Auto-deactivation ─────────────────────────────────────────────────────────
// Move ACTIVE customers who once received deliveries but have gone AUTO_DEACTIVATE_DAYS
// without one into Lost (status INACTIVE + a system reason). Never-delivered customers
// are left alone: their MAX(delivery date) is NULL and `NULL < cutoff` is never true,
// so the SQL below covers "only once-active customers" for free. This runs on page
// reads (there's no cron), throttled so rapid navigation doesn't re-hit the DB.
let lastAutoDeactivateRun = 0;
const AUTO_DEACTIVATE_THROTTLE_MS = 10 * 60_000; // 10 minutes

export async function reconcileAutoDeactivations(force = false): Promise<number> {
  const now = Date.now();
  if (!force && now - lastAutoDeactivateRun < AUTO_DEACTIVATE_THROTTLE_MS) return 0;
  lastAutoDeactivateRun = now;

  const cutoff = new Date(now - AUTO_DEACTIVATE_DAYS * 86_400_000);
  try {
    // deactivationReason isn't in the generated client, so this stays raw SQL.
    const deactivated = await db.$queryRaw<{ id: string }[]>`
      UPDATE "Customer" c
      SET status = 'INACTIVE',
          "deactivationReason" = ${AUTO_DEACTIVATION_REASON},
          "updatedAt" = NOW()
      WHERE c.status = 'ACTIVE'
        -- Don't re-deactivate someone just reactivated/edited: give them a fresh
        -- window. updatedAt is bumped on reactivation, so it acts as the clock reset.
        AND c."updatedAt" < ${cutoff}
        AND (
          SELECT MAX(d."date") FROM "DeliveryEntry" d
          WHERE d."customerId" = c.id AND d."isReturn" = false
        ) < ${cutoff}
      RETURNING c.id
    `;
    if (deactivated.length) {
      revalidatePath("/customers");
      revalidatePath("/"); // dashboard Active / Lost counts
    }
    return deactivated.length;
  } catch (e) {
    console.error("[reconcileAutoDeactivations]", e);
    return 0;
  }
}

// ── Shift delivery days (drives the "specific day only" schedule picker) ──────
// A shift's delivery days come from its areas' schedules (every-2nd-day, custom
// dates, daily), so which WEEKDAYS are even possible depends on the shift. An
// every-2nd-day shift drifts across the week, so a weekday it serves may only
// come round every other week — the caller shows the real dates for that reason.
export async function getShiftDeliveryDays(
  shiftId: string
): Promise<{ weekdays: number[]; dates: string[]; areas: AreaSchedule[] }> {
  await requireRole(FULL_ACCESS);
  const empty = { weekdays: [], dates: [], areas: [] };
  if (!shiftId) return empty;
  try {
    const shift = await db.shift.findUnique({
      where: { id: shiftId },
      select: {
        areas: {
          select: { scheduleType: true, scheduleInterval: true, scheduleAnchor: true, customDates: true },
        },
      },
    });
    if (!shift) return empty;

    const [y, m, d] = todayPKTString().split("-").map(Number);
    const startMs = Date.UTC(y, m - 1, d);
    const days = new Set<number>();
    const dates: string[] = [];
    // 8 weeks: long enough for an every-2nd-day shift to visit all seven weekdays.
    for (let i = 0; i < 56; i++) {
      const t = new Date(startMs + i * 86_400_000);
      const ds = `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
      if (!isShiftDeliveringOnDate(shift.areas, ds)) continue;
      days.add(weekdayOfDateStr(ds));
      dates.push(ds);
    }
    return { weekdays: [...days].sort((a, b) => a - b), dates, areas: shift.areas };
  } catch (e) {
    console.error("[getShiftDeliveryDays]", e);
    return empty;
  }
}

// Preview only — the real code is generated (and locked in) server-side
// inside createCustomer() at submit time, not from whatever this returns.
export async function nextCustomerCode(): Promise<string> {
  await requireRole(FULL_ACCESS);
  try {
    return await nextCustomerCodeValue();
  } catch {
    return `C-0001`;
  }
}
