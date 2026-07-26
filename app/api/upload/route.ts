import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isOwner } from "@/lib/owner";
import { extractDocument } from "@/lib/extract-document";
import { readImage } from "@/lib/read-image";
import { ingestDocument } from "@/lib/ingest-document";
import { logLlmUsage } from "@/lib/usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// v3.1 — file upload. Owner-authed (session cookie). One file via multipart
// form-data, ≤ 4 MB (Vercel serverless caps the request body at ~4.5 MB).
//   • documents (PDF / DOCX / text) -> extract text
//   • images (screenshots / photos) -> read with an AI vision model
// …then the same classify -> embed -> store ingest, so it lands in the KB.
const MAX_BYTES = 4 * 1024 * 1024;
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp"]);

function isImage(file: File): boolean {
  if ((file.type || "").toLowerCase().startsWith("image/")) return true;
  const ext = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase() ?? "";
  return IMAGE_EXTS.has(ext);
}

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
  const image = isImage(file);

  let text = "";
  try {
    if (image) {
      // AI vision "reads" the screenshot/photo (OpenRouter-only, like voice).
      const b64 = Buffer.from(buf).toString("base64");
      const { text: read, usage } = await readImage(b64, file.type);
      await logLlmUsage(createAdminClient(), user.id, "read_image", usage);
      text = read;
    } else {
      ({ text } = await extractDocument(buf, file.name, file.type));
    }
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "could not read this file" },
      { status: 400 }
    );
  }

  if (!text || text.trim().length < 10) {
    return NextResponse.json(
      { error: image ? "couldn't read any content from this image" : "no readable text found in this file" },
      { status: 400 }
    );
  }

  try {
    const outcome = await ingestDocument(user.id, text, file.name, image ? "screenshot" : "upload");
    return NextResponse.json(outcome);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
