/**
 * Applies supabase/rider_rls.sql against the database (DIRECT_URL — same direct,
 * owner connection prisma migrations use; policy/GRANT DDL needs a direct
 * connection, not the pgbouncer pooler).
 *
 * This is the rider app's own RLS + grant policy file (canonical copy lives in
 * the rider app repo as db/rider_rls.sql — keep this copy in sync with it). It
 * runs on EVERY deploy, AFTER `prisma migrate deploy`, so that any schema change
 * which drops/recreates a table — which silently wipes that table's policies and
 * grants — is immediately healed. The panel bypasses RLS (it connects as owner),
 * so without this the rider app can break on a deploy with nothing visible here.
 *
 * The file MUST be idempotent: guard every statement (ENABLE RLS is a no-op if
 * already on; DROP POLICY IF EXISTS before CREATE POLICY; grant only the scoped
 * privileges the rider app needs — never blanket GRANT ... TO authenticated).
 *
 * Run manually (safe to re-run):  npx tsx scripts/apply-rider-rls.ts
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

// Locally the env comes from a .env file; in the deploy container it is already
// injected by compose and no .env exists — loadEnvFile throws ENOENT there.
try {
  process.loadEnvFile?.();
} catch {
  // no .env — env is already in the environment
}

const SQL_PATH = join(__dirname, "..", "supabase", "rider_rls.sql");

async function main() {
  // Skip (don't fail the deploy) until the rider app's policy file has been
  // committed here. Once supabase/rider_rls.sql exists, it applies automatically.
  if (!existsSync(SQL_PATH)) {
    console.warn(
      "[apply-rider-rls] supabase/rider_rls.sql not found — SKIPPING.\n" +
        "  Add the rider app's db/rider_rls.sql here to enable rider-scoped RLS on deploy."
    );
    return;
  }

  const db = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
  try {
    const sql = readFileSync(SQL_PATH, "utf8");

    // Split on statement-terminating semicolons that are NOT inside a $$ ... $$
    // dollar-quoted body, so a plpgsql function body's internal semicolons stay
    // part of one statement. (Same splitter as apply-returns-sync-trigger.ts.)
    const statements: string[] = [];
    let buf = "";
    let inDollar = false;
    for (const line of sql.split("\n")) {
      if (line.trim().startsWith("--")) continue;
      buf += line + "\n";
      if (/\$\$/.test(line)) inDollar = !inDollar;
      if (!inDollar && /;\s*$/.test(line.trim())) {
        statements.push(buf.trim());
        buf = "";
      }
    }
    if (buf.trim()) statements.push(buf.trim());

    for (const stmt of statements) {
      if (!stmt) continue;
      console.log("Executing:\n" + stmt.slice(0, 80) + (stmt.length > 80 ? "…" : ""));
      await db.$executeRawUnsafe(stmt);
    }
    console.log(`\nDone — applied ${statements.length} statement(s) from supabase/rider_rls.sql.`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
