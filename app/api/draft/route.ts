import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isOwner } from "@/lib/owner";
import { draftForTask } from "@/lib/draft";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// v3.2 rung 2 — the agent drafts a deliverable from the brain's context.
export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isOwner(user.email)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let text = "";
  try {
    ({ text } = await req.json());
  } catch {
    // ignore
  }
  text = (text ?? "").toString().trim();
  if (!text) {
    return NextResponse.json({ error: "empty request" }, { status: 400 });
  }

  try {
    const result = await draftForTask(user.id, text);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
