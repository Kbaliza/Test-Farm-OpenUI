// Turning a bill into a PDF file.
//
// The bill is already a page — /print/invoice/[id] — and that page is what the
// customer has been receiving for months. So the PDF is made by printing that
// exact page in a headless Chromium rather than by drawing the invoice a second
// time in PDF primitives. A second copy of the design would drift from the first
// the moment either changed, and the customer-facing document is the last place
// that should be allowed to happen.
//
// Chromium comes from Debian's package, pointed at by PUPPETEER_EXECUTABLE_PATH
// — the same arrangement Dockerfile.worker has run in production for months for
// whatsapp-web.js.
//
// Auth: that page sits behind the proxy, which bounces anyone without a session
// to /login. The browser is therefore handed the CALLER'S OWN cookies, so it
// loads the page as the person who asked for it and can see nothing they could
// not see themselves. No service key, no bypass, no signed URL to leak.

import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Browser } from "puppeteer-core";

/** Debian's chromium in the image; puppeteer's own download is skipped at build. */
const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium";

/**
 * Where the browser reaches this app.
 *
 * Itself, over the loopback inside the container — never the public hostname. It
 * keeps the render off the internet and working whatever the domain or TLS does.
 */
const SELF = `http://127.0.0.1:${process.env.PORT || 3000}`;

/**
 * How many bills render at once.
 *
 * Each page is a whole Chromium tab holding a React render, so this is a memory
 * knob as much as a speed one. Three keeps a shift of sixty bills under a minute
 * while leaving the box able to serve everything else it is doing.
 */
const CONCURRENCY = 3;

/** A ceiling on one request, so nobody can ask for the whole year by accident. */
export const MAX_BILLS_PER_ZIP = 300;

export type BillToRender = { id: string; fileName: string };
export type RenderedBill = { fileName: string; pdf: Buffer };

let shared: Browser | null = null;

/**
 * One browser for the process, launched on first use.
 *
 * Starting Chromium costs the better part of a second, and bills are printed in
 * bursts — one now, a whole shift a minute later. Keeping it alive means only the
 * first request pays. It is dropped on disconnect so a crashed browser is
 * replaced rather than being handed out broken for ever.
 */
async function browser(): Promise<Browser> {
  if (shared?.connected) return shared;
  // Checked by hand, because the failure otherwise arrives as "spawn
  // /usr/bin/chromium ENOENT" in a toast, which tells the office nothing.
  if (!existsSync(CHROME)) {
    throw new Error(
      `The PDF browser is not installed on the server (looked for ${CHROME}). ` +
      `If the software was just updated, the deploy that installs it may still be running.`,
    );
  }
  // Somewhere writable for the crash handler, whoever the container runs as.
  //
  // Chromium spawns chrome_crashpad_handler before it does anything else and hands
  // it a database path derived from HOME. With no home directory made for the user,
  // that path did not exist, the handler exited with "--database is required", and
  // the browser went down with it. The profile itself was never the problem:
  // puppeteer already makes a temp one and cleans it up, so passing --user-data-dir
  // as well only risks Chromium handing off to another instance instead of starting.
  const crashes = mkdtempSync(join(tmpdir(), "bills-chromium-crashes-"));
  shared = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      // The container runs as an unprivileged user with no user namespaces, which
      // is where Chromium's own sandbox would otherwise come from.
      "--no-sandbox",
      "--disable-setuid-sandbox",
      // /dev/shm is 64MB by default under Docker and Chromium will exhaust it.
      "--disable-dev-shm-usage",
      "--disable-gpu",
      `--crash-dumps-dir=${crashes}`,
      // Nothing here wants a crash report, and the reporter is what failed to
      // start. Both names: the flag was renamed between Chromium versions and
      // Debian's build may be either.
      "--disable-crash-reporter",
      "--disable-breakpad",
      // A first run on a fresh profile otherwise waits on prompts nobody can answer.
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--font-render-hinting=none",
    ],
  });
  shared.once("disconnected", () => { shared = null; });
  return shared;
}

/**
 * The caller's cookies, addressed by URL rather than by domain.
 *
 * Setting `domain` to "127.0.0.1" does not work: a Domain attribute may not be an
 * IP literal, so Chrome rejects the cookie outright, the page is served the login
 * screen, and the bill comes back as a PDF of a sign-in form. Giving `url`
 * instead makes each one host-only for that address, which is what a cookie on an
 * IP has to be.
 *
 * Only the name and value are copied — the request header carries nothing else —
 * so a Secure cookie from the real HTTPS site is not marked Secure here and will
 * travel over the loopback connection.
 */
function cookiesFor(cookieHeader: string, url: string) {
  return cookieHeader
    .split(";")
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => {
      const i = c.indexOf("=");
      if (i <= 0) return null;
      return { name: c.slice(0, i), value: c.slice(i + 1), url };
    })
    .filter((c): c is { name: string; value: string; url: string } => !!c);
}

/**
 * Render each bill to its own PDF, in the order given.
 *
 * `?pdf=1` tells the print page not to call window.print() — in a headless
 * browser that dialog never opens and the page would simply sit there.
 */
export async function renderBillPdfs(
  bills: BillToRender[],
  cookieHeader: string,
): Promise<RenderedBill[]> {
  if (!bills.length) return [];

  const b = await browser();
  const jar = cookiesFor(cookieHeader, SELF);
  const out: RenderedBill[] = new Array(bills.length);
  let next = 0;

  async function worker() {
    const page = await b.newPage();
    try {
      await page.setViewport({ width: 900, height: 1300, deviceScaleFactor: 1 });
      if (jar.length) await page.setCookie(...jar);
      for (;;) {
        const i = next++;
        if (i >= bills.length) return;
        const bill = bills[i];
        // "load", not "networkidle0": the bill is rendered on the server, so once the
        // document and its stylesheets are in it is complete. Waiting for the network
        // to fall silent let any one lingering request run a bill out of time
        // ("Navigation timeout of 45000 ms exceeded"). A bill that is merely slow —
        // the page rebuilds its lines from the deliveries first — gets one more try.
        const open = () => page.goto(`${SELF}/print/invoice/${bill.id}?pdf=1`, { waitUntil: "load", timeout: 90_000 });
        let res;
        try {
          res = await open();
        } catch (e) {
          if (!(e instanceof Error) || !/timeout/i.test(e.message)) throw e;
          res = await open();
        }
        // The fonts, so the PDF is never printed in the fallback face.
        await page.evaluate(() => document.fonts.ready).catch(() => {});
        // A redirect to /login means the session did not survive; a 404 means the
        // bill is gone. Either way, say so rather than shipping a PDF of a login
        // form under the customer's name.
        const url = page.url();
        if (url.includes("/login")) {
          throw new Error(
            "The server could not sign in to read the bill, so the PDF was stopped. Sign out and in again, then retry.",
          );
        }
        if (res && res.status() >= 400) {
          throw new Error(`The bill for ${bill.fileName.replace(/\.pdf$/, "")} could not be opened (${res.status()}).`);
        }

        const pdf = await page.pdf({
          format: "a4",
          printBackground: true,
          margin: { top: "12mm", bottom: "12mm", left: "10mm", right: "10mm" },
        });
        out[i] = { fileName: bill.fileName, pdf: Buffer.from(pdf) };
      }
    } finally {
      await page.close().catch(() => {});
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, bills.length) }, () => worker()),
  );
  return out;
}

/**
 * A filename a person can read, and a filesystem will accept.
 *
 * "Raja Asim Shahzad (C-1892) — 16–30 Sep 2026.pdf". The code is in it because
 * two customers really do share a name, and the period because a customer has a
 * bill every fortnight — without either, files silently overwrite each other in
 * the downloads folder.
 */
export function billFileName(opts: {
  customerName: string;
  customerCode: string;
  periodLabel: string;
}): string {
  const safe = (s: string) =>
    s
      // Everything Windows, macOS and Linux disagree about, plus control chars.
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const name = safe(opts.customerName) || "Customer";
  const code = safe(opts.customerCode);
  const period = safe(opts.periodLabel);
  const stem = [code ? `${name} (${code})` : name, period].filter(Boolean).join(" — ");
  return `${clampBytes(stem, 200)}.pdf`;
}

/**
 * Trim a string to a byte budget without cutting a character in half.
 *
 * The filesystem limit is 255 BYTES, not characters. Slicing by length looked
 * right in English and produced a 319-byte name for a customer written in Urdu,
 * where every letter is two bytes and these dashes are three. Iterating by code
 * point also keeps an emoji or any astral character whole.
 */
function clampBytes(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  let out = "";
  let used = 0;
  for (const ch of s) {
    const n = Buffer.byteLength(ch, "utf8");
    if (used + n > maxBytes) break;
    out += ch;
    used += n;
  }
  return out.trimEnd();
}

/** Two customers with one name would otherwise overwrite each other inside the zip. */
export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const key = n.toLowerCase();
    const hit = seen.get(key) ?? 0;
    seen.set(key, hit + 1);
    if (!hit) return n;
    const dot = n.lastIndexOf(".");
    return dot > 0 ? `${n.slice(0, dot)} (${hit + 1})${n.slice(dot)}` : `${n} (${hit + 1})`;
  });
}
