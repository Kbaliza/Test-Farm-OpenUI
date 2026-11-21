import { describe, it, expect, afterEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { db, cleanups, setTestRole, resetTestRole } from "../setup";
import { createProduct, createCustomer, uniq } from "../helpers";
import { updateProduct } from "@/app/(dashboard)/inventory/products/actions";
import { getAuditLog } from "@/app/(dashboard)/audit-log/actions";
import { canAccess } from "@/lib/access";
import { AUDIT_DENY_LIST } from "@/lib/audit-tables";

afterEach(() => resetTestRole());

// The audit log is written by a database trigger, not by application code, so
// these tests go at it the way the world does: through a real action, through a
// bare client with nobody signed in, and through a connection carrying a mobile
// app's JWT. What each one records is the whole point of the feature.

const entriesFor = (rowId: string) =>
  db.auditLog.findMany({ where: { rowId }, orderBy: { at: "asc" } });

describe("what the audit log records", () => {
  it("names who edited a product, and keeps the old value beside the new one", async () => {
    const p = await createProduct({ defaultRate: 100 });

    expect((await updateProduct(p.id, { name: p.name, unit: "LITER", defaultRate: 130 })).ok).toBe(true);

    const entries = await entriesFor(p.id);
    const edit = entries.find((e) => e.operation === "UPDATE")!;
    expect(edit).toBeTruthy();
    expect(edit.changedFields).toContain("defaultRate");
    expect(Number((edit.before as Record<string, unknown>).defaultRate)).toBeCloseTo(100, 2);
    expect(Number((edit.after as Record<string, unknown>).defaultRate)).toBeCloseTo(130, 2);
    // The signed-in user, put on the wire by the client extension.
    expect(edit.actorName).toBe("Vitest Admin");
    expect(edit.actorSource).toBe("web");
  }, 240_000);

  it("keeps only the fields that moved, not the whole row", async () => {
    const p = await createProduct({ defaultRate: 100 });
    await updateProduct(p.id, { name: p.name, unit: "LITER", defaultRate: 111 });

    const edit = (await entriesFor(p.id)).find((e) => e.operation === "UPDATE")!;
    expect(Object.keys(edit.after as Record<string, unknown>)).toEqual(edit.changedFields);
    expect(edit.changedFields).not.toContain("name");
  }, 240_000);

  it("records a write that arrives with nobody signed in, rather than dropping it", async () => {
    // A maintenance script, psql, or the Supabase SQL editor: no actor on the
    // wire at all. The change must still be on the record.
    const bare = new PrismaClient();
    cleanups.push(async () => { await bare.$disconnect(); });
    const name = uniq("__AUDIT_orphan");
    const made = await bare.product.create({ data: { name, unit: "LITER", defaultRate: 10 } });
    cleanups.push(async () => { await db.product.delete({ where: { id: made.id } }).catch(() => {}); });

    const entry = (await entriesFor(made.id))[0];
    expect(entry.operation).toBe("INSERT");
    expect(entry.actorSource).toBe("unknown");
    expect(entry.actorId).toBeNull();
  }, 240_000);

  it("names the rider when the write carries the mobile app's token", async () => {
    const rider = await db.user.findFirst({ where: { role: "ADMIN" }, select: { id: true, name: true, supabaseId: true } });
    const name = uniq("__AUDIT_mobile");
    // How PostgREST arrives: its own connection, carrying the token's claims,
    // with the claims and the write in one transaction. A bare client, because
    // the mobile apps are not this app.
    const rest = new PrismaClient();
    cleanups.push(async () => { await rest.$disconnect(); });
    const [, made] = await rest.$transaction([
      rest.$executeRaw`select set_config('request.jwt.claims', ${JSON.stringify({ sub: rider!.supabaseId })}, true)`,
      rest.product.create({ data: { name, unit: "LITER", defaultRate: 10 } }),
    ]);
    cleanups.push(async () => { await db.product.delete({ where: { id: made.id } }).catch(() => {}); });

    const entry = (await entriesFor(made.id))[0];
    expect(entry.actorSource).toBe("mobile");
    expect(entry.actorId).toBe(rider!.id);
  }, 240_000);

  it("says nothing about a save that changed nothing", async () => {
    const p = await createProduct({ defaultRate: 100 });
    await updateProduct(p.id, { name: p.name, unit: "LITER", defaultRate: 100 });
    const before = (await entriesFor(p.id)).length;
    await updateProduct(p.id, { name: p.name, unit: "LITER", defaultRate: 100 });
    expect((await entriesFor(p.id)).length).toBe(before);
  }, 240_000);

  it("keeps the whole record when something is deleted", async () => {
    const c = await createCustomer({ name: uniq("__AUDIT_gone") });
    await db.customer.delete({ where: { id: c.id } });

    const gone = (await entriesFor(c.id)).find((e) => e.operation === "DELETE")!;
    expect(gone).toBeTruthy();
    expect((gone.before as Record<string, unknown>).name).toBe(c.name);
    expect(gone.after).toBeNull();
  }, 240_000);

  it("never stores a password hash or a Supabase id", async () => {
    const u = await db.user.create({
      data: { email: uniq("__AUDIT") + "@t.local", name: uniq("__AUDIT_user"), role: "MANAGER", passwordHash: "secret-hash", supabaseId: uniq("sb") },
    });
    cleanups.push(async () => { await db.user.delete({ where: { id: u.id } }).catch(() => {}); });

    const entry = (await entriesFor(u.id))[0];
    const stored = entry.after as Record<string, unknown>;
    expect(stored.passwordHash).toBeUndefined();
    expect(stored.supabaseId).toBeUndefined();
    expect(stored.name).toBe(u.name);
  }, 240_000);
});

describe("the log cannot be rewritten", () => {
  it("refuses an edit and a delete, even to an admin", async () => {
    const p = await createProduct({ defaultRate: 100 });
    const entry = (await entriesFor(p.id))[0];
    expect(entry).toBeTruthy();

    await expect(
      db.$executeRaw`update "AuditLog" set "actorName" = 'somebody else' where id = ${entry.id}`,
    ).rejects.toThrow(/append-only/i);
    await expect(
      db.$executeRaw`delete from "AuditLog" where id = ${entry.id}`,
    ).rejects.toThrow(/append-only/i);

    expect(await db.auditLog.count({ where: { id: entry.id } })).toBe(1);
  }, 240_000);

  it("removes only what is older than the window, and only through the prune", async () => {
    const p = await createProduct({ defaultRate: 100 });
    expect((await entriesFor(p.id)).length).toBeGreaterThan(0);

    // Today's entries are inside twelve months, so a prune leaves them alone.
    const kept = await db.$queryRaw<{ n: number }[]>`select public.prune_audit_log(12) as n`;
    expect(Number(kept[0].n)).toBe(0);
    expect((await entriesFor(p.id)).length).toBeGreaterThan(0);
  }, 240_000);
});

describe("every table is covered", () => {
  it("has the trigger on every business table, and on nothing it should not", async () => {
    const unaudited = await db.$queryRaw<{ relname: string }[]>`
      SELECT c.relname FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND left(c.relname, 1) <> '_'
        AND NOT EXISTS (
          SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = 'trg_audit_row'
        )
      ORDER BY c.relname`;

    // A table that is neither audited nor deliberately excluded is a hole in the
    // record. This is what fails the day someone adds a table.
    expect(unaudited.map((r) => r.relname).sort()).toEqual([...AUDIT_DENY_LIST].sort());
  }, 240_000);

  it("does not audit the audit log itself", async () => {
    const self = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE c.relname = 'AuditLog' AND t.tgname = 'trg_audit_row'`;
    expect(Number(self[0].n)).toBe(0);
  }, 240_000);
});

describe("who may read it", () => {
  it("is refused to a manager, and to everyone below", async () => {
    for (const role of ["MANAGER", "ACCOUNTANT", "PACKAGING", "RETAIL_MANAGER"]) {
      setTestRole(role);
      await expect(getAuditLog({})).rejects.toThrow(/permission/i);
    }
    setTestRole("ADMIN");
    expect((await getAuditLog({})).dbReady).toBe(true);
  }, 240_000);

  it("is hidden from a manager's menu and their URL bar", () => {
    expect(canAccess("ADMIN", "/audit-log")).toBe(true);
    expect(canAccess("MANAGER", "/audit-log")).toBe(false);
    // …without disturbing what a manager can already reach.
    expect(canAccess("MANAGER", "/ledgers")).toBe(true);
  });
});
