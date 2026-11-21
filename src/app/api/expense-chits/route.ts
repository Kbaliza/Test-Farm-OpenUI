import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { getDashboardUser } from "@/lib/auth";
import { canAccess } from "@/lib/access";
import { MAX_CHIT_TOTAL_BYTES, isAllowedChitType } from "@/lib/expense-chits";

// Uploads an expense chit / invoice photo to Supabase Storage and returns its
// public URL. Uses the service role, so it MUST authenticate: a route handler is
// a public HTTP endpoint, and proxy.ts deliberately excludes /api/ from its
// matcher. It previously had no auth at all — anyone on the internet could push
// files into a public bucket with our service-role key.

const BUCKET = "expense-chits";

// One file at a time. An expense may carry several, and the 10 MB ceiling is on the
// SET, not on each photo — so a single file can be up to the whole budget, and
// addExpense is what refuses a set that adds up to more. Limits and the allow-list
// live in lib/expense-chits so the browser, this route and the action agree.
const MAX_BYTES = MAX_CHIT_TOTAL_BYTES;

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
    // buffer a large upload. Only someone who can reach the Expenses screen may
    // attach a chit to it.
    const user = await getDashboardUser();
    if (!user || !canAccess(user.role, "/payments/expenses")) {
      return NextResponse.json({ ok: false, error: "Not authorised." }, { status: 401 });
    }

    // Reject oversized bodies on the declared length before formData() buffers
    // the whole thing into memory.
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > MAX_BYTES + 1024) {
      return NextResponse.json({ ok: false, error: "Image too large (max 10 MB)." }, { status: 413 });
    }

    const form = await request.formData();
    const file = form.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({ ok: false, error: "No file provided." }, { status: 400 });
    }
    if (!isAllowedChitType(file.type)) {
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
    // `bytes` is what addExpense adds up against the 10 MB set limit.
    return NextResponse.json({ ok: true, url: data.publicUrl, bytes: file.size });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Upload failed." },
      { status: 500 }
    );
  }
}
