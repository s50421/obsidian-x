import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { isOwner } from "@/lib/owner";
import ImportsReview from "./ImportsReview";

export const dynamic = "force-dynamic";

export default async function ImportsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isOwner(user.email)) redirect("/login");

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-6 sm:py-10">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Review imports</h1>
        <Link
          href="/"
          className="rounded-md border border-black/15 px-3 py-1.5 text-xs opacity-70 transition hover:opacity-100 dark:border-white/20"
        >
          ← Home
        </Link>
      </header>
      <p className="mb-4 text-sm opacity-60">
        Your Apple Notes import is on hold. Pick the ones worth keeping — <b>Activate</b> makes
        them searchable; <b>Remove</b> deletes them for good.
      </p>
      <ImportsReview />
    </main>
  );
}
