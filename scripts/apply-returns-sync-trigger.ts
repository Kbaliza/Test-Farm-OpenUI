/**
 * Applies supabase/returns-sync-trigger.sql against the database (DIRECT_URL,
 * same connection used for prisma migrations — trigger/function DDL needs a
 * direct connection, not the pgbouncer pooler).
 *
 * Run once (safe to re-run — the script drops-if-exists first):
 *   npx tsx scripts/apply-returns-sync-trigger.ts
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "fs";
import { join } from "path";

// Locally the env comes from a .env file; in the deploy container it is already
// injected by compose and no .env exists — loadEnvFile throws ENOENT there.
try {
  process.loadEnvFile?.();
} catch {
  // no .env — env is already in the environment
}

const db = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

async function main() {
  const sql = readFileSync(join(__dirname, "..", "supabase", "returns-sync-trigger.sql"), "utf8");

  // Split on statement-terminating semicolons that are NOT inside a $$ ... $$
  // dollar-quoted body, so the plpgsql function body's internal semicolons
  // stay intact as part of one statement.
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

  console.log("\nDone — trigger trg_delivery_return_sync is live on \"DeliveryEntry\".");
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
