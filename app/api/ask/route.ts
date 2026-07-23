import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isOwner } from "@/lib/owner";
import { answerQuestion } from "@/lib/ask-core";

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

  let question = "";
  try {
    ({ question } = await req.json());
  } catch {
    // ignore
  }
  question = (question ?? "").toString().trim();
  if (!question) {
    return NextResponse.json({ error: "empty question" }, { status: 400 });
  }

  try {
    const result = await answerQuestion(user.id, question);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
