import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Server-only — uses the service role key. The import above makes that a build
// error rather than a comment: any client component that pulls this in now fails
// the build instead of shipping a bundle that reaches for the service-role key.
//
// The client is built on FIRST USE, not at module load. `next build` evaluates
// every route module to collect page data, and the service-role key is a runtime
// secret that is deliberately absent from the build environment (passing it as a
// Docker build arg would bake it into an image layer). Constructing eagerly made
// the whole build fail with "Failed to collect page data for /api/expense-chits".
// Deferring it also turns a missing key into a real error at the point of use
// instead of the silent `undefined!` the non-null assertions used to allow.

let client: SupabaseClient | null = null;

function admin(): SupabaseClient {
  if (client) return client;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "supabaseAdmin needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY at runtime."
    );
  }

  client = createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
  return client;
}

// Kept as an object rather than a `getSupabaseAdmin()` call so the ~24 existing
// call sites read unchanged; every property access resolves through admin().
export const supabaseAdmin = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    const c = admin();
    return Reflect.get(c, prop, c);
  },
});
