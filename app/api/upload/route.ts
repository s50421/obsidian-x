import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isOwner } from "@/lib/owner";
import { extractDocument } from "@/lib/extract-document";
import { ingestDocument } from "@/lib/ingest-document";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// v3.1 — document upload. Owner-authed (session cookie). Accepts one file via
// multipart form-data, extracts its text, and runs it through the document
// ingest (classify -> embed -> store) so it lands in the knowledge base.
// Capped at 4 MB — Vercel serverless caps the request body at ~4.5 MB; larger /
// chunked ingest is a later v3.1 rung.
const MAX_BYTES = 4 * 1024 * 1024;

export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isOwner(user.email)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "expected multipart form-data" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "no file provided" }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: "file is empty" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "file too large (max 4 MB)" }, { status: 413 });
  }

  const buf = await file.arrayBuffer();

  let text = "";
  try {
    ({ text } = await extractDocument(buf, file.name, file.type));
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not read this file" },
      { status: 400 }
    );
  }
  if (!text || text.trim().length < 10) {
    return NextResponse.json({ error: "no readable text found in this file" }, { status: 400 });
  }

  try {
    const outcome = await ingestDocument(user.id, text, file.name);
    return NextResponse.json(outcome);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
