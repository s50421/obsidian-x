import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isOwner } from "@/lib/owner";
import { transcribeAudio } from "@/lib/transcribe";
import { logLlmUsage } from "@/lib/usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// v2.1 — transcribe a recorded voice note (owner-only). Transcription only: the
// text is returned for the owner to review/edit, then saved via the normal
// capture flow (so a mis-hear never auto-creates a note).
export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isOwner(user.email)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let audio = "";
  let format = "wav";
  try {
    const b = await req.json();
    audio = (b.audio ?? "").toString();
    format = (b.format ?? "wav").toString();
  } catch {
    // ignore
  }
  if (!audio) {
    return NextResponse.json({ error: "no audio" }, { status: 400 });
  }

  try {
    const { text, usage } = await transcribeAudio(audio, format);
    await logLlmUsage(createAdminClient(), user.id, "transcribe", usage);
    return NextResponse.json({ text });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
