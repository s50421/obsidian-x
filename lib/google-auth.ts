import type { SupabaseClient } from "@supabase/supabase-js";
import { getSettingValue, setSettingValue } from "@/lib/tz";

// Obsidian-X v4.1 — Google OAuth (read-only Gmail).
//
// Owner decision (2026-07-29): a Google Workspace "Internal" OAuth app on a
// domain David owns. Internal apps skip Google's verification entirely — even
// for restricted scopes like gmail.readonly — and their refresh tokens do not
// expire. That matters more than the ~$7/mo: the alternatives either expire
// every 7 days (external app in Testing) or can be cut off without notice
// (external unverified with a restricted scope), and a source that silently
// dies is precisely what the completeness law forbids.
//
// Tokens live server-side in the `settings` table, keyed per mailbox. They are
// never sent to the client — the connect page only ever sees "connected: true".

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

/** settings key holding the map of connected mailboxes. */
const ACCOUNTS_KEY = "google_accounts";

/**
 * Which OAuth client a mailbox was granted under.
 *
 * `workspace` — the Internal app on the Workspace org. Skips verification, no
 *   token expiry, but can ONLY be authorized by accounts inside the Workspace.
 * `personal`  — an optional second client (a separate External app) for a
 *   consumer Gmail, which the internal app is structurally unable to accept.
 *
 * Two clients means two secrets, and a refresh MUST go back to the client that
 * issued the grant — hence this is stored per account rather than assumed.
 */
export type GoogleApp = "workspace" | "personal";

export function isGoogleApp(v: string): v is GoogleApp {
  return v === "workspace" || v === "personal";
}

type ClientCreds = { id: string; secret: string };

function credsFor(app: GoogleApp): ClientCreds {
  if (app === "personal") {
    return {
      id: (process.env.GOOGLE_CLIENT_ID_PERSONAL ?? "").trim(),
      secret: (process.env.GOOGLE_CLIENT_SECRET_PERSONAL ?? "").trim(),
    };
  }
  return { id: googleClientId(), secret: googleClientSecret() };
}

export function appConfigured(app: GoogleApp): boolean {
  const c = credsFor(app);
  return !!c.id && !!c.secret;
}

export type GoogleAccount = {
  /** The mailbox address, e.g. davi.manhart@gmail.com — also the channel id. */
  email: string;
  /** Which OAuth client issued this grant. Absent on pre-dual-client rows,
   *  which were all workspace grants. */
  app?: GoogleApp;
  refresh_token: string;
  /** Cached access token + expiry, refreshed on demand. */
  access_token?: string;
  expires_at?: number;
  /** Gmail History API cursor. Absent = needs the initial backfill. */
  history_id?: string;
  connected_at: string;
  scope: string;
};

type AccountsBag = { accounts: GoogleAccount[] };

export function googleClientId(): string {
  return (process.env.GOOGLE_CLIENT_ID ?? "").trim();
}

export function googleClientSecret(): string {
  return (process.env.GOOGLE_CLIENT_SECRET ?? "").trim();
}

export function googleConfigured(): boolean {
  return !!googleClientId() && !!googleClientSecret();
}

/**
 * The redirect URI must match the one registered on the OAuth client EXACTLY,
 * so it is its own setting rather than being derived from NEXT_PUBLIC_SITE_URL
 * (which differs between the canonical domain, the vercel.app alias and local
 * dev — any of which would silently break the exchange).
 *
 * Register in Google Cloud: https://obsidian.manhartgroup.com/api/google/callback
 * Override with GOOGLE_REDIRECT_URI when testing locally.
 */
export const DEFAULT_REDIRECT_URI = "https://obsidian.manhartgroup.com/api/google/callback";

export function googleRedirectUri(): string {
  return (process.env.GOOGLE_REDIRECT_URI ?? DEFAULT_REDIRECT_URI).trim();
}

// ---- account storage --------------------------------------------------------

export async function loadAccounts(
  admin: SupabaseClient,
  userId: string
): Promise<GoogleAccount[]> {
  const bag = await getSettingValue<AccountsBag>(admin, userId, ACCOUNTS_KEY);
  return bag?.accounts ?? [];
}

async function saveAccounts(
  admin: SupabaseClient,
  userId: string,
  accounts: GoogleAccount[]
): Promise<void> {
  await setSettingValue(admin, userId, ACCOUNTS_KEY, { accounts });
}

/** Upsert one mailbox by email. Multi-mailbox from day one (owner decision). */
export async function upsertAccount(
  admin: SupabaseClient,
  userId: string,
  account: GoogleAccount
): Promise<void> {
  const accounts = await loadAccounts(admin, userId);
  const i = accounts.findIndex((a) => a.email.toLowerCase() === account.email.toLowerCase());
  if (i >= 0) accounts[i] = { ...accounts[i], ...account };
  else accounts.push(account);
  await saveAccounts(admin, userId, accounts);
}

export async function removeAccount(
  admin: SupabaseClient,
  userId: string,
  email: string
): Promise<void> {
  const accounts = await loadAccounts(admin, userId);
  await saveAccounts(
    admin,
    userId,
    accounts.filter((a) => a.email.toLowerCase() !== email.toLowerCase())
  );
}

/** Persist the sync cursor for a mailbox after a successful sync. */
export async function setHistoryId(
  admin: SupabaseClient,
  userId: string,
  email: string,
  historyId: string
): Promise<void> {
  const accounts = await loadAccounts(admin, userId);
  const i = accounts.findIndex((a) => a.email.toLowerCase() === email.toLowerCase());
  if (i < 0) return;
  accounts[i].history_id = historyId;
  await saveAccounts(admin, userId, accounts);
}

// ---- OAuth ------------------------------------------------------------------

export function authUrl(state: string, loginHint?: string, app: GoogleApp = "workspace"): string {
  const p = new URLSearchParams({
    client_id: credsFor(app).id,
    redirect_uri: googleRedirectUri(),
    response_type: "code",
    scope: GMAIL_SCOPE,
    // offline + consent is what actually yields a refresh_token; without
    // prompt=consent Google omits it on re-authorization of the same account.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  if (loginHint) p.set("login_hint", loginHint);
  return `https://accounts.google.com/o/oauth2/v2/auth?${p.toString()}`;
}

type TokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
};

export async function exchangeCode(code: string, app: GoogleApp = "workspace"): Promise<TokenResponse> {
  const c = credsFor(app);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: c.id,
      client_secret: c.secret,
      redirect_uri: googleRedirectUri(),
      grant_type: "authorization_code",
    }),
  });
  const body = (await res.json()) as TokenResponse;
  if (!res.ok) {
    throw new Error(body.error_description || body.error || `token exchange failed (${res.status})`);
  }
  return body;
}

/**
 * A valid access token for this mailbox, refreshing if the cached one is within
 * 60s of expiry. Writes the refreshed token back so concurrent jobs reuse it.
 */
export async function accessTokenFor(
  admin: SupabaseClient,
  userId: string,
  account: GoogleAccount
): Promise<string> {
  if (account.access_token && account.expires_at && account.expires_at - 60_000 > Date.now()) {
    return account.access_token;
  }
  // Refresh MUST go back to the client that issued the grant.
  const c = credsFor(account.app ?? "workspace");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: c.id,
      client_secret: c.secret,
      refresh_token: account.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const body = (await res.json()) as TokenResponse;
  if (!res.ok || !body.access_token) {
    // A dead refresh token means the source is down — the caller reports it to
    // source_status so the brief footer shows ⚠ rather than pretending.
    throw new Error(body.error_description || body.error || "refresh failed");
  }
  const expires_at = Date.now() + (body.expires_in ?? 3600) * 1000;
  await upsertAccount(admin, userId, {
    ...account,
    access_token: body.access_token,
    expires_at,
  });
  return body.access_token;
}

/** Who does this token belong to? Used to key the account by real address. */
export async function fetchProfileEmail(accessToken: string): Promise<string> {
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`profile fetch failed (${res.status})`);
  const body = (await res.json()) as { emailAddress?: string };
  if (!body.emailAddress) throw new Error("profile has no emailAddress");
  return body.emailAddress;
}
