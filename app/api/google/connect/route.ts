import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { appConfigured, authUrl, isGoogleApp, type GoogleApp } from "@/lib/google-auth";
import { makeState } from "@/lib/oauth-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// v4.1 — start the Google OAuth dance. Owner-authed via the session cookie;
// redirects to Google's consent screen. The `state` nonce is stored in an
// httpOnly cookie and checked on the way back (CSRF).
export async function GET(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/login", req.url));

  const params = new URL(req.url).searchParams;
  const appParam = params.get("app") ?? "workspace";
  const app: GoogleApp = isGoogleApp(appParam) ? appParam : "workspace";

  if (!appConfigured(app)) {
    const suffix = app === "personal" ? "_PERSONAL" : "";
    return NextResponse.json(
      { error: `GOOGLE_CLIENT_ID${suffix} / GOOGLE_CLIENT_SECRET${suffix} not configured` },
      { status: 500 }
    );
  }

  const hint = params.get("email") ?? undefined;
  // The callback has to exchange the code against the SAME client, so the
  // choice rides along in the (httpOnly, CSRF-checked) state cookie.
  const state = makeState(app, randomUUID());
  const res = NextResponse.redirect(authUrl(state, hint, app));
  res.cookies.set("obx_google_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return res;
}
