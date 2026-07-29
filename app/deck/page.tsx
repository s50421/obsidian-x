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
      {/* Deck owns its own bottom rhythm — the action row has to clear the tab
          bar and the home indicator, so it carries the safe-area padding. */}
      <main className="flex w-full flex-1 flex-col">
        <Suspense
          fallback={
            <div className="obx-safe-x mx-auto w-full max-w-sm flex-1 px-4 pt-4 md:max-w-md md:pt-8">
              <div className="obx-skeleton mb-2 h-8 w-28 rounded-control" />
              <div className="obx-skeleton mb-5 h-4 w-56 rounded-full" />
              <div className="obx-skeleton h-[58vh] max-h-[540px] min-h-[380px] w-full rounded-card" />
            </div>
          }
        >
          <Deck />
        </Suspense>
      </main>
    </>
  );
}
