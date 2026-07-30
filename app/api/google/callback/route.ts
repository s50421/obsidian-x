import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { appFromState, statesMatch } from "@/lib/oauth-state";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isOwner } from "@/lib/owner";
import { logAudit } from "@/lib/audit";
import { reportSourceStatus } from "@/lib/source-status";
import {
  exchangeCode,
  fetchProfileEmail,
  GMAIL_SCOPE,
  isGoogleApp,
  upsertAccount,
  type GoogleApp,
} from "@/lib/google-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// v4.1 — OAuth return leg. Exchanges the code, resolves which mailbox the grant
// belongs to, and stores the refresh token SERVER-SIDE in `settings`. The token
// never touches the client; the ops page only ever learns "connected: true".
export async function GET(req: Request) {
  const url = new URL(req.url);
  const done = (params: Record<string, string>) => {
    const to = new URL("/ops", url.origin);
    for (const [k, v] of Object.entries(params)) to.searchParams.set(k, v);
    return NextResponse.redirect(to);
  };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isOwner(user.email)) {
    return NextResponse.redirect(new URL("/login", url.origin));
  }

  const err = url.searchParams.get("error");
  if (err) return done({ google: "error", detail: err });

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  // Read through Next's cookie jar rather than parsing the header by hand.
  // Cookie VALUES are percent-encoded on write (`cookie.serialize` defaults to
  // encodeURIComponent), so the "workspace:<uuid>" state is stored as
  // "workspace%3A<uuid>" — comparing that raw against Google's already-decoded
  // `state` param can never match. The jar decodes for us.
  const cookieState = (await cookies()).get("obx_google_state")?.value;

  if (!code) return done({ google: "error", detail: "no code" });
  if (!statesMatch(state, cookieState)) {
    return done({ google: "error", detail: "state mismatch" });
  }

  // The connect leg encoded which OAuth client it used into the state.
  const app: GoogleApp = appFromState(state);

  try {
    const tok = await exchangeCode(code, app);
    if (!tok.refresh_token) {
      // Without a refresh token the connection dies in an hour — refuse it
      // rather than register a source that will silently stop working.
      return done({ google: "error", detail: "no refresh_token — revoke access and retry" });
    }
    const email = await fetchProfileEmail(tok.access_token);

    const admin = createAdminClient();
    await upsertAccount(admin, user.id, {
      email,
      app,
      refresh_token: tok.refresh_token,
      access_token: tok.access_token,
      expires_at: Date.now() + (tok.expires_in ?? 3600) * 1000,
      connected_at: new Date().toISOString(),
      scope: tok.scope ?? GMAIL_SCOPE,
    });

    await reportSourceStatus(admin, user.id, {
      source: "gmail",
      channel: email,
      label: email,
      connected: true,
      error: null,
      detail: { connected_at: new Date().toISOString() },
    });
    await logAudit(admin, {
      user_id: user.id,
      action: "gmail_connected",
      actor: "user",
      detail: { mailbox: email },
    });

    const res = done({ google: "connected", mailbox: email });
    res.cookies.delete("obx_google_state");
    return res;
  } catch (e) {
    return done({ google: "error", detail: e instanceof Error ? e.message : String(e) });
  }
}
