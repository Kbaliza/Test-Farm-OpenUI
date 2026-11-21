"use server";

import { requireRole, FULL_ACCESS } from "@/lib/auth";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { dateRangeFromToPKT } from "@/lib/pkt";
import { AUDIT_RETENTION_MONTHS } from "@/lib/audit-retention";
import { SYSTEM_ACTOR, ROUTINE_TABLES, INVOICE_REAL_FIELDS, fieldLabel, tableLabel, valueText } from "@/lib/audit-labels";

// Reading the audit log.
//
// Admins and managers, checked twice: the dashboard layout refuses the route via
// RESTRICTED_ROUTES, and every action here asks again — a server action is a POST
// endpoint whether or not a menu item was ever drawn for it.
//
// This is the largest table in the database, so it is read by keyset: newest
// first, a page at a time, with (at, id) as the cursor. An offset would walk the
// whole table to find page fifty.

const PAGE = 100;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** One field that moved, with both values already turned into words. */
export type AuditFieldChange = { field: string; label: string; before: unknown; after: unknown; beforeText: string; afterText: string };

export type AuditEntry = {
  id: string;
  at: string;
  tableName: string;
  rowId: string | null;
  operation: string;
  actorName: string | null;
  actorRole: string | null;
  actorSource: string;
  changedFields: string[];
  changes: AuditFieldChange[];
  /** The whole row, for an add or a delete — where the row IS the change. */
  snapshot: Record<string, unknown> | null;
  /** The same row as a list a person can read: ids named, noise dropped. */
  details: { label: string; text: string }[];
  /** One line in plain words: who did what to whose what. */
  summary: string;
  /** The same line without the "who" — the Who column already says it. */
  action: string;
  /**
   * Which customer the record is about, however indirectly — a bill line reaches
   * its customer through the bill, a round load through its stop. This is the
   * whole point of the page: "Bill line edited" tells nobody anything.
   */
  customerName: string | null;
  /** Which product the record is about. */
  productName: string | null;
  /** Anything else it is about: a staff member, a vendor, a shift, a sample. */
  subject: string | null;
};

export type AuditPage = {
  entries: AuditEntry[];
  /** Pass back as `cursor` for the next page; null when there are no more. */
  nextCursor: string | null;
  tables: string[];
  actors: { id: string; name: string }[];
  products: { id: string; name: string }[];
  /** Either end may be empty — a start date with no end is a valid window. */
  range: { from: string; to: string } | null;
  /** The customer text as applied, and how many customers it matched. */
  customer: { query: string; matched: number } | null;
  retentionMonths: number;
  dbReady: boolean;
  error?: string;
};

export type AuditFilters = {
  from?: string;
  to?: string;
  table?: string;
  actorId?: string;
  operation?: string;
  rowId?: string;
  /** A product id: rows about that product, and the product's own row. */
  productId?: string;
  /** Free text matched against customer name and code. */
  customer?: string;
  /**
   * Include the machinery: bills rebuilt on open, rounds re-saved, settings. Off
   * by default — thousands of rows a week that nobody typed, burying the ones
   * somebody did.
   */
  routine?: boolean;
  cursor?: string;
};

const blank: AuditPage = {
  entries: [], nextCursor: null, tables: [], actors: [], products: [], range: null, customer: null,
  retentionMonths: AUDIT_RETENTION_MONTHS, dbReady: true,
};

function asRecord(v: Prisma.JsonValue | null): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * Every way the log can point at one thing: a row that carries its id in a
 * column, before or after the change, or the thing's own row.
 *
 * The id is compared as a value rather than searched for as text, so this stays
 * an equality test Postgres can evaluate per row without parsing a blob twice.
 */
function refersTo(field: string, id: string, ownTable: string): Prisma.AuditLogWhereInput[] {
  return [
    { after: { path: [field], equals: id } },
    { before: { path: [field], equals: id } },
    { tableName: ownTable, rowId: id },
  ];
}

export async function getAuditLog(filters: AuditFilters = {}): Promise<AuditPage> {
  await requireRole(FULL_ACCESS);
  try {
    const from = filters.from && DAY_RE.test(filters.from) ? filters.from : "";
    const to = filters.to && DAY_RE.test(filters.to) ? filters.to : "";
    const range = from || to ? { from, to } : null;

    // Everything is ANDed explicitly. Several of these filters need an OR of
    // their own, and the keyset cursor does too — hanging them all off one `OR`
    // on the same object meant whichever was assigned last silently replaced the
    // rest, which is why combining filters did nothing.
    const and: Prisma.AuditLogWhereInput[] = [];

    // Either end of the window on its own. "From" used to pin "to" to the same
    // day, so choosing a start date quietly narrowed the view to that one day.
    if (from || to) {
      const at: Prisma.DateTimeFilter = {};
      if (from) at.gte = dateRangeFromToPKT(from, from).gte;
      if (to) at.lte = dateRangeFromToPKT(to, to).lte;
      and.push({ at });
    }
    if (filters.table) and.push({ tableName: filters.table });
    if (filters.operation) and.push({ operation: filters.operation });
    if (filters.rowId) and.push({ rowId: filters.rowId });
    // Scripts, triggers and the worker write with no signed-in user. Those
    // entries were unreachable: they are the ones you most want to look at.
    if (filters.actorId === SYSTEM_ACTOR) and.push({ actorId: null });
    else if (filters.actorId) and.push({ actorId: filters.actorId });

    if (filters.productId) and.push({ OR: refersTo("productId", filters.productId, "Product") });

    // Routine rows out unless asked for: whole tables the software rewrites by
    // itself, and a bill's totals being recomputed (a bill edit that touches a
    // field a person sets — discount, status, due date — stays in).
    if (!filters.routine) {
      and.push({ tableName: { notIn: [...ROUTINE_TABLES] } });
      and.push({ NOT: { AND: [{ tableName: "Invoice" }, { operation: "UPDATE" }, { NOT: { changedFields: { hasSome: [...INVOICE_REAL_FIELDS] } } }] } });
    }

    const customerQuery = (filters.customer ?? "").trim();
    let customerInfo: AuditPage["customer"] = null;
    if (customerQuery) {
      const matches = await db.customer.findMany({
        where: {
          OR: [
            { name: { contains: customerQuery, mode: "insensitive" } },
            { customerCode: { contains: customerQuery, mode: "insensitive" } },
          ],
        },
        select: { id: true },
        take: 50,
      });
      customerInfo = { query: customerQuery, matched: matches.length };
      // Matching nobody must show nothing, never everything.
      and.push(
        matches.length
          ? { OR: matches.flatMap((m) => refersTo("customerId", m.id, "Customer")) }
          : { id: "" },
      );
    }

    // Keyset: everything strictly older than the cursor, in the same order the
    // index is built in.
    if (filters.cursor) {
      const [atStr, id] = filters.cursor.split("|");
      const at = new Date(atStr);
      if (!Number.isNaN(at.getTime())) {
        and.push({ OR: [{ at: { lt: at } }, { at, id: { lt: id } }] });
      }
    }

    const rows = await db.auditLog.findMany({
      where: and.length ? { AND: and } : {},
      orderBy: [{ at: "desc" }, { id: "desc" }],
      take: PAGE + 1,
    });
    const hasMore = rows.length > PAGE;
    const page = hasMore ? rows.slice(0, PAGE) : rows;

    // ── Naming what each entry is about ──────────────────────────────────────
    //
    // The stored row already carries the ids; they just read as gibberish. One
    // batched lookup per kind of reference for the whole page turns them into
    // names, so a line says who and what rather than "Bill line · edited".
    const prepared = page.map((r) => ({ row: r, before: asRecord(r.before), after: asRecord(r.after) }));
    const refOf = (p: (typeof prepared)[number], field: string): string | null => {
      const v = p.after?.[field] ?? p.before?.[field];
      return typeof v === "string" && v ? v : null;
    };
    const idsFor = (field: string, ownTable: string) => {
      const s = new Set<string>();
      for (const p of prepared) {
        const v = refOf(p, field);
        if (v) s.add(v);
        if (p.row.tableName === ownTable && p.row.rowId) s.add(p.row.rowId);
      }
      return [...s];
    };

    const customerIds = idsFor("customerId", "Customer");
    const productIds = idsFor("productId", "Product");
    const riderIds = idsFor("riderId", "Rider");
    const employeeIds = idsFor("employeeId", "Employee");
    const vendorIds = idsFor("vendorId", "Vendor");
    const shiftIds = idsFor("shiftId", "Shift");
    const userIds = idsFor("userId", "User");
    const leadIds = idsFor("sampleLeadId", "SampleLead");
    // Two hops, because these are the noisiest tables on the page and neither
    // carries a customer of its own.
    const invoiceIds = idsFor("invoiceId", "Invoice");
    const stopIds = idsFor("routeStopId", "RouteStop");
    // Everything else a row points at, so the details read as names, not ids.
    const categoryIds = idsFor("categoryId", "ExpenseCategory");
    const areaIds = idsFor("areaId", "Area");
    const routeIds = idsFor("routeId", "Route");
    const checklistIds = idsFor("checklistId", "Checklist");
    const byUserIds = [...new Set([...idsFor("enteredById", "__"), ...idsFor("reviewedById", "__"), ...idsFor("confirmedById", "__"), ...idsFor("assigneeId", "__"), ...idsFor("resolvedById", "__")])];

    const named = async <T extends { id: string }>(
      ids: string[],
      run: (ids: string[]) => Promise<T[]>,
      name: (t: T) => string | null,
    ): Promise<Map<string, string>> => {
      if (!ids.length) return new Map();
      try {
        const found = await run(ids);
        return new Map(found.flatMap((f) => { const n = name(f); return n ? [[f.id, n] as const] : []; }));
      } catch {
        return new Map(); // a name is a nicety; never let it break the page
      }
    };

    const [
      customers, products, riders, employees, vendors, shifts, users, leads, invoices, stops,
      categories, areas, routes, checklists, byUsers,
    ] = await Promise.all([
      named(customerIds, (ids) => db.customer.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, customerCode: true } }),
        (c) => (c.customerCode ? `${c.name} (${c.customerCode})` : c.name)),
      named(productIds, (ids) => db.product.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }), (p) => p.name),
      named(riderIds, (ids) => db.rider.findMany({ where: { id: { in: ids } }, select: { id: true, user: { select: { name: true } } } }), (r) => r.user?.name ?? null),
      named(employeeIds, (ids) => db.employee.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }), (e) => e.name),
      named(vendorIds, (ids) => db.vendor.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }), (v) => v.name),
      named(shiftIds, (ids) => db.shift.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }), (s) => s.name),
      named(userIds, (ids) => db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }), (u) => u.name),
      named(leadIds, (ids) => db.sampleLead.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }), (s) => s.name),
      named(invoiceIds, (ids) => db.invoice.findMany({ where: { id: { in: ids } }, select: { id: true, customer: { select: { name: true, customerCode: true } } } }),
        (i) => (i.customer ? `${i.customer.name} (${i.customer.customerCode})` : null)),
      named(stopIds, (ids) => db.routeStop.findMany({ where: { id: { in: ids } }, select: { id: true, customer: { select: { name: true, customerCode: true } } } }),
        (s) => (s.customer ? `${s.customer.name} (${s.customer.customerCode})` : null)),
      named(categoryIds, (ids) => db.expenseCategory.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }), (c) => c.name),
      named(areaIds, (ids) => db.area.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }), (a) => a.name),
      named(routeIds, (ids) => db.route.findMany({ where: { id: { in: ids } }, select: { id: true, date: true, shift: { select: { name: true } } } }),
        (r) => `${r.shift.name} round, ${r.date.toISOString().slice(0, 10)}`),
      named(checklistIds, (ids) => db.checklist.findMany({ where: { id: { in: ids } }, select: { id: true, title: true } }), (c) => c.title),
      named(byUserIds, (ids) => db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }), (u) => u.name),
    ]);

    // Which lookup answers for which column. A column not here that still ends
    // in "Id" is an id nobody can read, and is left out of the details.
    const nameOf: Record<string, Map<string, string>> = {
      customerId: customers, productId: products, riderId: riders, employeeId: employees, vendorId: vendors,
      shiftId: shifts, userId: users, sampleLeadId: leads, invoiceId: invoices, routeStopId: stops,
      categoryId: categories, areaId: areas, routeId: routes, checklistId: checklists,
      enteredById: byUsers, reviewedById: byUsers, confirmedById: byUsers, assigneeId: byUsers, resolvedById: byUsers,
    };
    const productUnit = new Map<string, string>();
    try {
      for (const p of await db.product.findMany({ select: { id: true, unit: true } })) productUnit.set(p.id, p.unit);
    } catch { /* units are a nicety */ }

    /** A stored value as words: ids named, item lists spelled out, money as Rs. */
    const wordsFor = (field: string, v: unknown): string => {
      if (v === null || v === undefined || v === "") return "—";
      if (typeof v === "string" && nameOf[field]) return nameOf[field].get(v) ?? "(removed)";
      if (Array.isArray(v) && v.every((x) => x && typeof x === "object" && "productId" in (x as object))) {
        const parts = (v as { productId: string; quantity?: unknown; unit?: string; productName?: string }[]).map((x) => {
          const name = products.get(x.productId) ?? x.productName ?? "product";
          const unit = x.unit ?? productUnit.get(x.productId) ?? "";
          const u = unit === "LITER" ? "L" : unit === "PIECE" ? "pc" : unit === "KG" ? "kg" : "";
          return `${name} ${Number(x.quantity ?? 0)} ${u}`.trim();
        });
        return parts.join(" · ") || "—";
      }
      if (/amount|total|balance|rate|salary|wage|paid|price|due|discount|charge|cash/i.test(field) && (typeof v === "number" || (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)))) {
        return `Rs ${Number(v).toLocaleString("en-PK")}`;
      }
      if (typeof v === "number" && /qty|quantity|litres|liters/i.test(field)) return `${Math.round(v * 1000) / 1000}`;
      // A code like NOT_DELIVERED or RIDER_CASH reads as "Not delivered", "Rider cash".
      if (typeof v === "string" && /^[A-Z][A-Z0-9_]+$/.test(v) && v.length > 2) {
        const w = v.toLowerCase().replace(/_/g, " ");
        return w.charAt(0).toUpperCase() + w.slice(1);
      }
      return valueText(v);
    };
    const unitWord = (productId: unknown) => {
      const u = typeof productId === "string" ? productUnit.get(productId) : "";
      return u === "LITER" ? "L" : u === "PIECE" ? "pc" : u === "KG" ? "kg" : "";
    };
    const qtyOf = (row: Record<string, unknown> | null, pid: unknown) =>
      row && row.quantity != null ? `${Math.round(Number(row.quantity) * 1000) / 1000} ${unitWord(pid)}`.trim() : "";
    // Columns that say nothing to a person.
    const HIDDEN = new Set(["id", "createdAt", "updatedAt", "clientToken", "supabaseId", "passwordHash", "txId", "pktDate"]);


    const entries: AuditEntry[] = prepared.map(({ row: r, before, after }) => {
      const p = { row: r, before, after };
      const changes: AuditFieldChange[] = r.changedFields
        .filter((f) => !HIDDEN.has(f))
        .map((f) => ({
          field: f,
          label: fieldLabel(f),
          before: before?.[f] ?? null,
          after: after?.[f] ?? null,
          beforeText: wordsFor(f, before?.[f]),
          afterText: wordsFor(f, after?.[f]),
        }));

      const own = (table: string, m: Map<string, string>) =>
        r.tableName === table && r.rowId ? m.get(r.rowId) ?? null : null;
      const via = (field: string, m: Map<string, string>) => {
        const id = refOf(p, field);
        return id ? m.get(id) ?? null : null;
      };

      const customerName =
        own("Customer", customers) ?? via("customerId", customers) ??
        via("invoiceId", invoices) ?? via("routeStopId", stops);
      const productName = own("Product", products) ?? via("productId", products);

      // Whatever else the row is about, once it is neither a customer nor a
      // product. A deleted row can no longer be looked up, but its own record
      // still holds its name.
      const subject =
        own("Employee", employees) ?? own("Vendor", vendors) ?? own("Shift", shifts) ??
        own("User", users) ?? own("SampleLead", leads) ?? own("Rider", riders) ??
        own("Route", routes) ??
        via("employeeId", employees) ?? via("vendorId", vendors) ??
        via("sampleLeadId", leads) ?? via("riderId", riders) ?? via("shiftId", shifts) ?? via("routeId", routes) ??
        (before?.name as string | undefined) ?? (after?.name as string | undefined) ?? null;

      const snapshot = r.operation === "UPDATE" ? null : after ?? before;
      // The row as a list: named where it points at something, dropped where
      // it is an id nobody can read, in a sensible order (names first).
      const details = snapshot
        ? Object.entries(snapshot)
            .filter(([k]) => !HIDDEN.has(k) && (!/Id$/.test(k) || nameOf[k]))
            .map(([k, v]) => ({ label: fieldLabel(k), text: wordsFor(k, v) }))
            .filter((d) => d.text !== "—")
        : [];

      const finalSubject = customerName || productName ? (subject === customerName ? null : subject) : subject;
      const who = r.actorName ?? (r.actorSource === "mobile" ? "the rider app" : "the system");
      const what = tableLabel(r.tableName).toLowerCase();
      const about = [customerName, finalSubject, productName].filter(Boolean).join(" · ");
      const verb = r.operation === "INSERT" ? "added" : r.operation === "DELETE" ? "deleted" : "changed";
      let summary = `${who} ${verb} ${/^[aeiou]/.test(what) ? "an" : "a"} ${what}${about ? ` — ${about}` : ""}`;
      // The tables that come up most, said the way the farm says them.
      const row = after ?? before;
      if (row && r.operation !== "UPDATE") {
        const pid = row.productId;
        const product = productName ?? "stock";
        const q = qtyOf(row, pid);
        const undo = r.operation === "DELETE" ? " (entry removed)" : "";
        const why = typeof row.reason === "string" && row.reason ? ` — ${row.reason}` : "";
        if (r.tableName === "InventoryMovement") {
          const t = String(row.type ?? "");
          const riderName = typeof row.riderId === "string" ? riders.get(row.riderId) : null;
          const said: Record<string, string> = {
            HANDED_OVER: `loaded ${q} ${product}${riderName ? ` for ${riderName}` : ""}`,
            RETURNED: `returned ${q} ${product}${riderName ? ` from ${riderName}` : ""}`,
            WASTAGE: `wrote off ${q} ${product}${row.stage ? ` at ${String(row.stage).toLowerCase()}` : riderName ? ` (${riderName}'s)` : ""}`,
            DISPATCHED: `sent ${q} ${product} to Retail`,
            ARRIVED: `took ${q} ${product} into stock`,
            PRODUCED: `produced ${q} ${product}`,
            COUNTER_PURCHASE: `bought ${q} ${product} over the counter`,
            COUNTER_SALE: `sold ${q} ${product} over the counter`,
            KITCHEN_USE: `used ${q} ${product}`,
            CALF_USE: `gave ${q} ${product} to the calves`,
            REPLACEMENT: `sent ${q} ${product} as a free replacement`,
          };
          summary = `${who} ${said[t] ?? `recorded ${q} ${product} (${wordsFor("type", t)})`}${why}${undo}`;
        } else if (r.tableName === "DeliveryEntry") {
          const kind = row.isReplacement ? "a free replacement of" : row.isReturn ? "a return of" : "a delivery of";
          summary = `${who} ${r.operation === "DELETE" ? "removed" : "recorded"} ${kind} ${q} ${product}${customerName ? ` for ${customerName}` : ""}${typeof row.notes === "string" && row.notes ? ` — ${row.notes}` : ""}`;
        } else if (r.tableName === "Payment") {
          summary = `${who} ${r.operation === "DELETE" ? "removed" : "recorded"} a payment of ${wordsFor("amount", row.amount)}${customerName ? ` from ${customerName}` : ""}${row.head ? ` into ${wordsFor("head", row.head)}` : ""}`;
        } else if (r.tableName === "Expense") {
          summary = `${who} ${r.operation === "DELETE" ? "removed" : "recorded"} an expense of ${wordsFor("amount", row.amount)}${typeof row.categoryId === "string" && categories.get(row.categoryId) ? ` under ${categories.get(row.categoryId)}` : ""}${typeof row.description === "string" && row.description ? ` — ${row.description}` : ""}`;
        } else if (r.tableName === "ProductionLog") {
          summary = `${who} recorded a milking of ${q} ${product}${undo}`;
        } else if (r.tableName === "Attendance") {
          summary = `${who} marked ${finalSubject ?? "a staff member"} ${wordsFor("status", row.status).toLowerCase()}${row.date ? ` on ${valueText(row.date).slice(0, 10)}` : ""}${undo}`;
        }
      }
      if (r.operation === "UPDATE" && changes.length) {
        const first = changes[0];
        summary += `: ${first.label.toLowerCase()} ${first.beforeText} → ${first.afterText}`;
        if (changes.length > 1) summary += ` (+${changes.length - 1} more)`;
      }

      return {
        id: r.id,
        at: r.at.toISOString(),
        tableName: r.tableName,
        rowId: r.rowId,
        operation: r.operation,
        actorName: r.actorName,
        actorRole: r.actorRole,
        actorSource: r.actorSource,
        changedFields: r.changedFields,
        changes,
        snapshot,
        details,
        summary,
        action: summary.startsWith(`${who} `) ? summary.slice(who.length + 1) : summary,
        customerName,
        productName,
        subject: finalSubject,
      };
    });

    // The filter dropdowns: what is actually in the log, not every table there is.
    const [tables, actorRows, hasSystem, productList] = await Promise.all([
      db.auditLog.findMany({ distinct: ["tableName"], select: { tableName: true }, orderBy: { tableName: "asc" }, take: 200 }),
      db.auditLog.findMany({
        distinct: ["actorId"],
        where: { actorId: { not: null } },
        select: { actorId: true, actorName: true },
        orderBy: { actorId: "asc" },
        take: 200,
      }),
      db.auditLog.findFirst({ where: { actorId: null }, select: { id: true } }),
      db.product.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" }, take: 200 }),
    ]);

    const actors = actorRows
      .map((a) => ({ id: a.actorId as string, name: a.actorName ?? "Unknown" }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (hasSystem) actors.push({ id: SYSTEM_ACTOR, name: "System / scripts" });

    return {
      entries,
      nextCursor: hasMore ? `${page[page.length - 1].at.toISOString()}|${page[page.length - 1].id}` : null,
      tables: tables.map((t) => t.tableName),
      actors,
      products: productList,
      range,
      customer: customerInfo,
      retentionMonths: AUDIT_RETENTION_MONTHS,
      dbReady: true,
    };
  } catch (e) {
    console.error("[getAuditLog]", e);
    return { ...blank, dbReady: false, error: "Could not read the audit log." };
  }
}

// Deleting on read, throttled — the same shape as pruneChecklistHistory(), for
// the same reason: there is no cron in this project, and the work is one indexed
// delete that is almost always a no-op. Six hours rather than one, because this
// table is the biggest in the database and there is no hurry.
let lastPruneRun = 0;
const PRUNE_THROTTLE_MS = 6 * 60 * 60 * 1000;

export async function pruneAuditLog(force = false): Promise<number> {
  const now = Date.now();
  if (!force && now - lastPruneRun < PRUNE_THROTTLE_MS) return 0;
  lastPruneRun = now;
  try {
    // The app cannot delete from this table; only this function may.
    const r = await db.$queryRaw<{ n: number }[]>`
      SELECT public.prune_audit_log(${AUDIT_RETENTION_MONTHS}) AS n`;
    return Number(r[0]?.n ?? 0);
  } catch {
    return 0;
  }
}
