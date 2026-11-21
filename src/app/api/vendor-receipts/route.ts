import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { getDashboardUser } from "@/lib/auth";
import { canAccess } from "@/lib/access";

// Uploads a vendor receipt image to Supabase Storage and returns its public URL.
// Uses the service role, so it MUST authenticate: a route handler is a public
// HTTP endpoint, and proxy.ts deliberately excludes /api/ from its matcher. It
// previously had no auth at all.

const BUCKET = "vendor-receipts";
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

// Allow-list, not an `image/*` prefix test — `file.type` is client-supplied and is
// echoed back as the stored contentType, so `image/svg+xml` allowed hosting a
// script that executes on our own domain.
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);

export const runtime = "nodejs";

async function ensureBucket() {
  const { data } = await supabaseAdmin.storage.getBucket(BUCKET);
  if (!data) {
    await supabaseAdmin.storage
      .createBucket(BUCKET, { public: true, fileSizeLimit: MAX_BYTES })
      .catch(() => {}); // ignore "already exists" races
  }
}

export async function POST(request: Request) {
  try {
    // Authenticate BEFORE reading the body, so an anonymous request can't make us
    // buffer a large upload.
    const user = await getDashboardUser();
    if (!user || !canAccess(user.role, "/payments/vendors")) {
      return NextResponse.json({ ok: false, error: "Not authorised." }, { status: 401 });
    }

    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > MAX_BYTES + 1024) {
      return NextResponse.json({ ok: false, error: "Image too large (max 10 MB)." }, { status: 413 });
    }

    const form = await request.formData();
    const file = form.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({ ok: false, error: "No file provided." }, { status: 400 });
    }
    if (!ALLOWED.has(file.type)) {
      return NextResponse.json({ ok: false, error: "Only JPEG, PNG, WEBP or HEIC images are allowed." }, { status: 400 });
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ ok: false, error: "Image too large (max 10 MB)." }, { status: 400 });
    }

    await ensureBucket();

    const ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
    const path = `${crypto.randomUUID()}.${ext}`;
    const bytes = new Uint8Array(await file.arrayBuffer());

    const { error } = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(path, bytes, { contentType: file.type, upsert: false });

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    const { data } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(path);
    return NextResponse.json({ ok: true, url: data.publicUrl });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Upload failed." },
      { status: 500 }
    );
  }
}
