"use server";

import { requireRole, FULL_ACCESS } from "@/lib/auth";

import { unitLabel } from "@/lib/units";
import { db } from "@/lib/db";
import { RECEIVE_HEADS, type ReceiveHeadName } from "@/lib/payment-heads";
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { nextCustomerCode } from "../customers/actions";

// ── Types ─────────────────────────────────────────────────────────────────────

export type SampleStatus = "ASSIGNED" | "DELIVERED" | "NOT_DELIVERED" | "FOLLOWUP" | "CONVERTED" | "DECLINED";

/** How the customer paid for a sample. CASH = cash with the rider. The accounts
 *  money may be received into — see RECEIVE_HEADS (never Meezan). */
export type SamplePaymentMethod = ReceiveHeadName;
const PAYMENT_METHODS: readonly string[] = RECEIVE_HEADS;
const isPaymentMethod = (v: unknown): v is SamplePaymentMethod =>
  typeof v === "string" && PAYMENT_METHODS.includes(v);

export type SampleItemRow = {
  productId: string;
  productName: string;
  unit: string;
  quantity: number;
  /** Carried so an edit can send it back unchanged. Without it a round-trip through
   *  the edit dialog would rewrite every item at rate 0, and the rider-cash a
   *  delivery books is Σ(qty × rate). */
  ratePerUnit: number;
};

export type SampleFollowupRow = {
  id: string;
  body: string;
  createdAt: string;
};

export type SampleRow = {
  id: string;
  name: string;
  invoiceName: string;
  phone: string;
  secondPhone: string;
  email: string;
  address: string;
  locationUrl: string;
  areaId: string | null;
  areaName: string | null;
  shiftId: string | null;
  shiftName: string | null;
  status: SampleStatus;
  notes: string;
  deliveredAt: string | null;
  resendCount: number;
  /** What the rider (or office) reported: "DELIVERED" | "NOT_DELIVERED" | null. */
  riderOutcome: string | null;
  notDeliveredReason: string | null;
  paymentMethod: string | null;
  convertedCustomerId: string | null;
  convertedAt: string | null;
  createdAt: string;
  items: SampleItemRow[];
  followups: SampleFollowupRow[];
};

export type SamplePipeline = {
  total: number;
  assigned: number;
  delivered: number;
  notDelivered: number;
  followup: number;
  converted: number;
  declined: number;
};

export type ProductOpt = { id: string; name: string; unit: string; defaultRate: number };
export type AreaOpt = { id: string; name: string; defaultDeliveryCharge: number };
export type ShiftOpt = { id: string; name: string; areaIds: string[] };

export type SamplesPageData = {
  samples: SampleRow[];
  pipeline: SamplePipeline;
  products: ProductOpt[];
  areas: AreaOpt[];
  shifts: ShiftOpt[];
  defaultCustomerCode: string;
  dbReady: boolean;
};

export type ActionResult = { ok: true } | { ok: false; error: string };


// ── Item input ──────────────────────────────────────────────────────────────────

export type SampleItemInput = { productId: string; quantity: number; ratePerUnit?: number };

// ── Data fetch ────────────────────────────────────────────────────────────────

export async function getSamplesPageData(): Promise<SamplesPageData> {
  await requireRole(FULL_ACCESS);
  try {
    // Auto-deliver any samples whose shift route is now COMPLETED (rider app) and
    // book the rider cash — before we read, so the page reflects it immediately.
    await reconcileDeliveredSamples();

    const [samples, grouped, products, areas, shifts, defaultCustomerCode] = await Promise.all([
      db.sampleLead.findMany({
        orderBy: { createdAt: "desc" },
        include: {
          area:  { select: { name: true } },
          shift: { select: { name: true } },
          items: { include: { product: { select: { name: true, unit: true } } } },
          followups: { orderBy: { createdAt: "asc" } },
        },
      }),
      db.sampleLead.groupBy({ by: ["status"], _count: { _all: true } }),
      db.product.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true, unit: true, defaultRate: true } }),
      db.area.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, defaultDeliveryCharge: true } }),
      db.shift.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, areas: { select: { id: true } } } }),
      nextCustomerCode(),
    ]);

    const countOf = (s: SampleStatus) => grouped.find((g) => g.status === s)?._count._all ?? 0;
    const pipeline: SamplePipeline = {
      total:     grouped.reduce((sum, g) => sum + g._count._all, 0),
      assigned:  countOf("ASSIGNED"),
      delivered: countOf("DELIVERED"),
      notDelivered: countOf("NOT_DELIVERED"),
      followup:  countOf("FOLLOWUP"),
      converted: countOf("CONVERTED"),
      declined:  countOf("DECLINED"),
    };

    return {
      samples: samples.map((s) => ({
        id: s.id,
        name: s.name,
        invoiceName: s.invoiceName ?? "",
        phone: s.phone,
        secondPhone: s.secondPhone ?? "",
        email: s.email ?? "",
        address: s.address ?? "",
        locationUrl: s.locationUrl ?? "",
        areaId: s.areaId,
        areaName: s.area?.name ?? null,
        shiftId: s.shiftId,
        shiftName: s.shift?.name ?? null,
        status: s.status as SampleStatus,
        notes: s.notes ?? "",
        deliveredAt: s.deliveredAt ? s.deliveredAt.toISOString() : null,
        resendCount: s.resendCount,
        riderOutcome: s.riderOutcome,
        notDeliveredReason: s.notDeliveredReason,
        paymentMethod: s.paymentMethod,
        convertedCustomerId: s.convertedCustomerId,
        convertedAt: s.convertedAt ? s.convertedAt.toISOString() : null,
        createdAt: s.createdAt.toISOString(),
        items: s.items.map((it) => ({
          productId: it.productId,
          productName: it.product.name,
          unit: unitLabel(it.product.unit),
          quantity: Number(it.quantity),
          ratePerUnit: Number(it.ratePerUnit),
        })),
        followups: s.followups.map((f) => ({
          id: f.id,
          body: f.body,
          createdAt: f.createdAt.toISOString(),
        })),
      })),
      pipeline,
      products: products.map((p) => ({ id: p.id, name: p.name, unit: p.unit, defaultRate: Number(p.defaultRate) })),
      areas: areas.map((a) => ({ id: a.id, name: a.name, defaultDeliveryCharge: Number(a.defaultDeliveryCharge) })),
      shifts: shifts.map((s) => ({ id: s.id, name: s.name, areaIds: (s.areas as { id: string }[]).map((a) => a.id) })),
      defaultCustomerCode,
      dbReady: true,
    };
  } catch (e) {
    console.error("[samples] getSamplesPageData failed:", e);
    return {
      samples: [],
      pipeline: { total: 0, assigned: 0, delivered: 0, notDelivered: 0, followup: 0, converted: 0, declined: 0 },
      products: [], areas: [], shifts: [], defaultCustomerCode: "C-0001", dbReady: false,
    };
  }
}

// Lightweight counts for the dashboard "Leads Pipeline".
export async function getSamplePipeline(): Promise<SamplePipeline> {
  await requireRole(FULL_ACCESS);
  try {
    const grouped = await db.sampleLead.groupBy({ by: ["status"], _count: { _all: true } });
    const countOf = (s: SampleStatus) => grouped.find((g) => g.status === s)?._count._all ?? 0;
    return {
      total:     grouped.reduce((sum, g) => sum + g._count._all, 0),
      assigned:  countOf("ASSIGNED"),
      delivered: countOf("DELIVERED"),
      notDelivered: countOf("NOT_DELIVERED"),
      followup:  countOf("FOLLOWUP"),
      converted: countOf("CONVERTED"),
      declined:  countOf("DECLINED"),
    };
  } catch {
    return { total: 0, assigned: 0, delivered: 0, notDelivered: 0, followup: 0, converted: 0, declined: 0 };
  }
}

// ── Delivery + rider-cash booking ─────────────────────────────────────────────

// Books what a delivered sample was paid: one customerless Payment for
// Σ(qty × rate), into the account the customer paid by.
//   CASH (or not reported) → RIDER_CASH, with `handedOverAt` set so it lands in the
//     manager's awaiting-confirmation bucket on the Rider Cash page.
//   HBL / JazzCash / Easypaisa → straight into that account; no rider cash.
// Idempotent — one booking per delivery round (the sample's resendCount): the
// first delivery and every resend are each charged once.
async function bookSampleRiderCash(sampleId: string, when: Date, method: SamplePaymentMethod | null = null): Promise<void> {
  const head = method && method !== "CASH" ? method : "RIDER_CASH";

  const sample = await db.sampleLead.findUnique({
    where: { id: sampleId },
    select: {
      resendCount: true,
      name: true,
      shift: { select: { riderId: true } },
      items: { select: { quantity: true, ratePerUnit: true } },
    },
  });
  if (!sample) return;
  const round = sample.resendCount;

  // Fast path — skip the work if this round is already booked.
  const already = await db.payment.findFirst({ where: { sampleId, sampleRound: round }, select: { id: true } });
  if (already) return;

  const amount = sample.items.reduce((s, it) => s + Number(it.quantity) * Number(it.ratePerUnit), 0);
  if (amount <= 0) return;

  try {
    await db.payment.create({
      data: {
        sampleId,
        sampleRound: round,
        // The rider running the sample's shift is the one who collected the cash.
        riderId: head === "RIDER_CASH" ? sample.shift?.riderId ?? null : null,
        head,
        amount: new Prisma.Decimal(amount),
        date: when,
        ...(head === "RIDER_CASH" ? { handedOverAt: when } : {}),
        notes: `Sample delivery · ${sample.name}${head !== "RIDER_CASH" ? ` · paid by ${head}` : ""}`,
      },
    });
  } catch (e) {
    // The @@unique([sampleId, sampleRound]) is the real guard — the read above is only a
    // fast path and can't stop two concurrent page loads (reconcile runs on every
    // render) from both getting past it. Losing that race is the correct outcome,
    // not an error: the cash is booked exactly once either way.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return;
    throw e;
  }
}

// Settle the samples that are out with a rider, from what the rider reported.
//
// Runs on samples-page load. Idempotent: only ASSIGNED samples are looked at and
// cash-booking is deduped, so re-runs are safe. Cash is booked BEFORE flipping
// status, so a mid-way failure retries rather than losing it.
//
// A completed round no longer delivers anything by itself — see the note in the
// loop. The only place a round is still consulted is for a timestamp, when the
// rider reported DELIVERED but his report carried no time.
async function reconcileDeliveredSamples(): Promise<void> {
  const pending = await db.sampleLead.findMany({
    where: { status: "ASSIGNED", shiftId: { not: null } },
    select: { id: true, shiftId: true, createdAt: true, assignedAt: true, riderOutcome: true, riderOutcomeAt: true, paymentMethod: true },
  });
  if (pending.length === 0) return;

  // ONE thing settles a sample: the rider's own report. He has it on his round in
  // the app and ticks it delivered (with how it was paid), or not delivered with a
  // reason. That is the person who was there, so it is taken at his word.
  //
  // Nothing is inferred from a round being finished. That used to be the fallback
  // — "no report, but the round is done, so call it delivered" — and it was wrong
  // in the one way that costs money: a sample the rider never answered for was
  // marked Delivered the moment his round closed, and the rider cash was booked
  // against him. Twelve samples and ₨5,420 went through that way in a single week.
  // A round finishing says the rider went out; it says nothing about whether this
  // particular household opened the door.
  //
  // So a sample with no report stays ASSIGNED and waits. That is the honest state:
  // it is out with a rider and nobody has said what happened yet. It shows on the
  // Samples page as still assigned until he answers, or until somebody settles it
  // by hand.
  for (const s of pending) {
    if (s.riderOutcome === "NOT_DELIVERED") {
      await db.sampleLead.update({
        where: { id: s.id },
        data: { status: "NOT_DELIVERED", deliveredAt: null },
      });
      continue;
    }

    // Nothing reported — leave it alone. Never charge for a delivery nobody
    // confirmed.
    if (s.riderOutcome !== "DELIVERED") continue;

    // Delivered. Normally the app stamps when he said it; a report that arrived
    // without its timestamp still counts, so fall back to the round being
    // finished and then to now rather than dropping a real delivery.
    let when = s.riderOutcomeAt;
    if (!when) {
      const route = await db.route.findFirst({
        where: { shiftId: s.shiftId!, status: "COMPLETED", completedAt: { gte: s.assignedAt ?? s.createdAt } },
        orderBy: { completedAt: "asc" },
        select: { completedAt: true },
      });
      when = route?.completedAt ?? new Date();
    }

    await bookSampleRiderCash(s.id, when, isPaymentMethod(s.paymentMethod) ? s.paymentMethod : null);
    await db.sampleLead.update({ where: { id: s.id }, data: { status: "DELIVERED", deliveredAt: when } });
  }
}

// ── Create ────────────────────────────────────────────────────────────────────

export async function createSample(data: {
  name: string;
  phone: string;
  secondPhone?: string;
  email?: string;
  invoiceName?: string;
  address?: string;
  locationUrl?: string;
  areaId?: string;
  shiftId?: string;
  notes?: string;
  items: SampleItemInput[];
}): Promise<ActionResult> {
  await requireRole(FULL_ACCESS);
  if (!data.name.trim())  return { ok: false, error: "Name is required." };
  if (!data.phone.trim()) return { ok: false, error: "Phone number is required." };
  const items = data.items.filter((i) => i.productId && i.quantity > 0);
  if (items.length === 0) return { ok: false, error: "Add at least one sample item with quantity." };

  try {
    await db.sampleLead.create({
      data: {
        name:        data.name.trim(),
        phone:       data.phone.trim(),
        secondPhone: data.secondPhone?.trim() || null,
        email:       data.email?.trim() || null,
        invoiceName: data.invoiceName?.trim() || null,
        address:     data.address?.trim() || null,
        locationUrl: data.locationUrl?.trim() || null,
        areaId:      data.areaId || null,
        shiftId:     data.shiftId || null,
        notes:       data.notes?.trim() || null,
        status:      "ASSIGNED",
        assignedAt:  new Date(),
        items: {
          create: items.map((i) => ({
            productId:   i.productId,
            quantity:    new Prisma.Decimal(i.quantity),
            ratePerUnit: new Prisma.Decimal(i.ratePerUnit ?? 0),
          })),
        },
      },
    });
    revalidatePath("/samples");
    revalidatePath("/customers/pre-delivery");
    revalidatePath("/");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to add sample." };
  }
}

/**
 * Corrects a sample that was entered wrong.
 *
 * What may be edited depends on how far the lead has gone, and the limits are not
 * arbitrary:
 *
 *   CONVERTED  — refused outright. markSampleConverted() handed this lead's
 *     supabaseId to the Customer; the live person is that customer now, and editing
 *     the lead here would quietly diverge from the record everyone else reads.
 *   DELIVERED / FOLLOWUP — contact details yes, ITEMS no. Delivery already booked
 *     rider cash for Σ(qty × rate) via bookSampleRiderCash(), and nothing re-books
 *     or reverses it — changing the items would leave that cash describing a
 *     basket that no longer exists. Changing what was sent is what Resend is for,
 *     and it correctly puts the lead back to ASSIGNED.
 *   ASSIGNED / DECLINED — everything.
 *
 * Deliberately never touches status, deliveredAt, resendCount or createdAt.
 * createdAt in particular is load-bearing: reconcileDeliveredSamples() and the
 * rider's route stops both match on it, so moving it would make the sample jump runs.
 */
export async function updateSample(data: {
  id: string;
  name: string;
  phone: string;
  secondPhone?: string;
  email?: string;
  invoiceName?: string;
  address?: string;
  locationUrl?: string;
  areaId?: string;
  shiftId?: string;
  notes?: string;
  /** Omit entirely to leave the items alone — required once the sample is out. */
  items?: SampleItemInput[];
}): Promise<ActionResult> {
  await requireRole(FULL_ACCESS);
  if (!data.name.trim())  return { ok: false, error: "Name is required." };
  if (!data.phone.trim()) return { ok: false, error: "Phone number is required." };

  try {
    const existing = await db.sampleLead.findUnique({
      where: { id: data.id },
      select: { id: true, status: true },
    });
    if (!existing) return { ok: false, error: "Sample not found." };
    if (existing.status === "CONVERTED") {
      return {
        ok: false,
        error: "This sample has been converted to a customer — edit the customer instead.",
      };
    }

    const itemsLocked = existing.status !== "ASSIGNED" && existing.status !== "DECLINED";
    const items = (data.items ?? []).filter((i) => i.productId && i.quantity > 0);
    // Only enforce "at least one item" when the items are actually being rewritten.
    if (!itemsLocked && data.items && items.length === 0) {
      return { ok: false, error: "Add at least one sample item with quantity." };
    }

    const details = {
      name:        data.name.trim(),
      phone:       data.phone.trim(),
      secondPhone: data.secondPhone?.trim() || null,
      email:       data.email?.trim() || null,
      invoiceName: data.invoiceName?.trim() || null,
      address:     data.address?.trim() || null,
      locationUrl: data.locationUrl?.trim() || null,
      areaId:      data.areaId || null,
      shiftId:     data.shiftId || null,
      notes:       data.notes?.trim() || null,
    };

    await db.$transaction(async (tx) => {
      await tx.sampleLead.update({ where: { id: data.id }, data: details });
      if (!itemsLocked && data.items) {
        // Replace wholesale, as resendSample does — SampleItem has no unique key on
        // (sampleId, productId) to upsert against.
        await tx.sampleItem.deleteMany({ where: { sampleId: data.id } });
        await tx.sampleItem.createMany({
          data: items.map((i) => ({
            sampleId:    data.id,
            productId:   i.productId,
            quantity:    new Prisma.Decimal(i.quantity),
            ratePerUnit: new Prisma.Decimal(i.ratePerUnit ?? 0),
          })),
        });
      }
    });

    revalidatePath("/samples");
    revalidatePath("/customers/pre-delivery");
    revalidatePath("/");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to update sample." };
  }
}

// ── Lifecycle ───────────────────────────────────────────────────────────────────

// Manual override (the rider app did not report, or the office knows better).
// Mirrors the auto path: books the payment by how it was paid, then marks delivered.
export async function markSampleDelivered(id: string, paymentMethod?: string | null): Promise<ActionResult> {
  await requireRole(FULL_ACCESS);
  if (paymentMethod != null && !isPaymentMethod(paymentMethod)) {
    return { ok: false, error: "Choose Cash, HBL, JazzCash or Easypaisa." };
  }
  try {
    const when = new Date();
    const method = paymentMethod ?? null;
    await bookSampleRiderCash(id, when, method);
    await db.sampleLead.update({
      where: { id },
      data: {
        status: "DELIVERED",
        deliveredAt: when,
        riderOutcome: "DELIVERED",
        riderOutcomeAt: when,
        notDeliveredReason: null,
        ...(method ? { paymentMethod: method } : {}),
      },
    });
    revalidatePath("/samples");
    revalidatePath("/customers/pre-delivery");
    revalidatePath("/payments/rider-cash");
    revalidatePath("/");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to update." };
  }
}

/** The run went out but the sample could not be delivered. Nothing is charged;
 *  Resend puts it back on the next run. */
export async function markSampleNotDelivered(id: string, reason: string): Promise<ActionResult> {
  await requireRole(FULL_ACCESS);
  const why = (reason ?? "").trim();
  if (!why) return { ok: false, error: "Say why it was not delivered." };
  try {
    const s = await db.sampleLead.findUnique({ where: { id }, select: { status: true } });
    if (!s) return { ok: false, error: "Sample not found." };
    if (s.status !== "ASSIGNED") return { ok: false, error: "Only a sample that is still out can be marked not delivered." };
    await db.sampleLead.update({
      where: { id },
      data: {
        status: "NOT_DELIVERED",
        deliveredAt: null,
        riderOutcome: "NOT_DELIVERED",
        riderOutcomeAt: new Date(),
        notDeliveredReason: why,
      },
    });
    revalidatePath("/samples");
    revalidatePath("/customers/pre-delivery");
    revalidatePath("/customers/rider-report");
    revalidatePath("/");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to update." };
  }
}

export async function setSampleStatus(id: string, status: SampleStatus): Promise<ActionResult> {
  await requireRole(FULL_ACCESS);
  try {
    await db.sampleLead.update({ where: { id }, data: { status } });
    revalidatePath("/samples");
    revalidatePath("/customers/pre-delivery");
    revalidatePath("/");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to update." };
  }
}

export async function addSampleFollowup(id: string, body: string): Promise<ActionResult> {
  await requireRole(FULL_ACCESS);
  if (!body.trim()) return { ok: false, error: "Follow-up text is required." };
  try {
    // Adding a follow-up moves a delivered sample into the FOLLOWUP stage.
    const sample = await db.sampleLead.findUnique({ where: { id }, select: { status: true } });
    await db.sampleFollowup.create({ data: { sampleId: id, body: body.trim() } });
    if (sample?.status === "DELIVERED") {
      await db.sampleLead.update({ where: { id }, data: { status: "FOLLOWUP" } });
    }
    revalidatePath("/samples");
    revalidatePath("/customers/pre-delivery");
    revalidatePath("/");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to add follow-up." };
  }
}

// Customer asked for another sample: replace items, reset to ASSIGNED.
export async function resendSample(id: string, items: SampleItemInput[]): Promise<ActionResult> {
  await requireRole(FULL_ACCESS);
  const clean = items.filter((i) => i.productId && i.quantity > 0);
  if (clean.length === 0) return { ok: false, error: "Select at least one item with quantity." };
  try {
    await db.$transaction(async (tx) => {
      await tx.sampleItem.deleteMany({ where: { sampleId: id } });
      await tx.sampleItem.createMany({
        data: clean.map((i) => ({
          sampleId:    id,
          productId:   i.productId,
          quantity:    new Prisma.Decimal(i.quantity),
          ratePerUnit: new Prisma.Decimal(i.ratePerUnit ?? 0),
        })),
      });
      await tx.sampleLead.update({
        where: { id },
        data: {
          status: "ASSIGNED",
          deliveredAt: null,
          resendCount: { increment: 1 },
          // A new run: only a route completed from now on can deliver it, and the
          // last run's report no longer applies.
          assignedAt: new Date(),
          riderOutcome: null,
          riderOutcomeAt: null,
          notDeliveredReason: null,
          paymentMethod: null,
        },
      });
    });
    revalidatePath("/samples");
    revalidatePath("/customers/pre-delivery");
    revalidatePath("/");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to resend sample." };
  }
}

// Called after the customer has been created from the conversion form.
// Hands the lead's Supabase login (supabaseId) over to the new Customer so the
// person keeps one login across their whole journey, and clears it from the lead
// (the lead is now CONVERTED and must not resolve as a login target anymore).
export async function markSampleConverted(sampleId: string, customerId: string): Promise<ActionResult> {
  await requireRole(FULL_ACCESS);
  try {
    const lead = await db.sampleLead.findUnique({ where: { id: sampleId }, select: { supabaseId: true } });
    await db.$transaction(async (tx) => {
      if (lead?.supabaseId) {
        await tx.customer.update({ where: { id: customerId }, data: { supabaseId: lead.supabaseId } });
      }
      await tx.sampleLead.update({
        where: { id: sampleId },
        data: { status: "CONVERTED", convertedCustomerId: customerId, convertedAt: new Date(), supabaseId: null },
      });
    });
    revalidatePath("/samples");
    revalidatePath("/customers");
    revalidatePath("/customers/pre-delivery");
    revalidatePath("/");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to link conversion." };
  }
}

/**
 * Deleting a sample takes the rider cash booked for it with it.
 *
 * The payment only points at the sample, so deleting the lead on its own left
 * the money behind with nothing to name it: the rider cash page filled up with
 * rows reading "—", still counted as cash with the rider. If that cash has
 * already been confirmed received it is in the books, and the sample cannot be
 * deleted until the receipt is undone — removing it here would make the day's
 * cash stop adding up.
 */
export async function deleteSample(id: string): Promise<ActionResult> {
  await requireRole(FULL_ACCESS);
  try {
    const received = await db.payment.findFirst({
      where: { sampleId: id, receivedAt: { not: null } },
      select: { amount: true },
    });
    if (received) {
      return {
        ok: false,
        error: `Rs ${Number(received.amount).toLocaleString()} of cash for this sample is already confirmed received. Undo that receipt on the Rider Cash page first, then delete.`,
      };
    }
    // Interactive and on `tx` — the batched array form hangs on this client
    // (see src/lib/db.ts), and it also left the two deletes un-atomic: the
    // sample's payments could go while the sample itself stayed.
    await db.$transaction(async (tx) => {
      await tx.payment.deleteMany({ where: { sampleId: id } });
      await tx.sampleLead.delete({ where: { id } });
    });
    revalidatePath("/payments/rider-cash");
    revalidatePath("/samples");
    revalidatePath("/customers/pre-delivery");
    revalidatePath("/");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to delete." };
  }
}
