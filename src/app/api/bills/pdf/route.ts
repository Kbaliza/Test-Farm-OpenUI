import { NextResponse, type NextRequest } from "next/server";
import { requireRole, FULL_ACCESS } from "@/lib/auth";
import { makeZip } from "@/lib/zip";
import { db } from "@/lib/db";
import { getBillingOverview } from "@/app/(dashboard)/billing/invoices/actions";
import {
  MAX_BILLS_PER_ZIP,
  billFileName,
  renderBillPdfs,
  uniqueNames,
} from "@/lib/invoice-pdf";

// Downloading bills as PDF files.
//
//   GET /api/bills/pdf?id=<invoiceId>                  → one PDF
//   GET /api/bills/pdf?year=&month=&half=[&shift=]     → a zip, one PDF per customer
//
// A route handler rather than a server action, because the point is a file with a
// name: a Content-Disposition header the browser saves straight to disk. An action
// can only hand back data for JavaScript to deal with, which is how you end up
// opening a tab and asking the person to choose "Save as PDF" themselves.
//
// proxy.ts excludes /api/ from its matcher, so nothing upstream has checked who
// this is — requireRole does it here, first thing.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Printing a whole shift is minutes of work, not seconds.
export const maxDuration = 600;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** "16–30 Sep 2026" — the same wording the bill itself carries. */
function periodLabel(year: number, month: number, half: number) {
  const from = half === 1 ? 1 : 16;
  const to = half === 1 ? 15 : daysInMonth(year, month);
  return `${from}\u2013${to} ${MONTHS[month - 1]} ${year}`;
}

/**
 * RFC 5987, because these names have spaces, brackets and en dashes in them.
 *
 * `filename` is the plain fallback for old clients; `filename*` carries the real
 * one, percent-encoded. Quotes and backslashes are stripped from the fallback so
 * they cannot break out of the quoted string.
 */
function disposition(name: string) {
  const plain = name.replace(/["\\]/g, "").replace(/[^\x20-\x7e]/g, "_");
  return `attachment; filename="${plain}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function bad(error: string, status = 400) {
  return NextResponse.json({ error }, { status });
}

export async function GET(req: NextRequest) {
  // requireRole THROWS. Uncaught in a route handler that is a 500 with no body,
  // the browser cannot read a message out of it, and the office is told "those
  // bills could not be turned into PDFs" when the truth is that they need to sign
  // in again. Every exit from here carries a sentence.
  try {
    return await handle(req);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Something went wrong making the PDFs.";
    console.error("[bills/pdf]", e);
    // AuthError is the only expected throw; anything else is worth a 500 but is
    // still reported in words rather than as a blank page.
    const status = /signed in|permission/i.test(message) ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

async function handle(req: NextRequest) {
  await requireRole(FULL_ACCESS);

  // The caller's own cookies go to the headless browser, so it sees exactly what
  // they would see and nothing more.
  const cookieHeader = req.headers.get("cookie") ?? "";
  if (!cookieHeader) return bad("Sign in again before downloading bills.", 401);

  const sp = req.nextUrl.searchParams;
  const id = sp.get("id");

  // ── One bill ───────────────────────────────────────────────────────────────
  if (id) {
    const inv = await db.invoice.findUnique({
      where: { id },
      select: {
        year: true, month: true, half: true,
        customer: { select: { name: true, invoiceName: true, customerCode: true } },
      },
    });
    if (!inv) return bad("That bill is no longer here.", 404);

    const fileName = billFileName({
      customerName: inv.customer.invoiceName || inv.customer.name,
      customerCode: inv.customer.customerCode,
      periodLabel: periodLabel(inv.year, inv.month, inv.half),
    });

    try {
      const [done] = await renderBillPdfs([{ id, fileName }], cookieHeader);
      if (!done) return bad("The bill could not be turned into a PDF.", 500);
      return new NextResponse(new Uint8Array(done.pdf), {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": disposition(fileName),
          "Content-Length": String(done.pdf.length),
          "Cache-Control": "no-store",
        },
      });
    } catch (e) {
      console.error("[bills/pdf] single", e);
      return bad(e instanceof Error ? e.message : "The bill could not be turned into a PDF.", 500);
    }
  }

  // ── A whole period, optionally one shift ───────────────────────────────────
  const year = Number(sp.get("year"));
  const month = Number(sp.get("month"));
  const half = Number(sp.get("half"));
  const shiftId = sp.get("shift") || null;

  if (!Number.isInteger(year) || year < 2020 || year > 2100) return bad("Pick a valid year.");
  if (!Number.isInteger(month) || month < 1 || month > 12) return bad("Pick a valid month.");
  if (half !== 1 && half !== 2) return bad("Pick the first or the second half of the month.");

  const [allInvoices, overview] = await Promise.all([
    db.invoice.findMany({
      where: {
        year, month, half,
        ...(shiftId ? { customer: { shiftId } } : {}),
      },
      select: {
        id: true,
        customer: { select: { name: true, invoiceName: true, customerCode: true } },
      },
      orderBy: { customer: { name: "asc" } },
    }),
    // The same live totals the Customer Bills list shows, so "zero" here is the
    // zero the office sees on screen.
    getBillingOverview(year, month, half),
  ]);

  // A bill that comes to nothing is not printed: it stays on the page, but the zip
  // is what goes out to customers, and a Rs 0 bill is paper for nobody. A credit
  // (below zero) still goes — the customer should know we owe them.
  const dueByInvoice = new Map(overview.customers.filter((c) => c.invoiceId).map((c) => [c.invoiceId!, c.totalDue]));
  const invoices = allInvoices.filter((inv) => {
    const due = dueByInvoice.get(inv.id);
    return due === undefined || Math.round(due) !== 0;
  });
  const skippedZero = allInvoices.length - invoices.length;

  if (allInvoices.length && !invoices.length) {
    return bad(`Every bill for ${shiftId ? "that shift and period" : "that period"} comes to Rs 0 — there is nothing to download.`, 404);
  }
  if (!invoices.length) {
    return bad(
      shiftId
        ? "No bills have been generated for that shift and period yet."
        : "No bills have been generated for that period yet.",
      404,
    );
  }
  if (invoices.length > MAX_BILLS_PER_ZIP) {
    return bad(
      `That is ${invoices.length} bills, more than the ${MAX_BILLS_PER_ZIP} this can do at once. Download one shift at a time.`,
    );
  }

  const label = periodLabel(year, month, half);
  // Names are made unique AFTER sorting, so the numbering is stable rather than
  // depending on which bill happened to render first.
  const names = uniqueNames(
    invoices.map((inv) =>
      billFileName({
        customerName: inv.customer.invoiceName || inv.customer.name,
        customerCode: inv.customer.customerCode,
        periodLabel: label,
      }),
    ),
  );

  let rendered;
  try {
    rendered = await renderBillPdfs(
      invoices.map((inv, i) => ({ id: inv.id, fileName: names[i] })),
      cookieHeader,
    );
  } catch (e) {
    console.error("[bills/pdf] bulk", e);
    return bad(e instanceof Error ? e.message : "Those bills could not be turned into PDFs.", 500);
  }

  const shift = shiftId
    ? await db.shift.findUnique({ where: { id: shiftId }, select: { name: true } })
    : null;
  const zipName = billFileName({
    customerName: shift ? `Bills ${shift.name}` : "Bills",
    customerCode: "",
    periodLabel: label,
  }).replace(/\.pdf$/, ".zip");

  const body = makeZip(rendered.filter(Boolean).map((f) => ({ name: f.fileName, data: f.pdf })));
  return new NextResponse(new Uint8Array(body), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": disposition(zipName),
      "Content-Length": String(body.length),
      "Cache-Control": "no-store",
      // How many Rs 0 bills were left out, for the message on screen.
      "X-Bills-Skipped-Zero": String(skippedZero),
    },
  });
}
