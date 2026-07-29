import { Suspense } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isOwner } from "@/lib/owner";
import AppNav from "../components/AppNav";
import Deck from "./Deck";

export const dynamic = "force-dynamic";

// v4.0 W3 — the swipe deck, the web app's killer screen (owner-authed, same
// pattern as /approvals and /imports). `Deck` reads `?mode=daily|import`
// itself via useSearchParams, which requires a Suspense boundary for the
// production build even though `dynamic = "force-dynamic"` already opts this
// route out of prerendering.
export default async function DeckPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isOwner(user.email)) redirect("/login");

  return (
    <>
      <AppNav />
      <main className="flex w-full flex-1 flex-col pb-24 md:pb-8">
        <Suspense fallback={<div className="mx-auto w-full max-w-sm flex-1 px-4 pt-8 text-sm text-ink-3">Loading deck…</div>}>
          <Deck />
        </Suspense>
      </main>
    </>
  );
}
