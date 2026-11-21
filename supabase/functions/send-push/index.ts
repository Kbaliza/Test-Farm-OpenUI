// Sends an FCM push for one CustomerNotification row.
//
// Called by the trg_push_notification trigger with {customerId, title, body, type}
// and the project's service key. The Firebase service account lives in Supabase
// Vault as `firebase_sa`; device tokens come back from push_tokens_for(), which is
// SECURITY DEFINER because service_role holds no table privileges here.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

type ServiceAccount = { project_id: string; client_email: string; private_key: string };

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`${fn}: ${res.status} ${await res.text()}`);
  return res.json();
}

function pemToBinary(pem: string): Uint8Array {
  const b64 = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function b64url(bytes: Uint8Array | string): string {
  const s = typeof bytes === "string" ? bytes : String.fromCharCode(...bytes);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Google OAuth2 access token via a signed JWT assertion (RS256).
async function accessToken(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToBinary(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claim}`)),
  );
  const assertion = `${header}.${claim}.${b64url(sig)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) throw new Error(`oauth: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

Deno.serve(async (req) => {
  if (req.headers.get("Authorization") !== `Bearer ${SERVICE_KEY}`) {
    return new Response("unauthorized", { status: 401 });
  }

  const { customerId, title, body, type } = await req.json();
  if (!customerId) return new Response("customerId required", { status: 400 });

  const tokens = await rpc<string[]>("push_tokens_for", { p_customer_id: customerId });
  if (!tokens.length) return Response.json({ sent: 0, reason: "no devices" });

  const sa: ServiceAccount = JSON.parse(await rpc<string>("get_secret", { p_name: "firebase_sa" }));
  const token = await accessToken(sa);

  const results = await Promise.all(tokens.map(async (t) => {
    const res = await fetch(
      `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          message: {
            token: t,
            notification: { title, body },
            data: { type: type ?? "INFO" },
            android: { priority: "HIGH", notification: { channel_id: "banoori_default" } },
          },
        }),
      },
    );
    return { ok: res.ok, status: res.status };
  }));

  return Response.json({ sent: results.filter((r) => r.ok).length, of: tokens.length });
});
