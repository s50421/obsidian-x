import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isOwner } from "@/lib/owner";
import Link from "next/link";
import AppNav from "../components/AppNav";
import { PageHeader, PageMain } from "../components/ui";
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
      <PageMain>
        <PageHeader
          title="Imports"
          subtitle="Bulk triage for the archived backlog — Activate makes items searchable, Remove deletes them for good."
        />
        <p className="mb-4 rounded-control border border-hairline bg-surface-1 px-4 py-3 text-[13px] leading-relaxed text-ink-2">
          The{" "}
          <Link href="/deck?mode=import" className="font-semibold text-accent-text">
            Deck
          </Link>{" "}
          is the better way through this backlog now — one item at a time, with the AI&apos;s proposed title and the
          original memory side by side. This screen stays for bulk sweeps.
        </p>
        <ImportsReview />
      </PageMain>
    </>
  );
}
