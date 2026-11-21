/**
 * WhatsApp worker — standalone, long-running process.
 * Run with: npm run wa   (separate terminal from `npm run dev`)
 *
 * Owns the whatsapp-web.js client and talks to the Next app ONLY through the
 * database (WhatsappSession + WhatsappMessageLog). Nothing under src/ imports
 * whatsapp-web.js, so Chromium never enters the Next build.
 *
 * Run a SINGLE instance only (LocalAuth session lock).
 */
import { PrismaClient } from "@prisma/client";
import QRCode from "qrcode";
// whatsapp-web.js is CommonJS — default-import then destructure (robust under tsx).
import pkg from "whatsapp-web.js";
import { normalizePhone, toChatId } from "../src/lib/whatsapp";

const { Client, LocalAuth } = pkg;

const db = new PrismaClient();
const SESSION_ID = "default";
const POLL_MS = 4000;
const STALE_SENDING_MS = 2 * 60 * 1000;
const MAX_ATTEMPTS = 3;

let ready = false;

async function setSession(data: {
  status?: string;
  qr?: string | null;
  connectedNumber?: string | null;
  logoutRequested?: boolean;
}) {
  await db.whatsappSession.upsert({
    where: { id: SESSION_ID },
    update: { ...data, lastSeenAt: new Date() },
    create: { id: SESSION_ID, status: data.status ?? "STARTING", ...data, lastSeenAt: new Date() },
  });
}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: ".wwebjs_auth" }),
  puppeteer: {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
});

client.on("qr", async (qr) => {
  try {
    const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
    ready = false;
    await setSession({ status: "QR", qr: dataUrl, connectedNumber: null });
    console.log("[wa] QR updated — scan it on the Connect tab.");
  } catch (e) {
    console.error("[wa] failed to render QR", e);
  }
});

client.on("authenticated", () => {
  console.log("[wa] authenticated.");
});

client.on("ready", async () => {
  ready = true;
  const number = client.info?.wid?.user ?? null;
  await setSession({ status: "CONNECTED", qr: null, connectedNumber: number, logoutRequested: false });
  console.log(`[wa] CONNECTED as ${number}.`);
});

client.on("auth_failure", async (m) => {
  ready = false;
  await setSession({ status: "DISCONNECTED", qr: null });
  console.error("[wa] auth_failure", m);
});

client.on("disconnected", async (reason) => {
  ready = false;
  await setSession({ status: "DISCONNECTED", qr: null, connectedNumber: null });
  console.warn("[wa] disconnected:", reason, "— restart `npm run wa` to reconnect.");
});

// ── Outbound queue processing ──────────────────────────────────────────────────

async function processQueue() {
  if (!ready) return;
  // Fetch a small batch of pending messages (oldest first).
  const pending = await db.whatsappMessageLog.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
    take: 10,
  });

  for (const row of pending) {
    // Atomically claim the row so it can never be sent twice.
    const claim = await db.whatsappMessageLog.updateMany({
      where: { id: row.id, status: "PENDING" },
      data: { status: "SENDING", attempts: { increment: 1 } },
    });
    if (claim.count !== 1) continue;

    const normalized = normalizePhone(row.phone);
    if (!normalized) {
      await db.whatsappMessageLog.update({
        where: { id: row.id },
        data: { status: "FAILED", error: "Invalid phone number" },
      });
      continue;
    }

    try {
      await client.sendMessage(toChatId(normalized), row.body);
      await db.whatsappMessageLog.update({
        where: { id: row.id },
        data: { status: "SENT", sentAt: new Date(), error: null },
      });
      console.log(`[wa] sent → ${normalized}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "send failed";
      await db.whatsappMessageLog.update({
        where: { id: row.id },
        data: { status: "FAILED", error: msg.slice(0, 500) },
      });
      console.error(`[wa] send failed → ${normalized}:`, msg);
    }
  }
}

async function tick() {
  try {
    // Heartbeat so the UI can tell the worker is alive.
    await db.whatsappSession.update({
      where: { id: SESSION_ID },
      data: { lastSeenAt: new Date() },
    }).catch(() => {});

    // Honor a logout request from the UI.
    const session = await db.whatsappSession.findUnique({ where: { id: SESSION_ID } });
    if (session?.logoutRequested) {
      console.log("[wa] logout requested.");
      ready = false;
      try { await client.logout(); } catch { /* ignore */ }
      await setSession({ status: "DISCONNECTED", qr: null, connectedNumber: null, logoutRequested: false });
    }

    await processQueue();
  } catch (e) {
    console.error("[wa] tick error", e);
  }
}

async function sweepStaleSending() {
  // Messages stuck in SENDING (worker crashed mid-send) → FAILED, to avoid
  // double-sending. Capped by attempts.
  const cutoff = new Date(Date.now() - STALE_SENDING_MS);
  await db.whatsappMessageLog.updateMany({
    where: { status: "SENDING", createdAt: { lt: cutoff } },
    data: { status: "FAILED", error: "Interrupted (worker restart)" },
  }).catch(() => {});
  // Anything that exceeded the retry cap also fails out.
  await db.whatsappMessageLog.updateMany({
    where: { status: "PENDING", attempts: { gte: MAX_ATTEMPTS } },
    data: { status: "FAILED", error: "Max attempts reached" },
  }).catch(() => {});
}

async function shutdown() {
  console.log("[wa] shutting down…");
  try { await setSession({ status: "DISCONNECTED" }); } catch { /* ignore */ }
  try { await client.destroy(); } catch { /* ignore */ }
  try { await db.$disconnect(); } catch { /* ignore */ }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("unhandledRejection", (r) => console.error("[wa] unhandledRejection", r));

async function main() {
  console.log("[wa] starting WhatsApp worker…");
  await setSession({ status: "STARTING", qr: null });
  await sweepStaleSending();
  await client.initialize();
  setInterval(tick, POLL_MS);
}

main().catch(async (e) => {
  console.error("[wa] fatal", e);
  await db.$disconnect().catch(() => {});
  process.exit(1);
});
