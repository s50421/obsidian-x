import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isOwner } from "@/lib/owner";
import AppNav from "../components/AppNav";
import ImportsReview from "./ImportsReview";

export const dynamic = "force-dynamic";

export default async function ImportsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isOwner(user.email)) redirect("/login");

  return (
    <>
      <AppNav />
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 pb-28 pt-3 md:px-8 md:pb-12 md:pt-8">
        <div className="mb-4 md:mb-6">
          <h1 className="text-[28px] font-bold tracking-[-0.022em] md:text-[22px]">Imports</h1>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-2">
            Your imports are on hold. Pick a source, then choose what&apos;s worth keeping —{" "}
            <b className="text-ink">Activate</b> makes items searchable; <b className="text-ink">Remove</b> deletes them for good.
          </p>
        </div>
        <ImportsReview />
      </main>
    </>
  );
}
