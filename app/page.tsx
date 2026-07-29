import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isOwner } from "@/lib/owner";
import AppNav from "./components/AppNav";
import Capture from "./components/Capture";
import Review from "./components/Review";
import Ask from "./components/Ask";
import { PageHeader, PageMain } from "./components/ui";

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
      <PageMain width="full">
        {/* The wordmark lives in the desktop nav, so the page title only shows
            on mobile — but the subtitle stays at both widths as the one-line
            statement of what this screen is for. */}
        <PageHeader
          className="mb-5 md:mb-6"
          title="Obsidian-X"
          subtitle="Capture anything — it gets titled, filed and linked for you."
        />

        {/* Capture is the hero; Ask & Draft sits under it. Review (the
            needs-review inbox) is a quiet right rail on desktop and falls to
            the bottom on mobile — it only appears when there's something in it. */}
        <div className="grid grid-cols-1 gap-8 md:grid-cols-[1fr_340px] md:items-start md:gap-7">
          <div className="md:col-start-1 md:row-start-1">
            <Capture />
          </div>
          <div className="md:col-start-1 md:row-start-2">
            <Ask />
          </div>
          <div className="md:col-start-2 md:row-start-1 md:row-span-2">
            <Review />
          </div>
        </div>
      </PageMain>
    </>
  );
}
