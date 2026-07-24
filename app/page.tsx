import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { isOwner } from "@/lib/owner";
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
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-6 sm:py-10">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Obsidian-X</h1>
          <p className="text-xs opacity-60">{user.email}</p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/imports"
            className="rounded-md border border-black/15 px-3 py-1.5 text-xs opacity-70 transition hover:opacity-100 dark:border-white/20"
          >
            Imports
          </Link>
          <Link
            href="/approvals"
            className="rounded-md border border-black/15 px-3 py-1.5 text-xs opacity-70 transition hover:opacity-100 dark:border-white/20"
          >
            Approvals
          </Link>
          <Link
            href="/ops"
            className="rounded-md border border-black/15 px-3 py-1.5 text-xs opacity-70 transition hover:opacity-100 dark:border-white/20"
          >
            Ops
          </Link>
          <form action="/auth/signout" method="post">
            <button
              type="submit"
              className="rounded-md border border-black/15 px-3 py-1.5 text-xs opacity-70 transition hover:opacity-100 dark:border-white/20"
            >
              Sign out
            </button>
          </form>
        </div>
      </header>

      <div className="space-y-10">
        <Capture />
        <Review />
        <Ask />
      </div>
    </main>
  );
}
