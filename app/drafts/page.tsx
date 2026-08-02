import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isOwner } from "@/lib/owner";
import { DRAFT_KIND, type DraftProposalPayload } from "@/lib/letter-drafts";
import AppNav from "../components/AppNav";
import { CARD, EmptyState, PageHeader, PageMain, SectionLabel } from "../components/ui";
import DraftCard from "./DraftCard";

// Obsidian-X — the drafts screen.
//
// The letter pre-generates replies for mail that wants one, and the Telegram
// button shows them one at a time. This is the place to pull them from when
// you're actually at a keyboard and want to work through several.
//
// It deliberately stops at "copy". The system does not send mail on the owner's
// behalf — see the hard rule in AGENTS.md — and the owner's own request to have
// drafts appear directly in Gmail was withdrawn in favour of this screen,
// because writing a Gmail draft needs the `gmail.compose` scope that the rule
// forbids. So the handoff is a clipboard, on purpose.

export const dynamic = "force-dynamic";

export default async function DraftsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isOwner(user.email)) redirect("/login");

  const admin = createAdminClient();
  const { data } = await admin
    .from("proposals")
    .select("id,payload,status,created_at")
    .eq("user_id", user.id)
    .eq("kind", DRAFT_KIND)
    .in("status", ["pending", "approved"])
    .order("created_at", { ascending: false })
    .limit(50);

  // One draft per message, newest first. The letter can regenerate a draft on
  // demand, so the same inflow row legitimately has several — showing all of
  // them would just be the same reply three times.
  const seen = new Set<string>();
  const drafts: (DraftProposalPayload & { id: string })[] = [];
  for (const p of data ?? []) {
    const payload = (p.payload ?? {}) as DraftProposalPayload;
    if (!payload.draft) continue;
    const key = payload.inflowId || (p.id as string);
    if (seen.has(key)) continue;
    seen.add(key);
    drafts.push({ ...payload, id: p.id as string });
  }

  return (
    <>
      <AppNav />
      <PageMain>
        <PageHeader
          title="Drafts"
          subtitle={
            drafts.length === 0
              ? "No replies drafted yet."
              : `${drafts.length} ${drafts.length === 1 ? "reply is" : "replies are"} ready to copy.`
          }
        />

        <section className="flex flex-col gap-3">
          <SectionLabel className="px-1">Ready to send yourself</SectionLabel>
          {drafts.length === 0 ? (
            <EmptyState
              glyph="✍"
              title="Nothing drafted yet"
              body="When the morning letter finds mail that wants a reply, it writes one and parks it here. Tapping 📝 Draft in Telegram also files it here."
            />
          ) : (
            drafts.map((d) => (
              <div key={d.id} className={`p-4 ${CARD}`}>
                <DraftCard
                  subject={d.subject}
                  sender={d.sender}
                  draft={d.draft}
                  generatedAt={d.generatedAt ?? null}
                />
              </div>
            ))
          )}
          <p className="px-1 pt-1 text-[13px] leading-relaxed text-ink-3">
            Drafts are never sent for you — copy one into your mail client and send it yourself.
          </p>
        </section>
      </PageMain>
    </>
  );
}
