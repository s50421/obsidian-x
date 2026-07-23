import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isOwner } from "@/lib/owner";
import { captureText } from "@/lib/capture-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    // handled below
  }
  text = (text ?? "").toString().trim();
  if (!text) {
    return NextResponse.json({ error: "empty note" }, { status: 400 });
  }

  try {
    const outcome = await captureText(user.id, text, "typed");
    return NextResponse.json(outcome);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
