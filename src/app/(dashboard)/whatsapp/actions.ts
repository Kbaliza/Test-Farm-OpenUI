"use server";

import { requireRole, FULL_ACCESS } from "@/lib/auth";

import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { normalizePhone, renderTemplate } from "@/lib/whatsapp";
import { computeCustomerOutstanding } from "@/lib/customer-balance";

// ── Types ────────────────────────────────────────────────────────────────────────

export type WhatsappStatus = {
  status: string;               // STARTING | QR | CONNECTED | DISCONNECTED
  qr: string | null;            // data-URL PNG
  connectedNumber: string | null;
  workerOnline: boolean;        // heartbeat within the last ~30s
  dbReady: boolean;
};

export type TemplateRow = {
  id: string;
  name: string;
  body: string;
  active: boolean;
};

export type Recipient = {
  id: string;
  name: string;
  customerCode: string;
  phone: string;
  amount: number;
};

export type LogRow = {
  id: string;
  phone: string;
  body: string;
  status: string;
  error: string | null;
  customerName: string | null;
  sentAt: string | null;
  createdAt: string;
};

export type ActionResult = { ok: true } | { ok: false; error: string };

const SESSION_ID = "default";
const DUE_DATE_LABEL = "5th"; // matches the invoice footer reminder

// ── Connection status ─────────────────────────────────────────────────────────────

export async function getWhatsappStatus(): Promise<WhatsappStatus> {
  await requireRole(FULL_ACCESS);
  try {
    const s = await db.whatsappSession.findUnique({ where: { id: SESSION_ID } });
    const workerOnline = !!s?.lastSeenAt && Date.now() - s.lastSeenAt.getTime() < 30_000;
    return {
      status: s?.status ?? "DISCONNECTED",
      qr: s?.qr ?? null,
      connectedNumber: s?.connectedNumber ?? null,
      workerOnline,
      dbReady: true,
    };
  } catch {
    return { status: "DISCONNECTED", qr: null, connectedNumber: null, workerOnline: false, dbReady: false };
  }
}

export async function requestLogout(): Promise<ActionResult> {
  await requireRole(FULL_ACCESS);
  try {
    await db.whatsappSession.upsert({
      where: { id: SESSION_ID },
      update: { logoutRequested: true },
      create: { id: SESSION_ID, status: "DISCONNECTED", logoutRequested: true },
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to request logout." };
  }
}

// ── Templates ──────────────────────────────────────────────────────────────────────

export async function getTemplates(): Promise<{ templates: TemplateRow[]; dbReady: boolean }> {
  await requireRole(FULL_ACCESS);
  try {
    const rows = await db.messageTemplate.findMany({ orderBy: { name: "asc" } });
    return {
      templates: rows.map((t) => ({ id: t.id, name: t.name, body: t.body, active: t.active })),
      dbReady: true,
    };
  } catch {
    return { templates: [], dbReady: false };
  }
}

export async function createTemplate(name: string, body: string): Promise<ActionResult> {
  await requireRole(FULL_ACCESS);
  if (!name.trim()) return { ok: false, error: "Template name is required." };
  if (!body.trim()) return { ok: false, error: "Message body is required." };
  try {
    await db.messageTemplate.create({ data: { name: name.trim(), body: body.trim() } });
    revalidatePath("/whatsapp");
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to create template.";
    if (msg.includes("Unique constraint")) return { ok: false, error: "A template with that name already exists." };
    return { ok: false, error: msg };
  }
}

export async function updateTemplate(id: string, data: { name: string; body: string; active: boolean }): Promise<ActionResult> {
  await requireRole(FULL_ACCESS);
  if (!data.name.trim()) return { ok: false, error: "Template name is required." };
  if (!data.body.trim()) return { ok: false, error: "Message body is required." };
  try {
    await db.messageTemplate.update({
      where: { id },
      data: { name: data.name.trim(), body: data.body.trim(), active: data.active },
    });
    revalidatePath("/whatsapp");
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to update template.";
    if (msg.includes("Unique constraint")) return { ok: false, error: "A template with that name already exists." };
    return { ok: false, error: msg };
  }
}

export async function deleteTemplate(id: string): Promise<ActionResult> {
  await requireRole(FULL_ACCESS);
  try {
    await db.messageTemplate.delete({ where: { id } });
    revalidatePath("/whatsapp");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to delete template." };
  }
}

// ── Outstanding dues (recipients) ───────────────────────────────────────────────────
// Balance per customer computed by the shared helper (see src/lib/customer-balance.ts).

export async function getRecipientsWithDues(): Promise<{ recipients: Recipient[]; dbReady: boolean }> {
  await requireRole(FULL_ACCESS);
  try {
    const customers = await db.customer.findMany({
      where: { status: { not: "DISABLED" } },
      select: { id: true, name: true, customerCode: true, phone: true },
      orderBy: { name: "asc" },
    });
    const outstanding = await computeCustomerOutstanding(customers.map((c) => c.id));

    const recipients: Recipient[] = [];
    for (const c of customers) {
      const amount = outstanding.get(c.id) ?? 0;
      if (amount > 0 && normalizePhone(c.phone)) {
        recipients.push({ id: c.id, name: c.name, customerCode: c.customerCode, phone: c.phone, amount: Math.round(amount) });
      }
    }
    recipients.sort((a, b) => b.amount - a.amount);
    return { recipients, dbReady: true };
  } catch {
    return { recipients: [], dbReady: false };
  }
}

// ── Enqueue messages (worker picks up PENDING rows) ─────────────────────────────────

export async function enqueueTest(phone: string, body: string): Promise<ActionResult> {
  await requireRole(FULL_ACCESS);
  const normalized = normalizePhone(phone);
  if (!normalized) return { ok: false, error: "Enter a valid phone number." };
  if (!body.trim()) return { ok: false, error: "Message body is empty." };
  try {
    await db.whatsappMessageLog.create({
      data: { phone: normalized, body: body.trim(), status: "PENDING" },
    });
    revalidatePath("/whatsapp");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to queue message." };
  }
}

export async function enqueueToCustomers(
  templateId: string,
  customerIds: string[]
): Promise<{ ok: true; queued: number; skipped: number } | { ok: false; error: string }> {
  await requireRole(FULL_ACCESS);
  if (!templateId) return { ok: false, error: "Select a template." };
  if (!customerIds.length) return { ok: false, error: "Select at least one customer." };
  try {
    const template = await db.messageTemplate.findUnique({ where: { id: templateId } });
    if (!template) return { ok: false, error: "Template not found." };

    const customers = await db.customer.findMany({
      where: { id: { in: customerIds } },
      select: { id: true, name: true, customerCode: true, phone: true },
    });
    const outstanding = await computeCustomerOutstanding(customerIds);

    let queued = 0, skipped = 0;
    for (const c of customers) {
      const normalized = normalizePhone(c.phone);
      if (!normalized) { skipped++; continue; }
      const amount = Math.round(outstanding.get(c.id) ?? 0);
      const body = renderTemplate(template.body, {
        name: c.name,
        amount: amount.toLocaleString("en-PK"),
        dueDate: DUE_DATE_LABEL,
        customerCode: c.customerCode,
      });
      await db.whatsappMessageLog.create({
        data: { customerId: c.id, templateId: template.id, phone: normalized, body, status: "PENDING" },
      });
      queued++;
    }
    revalidatePath("/whatsapp");
    return { ok: true, queued, skipped };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to queue messages." };
  }
}

// ── Message log ─────────────────────────────────────────────────────────────────────

export async function getMessageLog(): Promise<{ logs: LogRow[]; dbReady: boolean }> {
  await requireRole(FULL_ACCESS);
  try {
    const rows = await db.whatsappMessageLog.findMany({ orderBy: { createdAt: "desc" }, take: 60 });
    const custIds = [...new Set(rows.map((r) => r.customerId).filter(Boolean) as string[])];
    const customers = custIds.length
      ? await db.customer.findMany({ where: { id: { in: custIds } }, select: { id: true, name: true } })
      : [];
    const nameById = new Map(customers.map((c) => [c.id, c.name]));

    return {
      logs: rows.map((r) => ({
        id: r.id,
        phone: r.phone,
        body: r.body,
        status: r.status,
        error: r.error,
        customerName: r.customerId ? nameById.get(r.customerId) ?? null : null,
        sentAt: r.sentAt ? r.sentAt.toISOString() : null,
        createdAt: r.createdAt.toISOString(),
      })),
      dbReady: true,
    };
  } catch {
    return { logs: [], dbReady: false };
  }
}
