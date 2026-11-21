/**
 * Creates the Supabase Storage buckets the customer app needs:
 *   - payment-proofs  (private; customers upload receipts, RLS restricts to own folder)
 *   - product-images  (public read; shop product images)
 *
 * Run once:  npx tsx scripts/ensure-customer-buckets.ts
 * Storage RLS policies for these buckets live in supabase/rls.sql.
 */
import { createClient } from "@supabase/supabase-js";

// tsx does not auto-load .env — load it from cwd (Node >= 20.12) before reading env.
// Locally the env comes from a .env file; inside the deploy container it is
// already injected by compose and no .env exists — loadEnvFile throws ENOENT.
try {
  process.loadEnvFile?.();
} catch {
  // no .env — env is already in the environment
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(1);
}

const supabaseAdmin = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

async function ensureBucket(name: string, isPublic: boolean) {
  const { data } = await supabaseAdmin.storage.getBucket(name);
  if (data) {
    console.log(`• bucket "${name}" already exists`);
    return;
  }
  const { error } = await supabaseAdmin.storage.createBucket(name, {
    public: isPublic,
    fileSizeLimit: MAX_BYTES,
  });
  if (error) console.error(`✗ failed to create "${name}": ${error.message}`);
  else console.log(`✓ created bucket "${name}" (${isPublic ? "public" : "private"})`);
}

async function main() {
  await ensureBucket("payment-proofs", false);
  await ensureBucket("product-images", true);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
