import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isOwner } from "@/lib/owner";
import LoginForm from "./LoginForm";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user && isOwner(user.email)) {
    redirect("/");
  }

  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-16">
      <div className="flex w-full max-w-sm flex-col items-center rounded-[24px] border border-hairline bg-surface-1 px-8 py-11 text-center shadow-[0_24px_60px_rgba(0,0,0,0.4)]">
        <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-[20px] border border-hairline-2 bg-[linear-gradient(160deg,#2a2a36,#16161c)]">
          <div className="h-5 w-5 rotate-45 rounded-[5px] bg-accent-text" />
        </div>
        <h1 className="text-[24px] font-bold tracking-[-0.02em]">Obsidian-X</h1>
        <p className="mb-8 mt-1.5 text-sm text-ink-2">Your second brain. Just you.</p>
        <LoginForm initialError={error} />
        <p className="mt-5 text-[13px] leading-relaxed text-ink-3">
          A sign-in link lands in your inbox.
          <br />
          No passwords here.
        </p>
      </div>
    </main>
  );
}
