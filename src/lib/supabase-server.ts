import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// Cookie-bound Supabase client for server components and server actions.
// Uses the ANON key (never the service role) — it acts as the signed-in user.
// For privileged admin operations use `supabaseAdmin` (src/lib/supabase-admin.ts).
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Called from a Server Component, where cookies are read-only.
            // The middleware refreshes the session, so this is safe to ignore.
          }
        },
      },
    }
  );
}
