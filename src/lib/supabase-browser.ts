"use client";

import { createBrowserClient } from "@supabase/ssr";

// The browser's own Supabase client, signed in as the person using the panel.
// It reads the same cookies the proxy keeps fresh, so a Realtime channel joined
// from here is checked against that person's login (see the office_location_listen
// rule in supabase/rider_rls.sql). It uses the public key only — the service key
// never leaves the server.
let client: ReturnType<typeof createBrowserClient> | null = null;

export function supabaseBrowser() {
  if (!client) {
    client = createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  }
  return client;
}
