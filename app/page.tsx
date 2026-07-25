import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isOwner } from "@/lib/owner";
import AppNav from "./components/AppNav";
import Capture from "./components/Capture";
import Review from "./components/Review";
import Ask from "./components/Ask";

export const dynamic = "force-dynamic";

export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !isOwner(user.email)) {
    redirect("/login");
  }

  return (
    <>
      <AppNav />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 pb-28 pt-3 md:px-8 md:pb-12 md:pt-8">
        <div className="mb-4 flex items-baseline justify-between md:hidden">
          <h1 className="text-[28px] font-bold tracking-[-0.022em]">Obsidian-X</h1>
          <span className="text-xs text-ink-3">{user.email}</span>
        </div>

        {/* Mobile: Capture · Review · Ask stacked. Desktop: Capture+Ask left, Review right. */}
        <div className="grid grid-cols-1 gap-7 md:grid-cols-[1fr_360px] md:items-start">
          <div className="md:col-start-1 md:row-start-1">
            <Capture />
          </div>
          <div className="md:col-start-2 md:row-start-1 md:row-span-2">
            <Review />
          </div>
          <div className="md:col-start-1 md:row-start-2">
            <Ask />
          </div>
        </div>
      </main>
    </>
  );
}
