/**
 * Creates (or repairs) the first ADMIN account.
 *
 *   node --env-file=.env node_modules/.bin/tsx scripts/create-admin.ts
 *   # or: npx tsx scripts/create-admin.ts   (it loads .env itself)
 *
 * Credentials come from the environment:
 *   ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME (optional)
 *
 * Idempotent: re-running it repairs a half-made account (e.g. a Supabase user
 * with no DB row) and resets the password, rather than failing.
 */
import { PrismaClient, Prisma } from "@prisma/client";
import { createClient } from "@supabase/supabase-js";

// Locally the env comes from a .env file; inside the deploy container it is
// already injected by compose and no .env exists — loadEnvFile throws ENOENT.
try {
  process.loadEnvFile?.();
} catch {
  // no .env — env is already in the environment
}

const EMAIL = (process.env.ADMIN_EMAIL ?? "").trim().toLowerCase();
const PASSWORD = process.env.ADMIN_PASSWORD ?? "";
const NAME = (process.env.ADMIN_NAME ?? "Administrator").trim();

if (!EMAIL || !PASSWORD) {
  console.error("Set ADMIN_EMAIL and ADMIN_PASSWORD (in .env or the environment).");
  process.exit(1);
}
if (PASSWORD.length < 6) {
  console.error("ADMIN_PASSWORD must be at least 6 characters.");
  process.exit(1);
}

const db = new PrismaClient();
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

async function findAuthUserByEmail(email: string): Promise<string | null> {
  // listUsers is paginated; the staff list is small, so a couple of pages is plenty.
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error || !data.users.length) return null;
    const hit = data.users.find((u) => u.email?.toLowerCase() === email);
    if (hit) return hit.id;
    if (data.users.length < 200) return null;
  }
  return null;
}

async function main() {
  // 1. Supabase Auth user — create, or reset the password if it already exists.
  let supabaseId = await findAuthUserByEmail(EMAIL);

  if (supabaseId) {
    const { error } = await supabase.auth.admin.updateUserById(supabaseId, {
      password: PASSWORD,
      email_confirm: true,
      ban_duration: "none",
      app_metadata: { role: "ADMIN" },
    });
    if (error) throw new Error(`Failed to update the auth user: ${error.message}`);
    console.log(`Supabase auth user already existed — password reset. (${EMAIL})`);
  } else {
    const { data, error } = await supabase.auth.admin.createUser({
      email: EMAIL,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { name: NAME },
      app_metadata: { role: "ADMIN" },
    });
    if (error || !data.user) throw new Error(`Failed to create the auth user: ${error?.message}`);
    supabaseId = data.user.id;
    console.log(`Supabase auth user created. (${EMAIL})`);
  }

  // 2. DB User (+ Employee) — the source of truth for role/active.
  const existing = await db.user.findFirst({
    where: { OR: [{ email: EMAIL }, { supabaseId }] },
    select: { id: true },
  });

  if (existing) {
    await db.user.update({
      where: { id: existing.id },
      data: { name: NAME, email: EMAIL, role: "ADMIN", active: true, supabaseId },
    });
    console.log("Existing User row promoted to ADMIN and re-linked.");
  } else {
    const user = await db.user.create({
      data: { name: NAME, email: EMAIL, role: "ADMIN", active: true, supabaseId },
    });
    await db.employee.create({
      data: {
        userId: user.id,
        name: NAME,
        role: "Admin",
        baseSalary: new Prisma.Decimal(0),
        joinedAt: new Date(),
      },
    });
    console.log("User row created with role=ADMIN (+ Employee record).");
  }

  const admins = await db.user.count({ where: { role: "ADMIN", active: true } });
  console.log(`\nDone. Active admins: ${admins}`);
  console.log(`Sign in at /login with: ${EMAIL}`);
}

main()
  .catch((e) => {
    console.error("FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
