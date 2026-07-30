// Obsidian-X v4.1 — thin Gmail REST client (read-only).
//
// Deliberately dependency-free (fetch only) to match the rest of the codebase,
// and deliberately metadata-first: the brief's design rule is "mail is INFLOW,
// not memory", so the sync path only ever pulls headers + Gmail's own snippet.
// Full bodies are fetched on demand by `getMessageBody`, for the handful of
// messages that clear the ranking bar.

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export type GmailHeaders = Record<string, string>;

export type GmailMessageMeta = {
  id: string;
  threadId: string;
  historyId?: string;
  internalDate: number; // epoch ms
  snippet: string;
  labelIds: string[];
  headers: GmailHeaders;
};

export type Addr = { name: string; email: string };

async function api<T>(token: string, path: string, timeoutMs = 15000): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`gmail ${path.split("?")[0]} ${res.status}: ${text.slice(0, 200)}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

/** Header names we need for ranking. Keeping this tight keeps responses small. */
const META_HEADERS = [
  "From",
  "To",
  "Cc",
  "Subject",
  "Date",
  // Forwarded mail (personal Gmail → the Workspace mailbox) keeps the ORIGINAL
  // To:, so a naive "is my address in To:?" check reads every forwarded message
  // as not-direct. These headers carry the real delivery target.
  "Delivered-To",
  "X-Forwarded-To",
  "List-Unsubscribe",
  "List-Id",
  "Precedence",
  "Auto-Submitted",
  "In-Reply-To",
  "References",
  "Message-ID",
];

const metaHeaderQuery = META_HEADERS.map((h) => `metadataHeaders=${encodeURIComponent(h)}`).join("&");

type RawMessage = {
  id: string;
  threadId: string;
  historyId?: string;
  internalDate?: string;
  snippet?: string;
  labelIds?: string[];
  payload?: RawPart;
};

type RawPart = {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { size?: number; data?: string };
  parts?: RawPart[];
};

function toHeaderMap(parts?: { name: string; value: string }[]): GmailHeaders {
  const out: GmailHeaders = {};
  for (const h of parts ?? []) out[h.name.toLowerCase()] = h.value;
  return out;
}

function toMeta(m: RawMessage): GmailMessageMeta {
  return {
    id: m.id,
    threadId: m.threadId,
    historyId: m.historyId,
    internalDate: Number(m.internalDate ?? 0),
    snippet: decodeEntities(m.snippet ?? ""),
    labelIds: m.labelIds ?? [],
    headers: toHeaderMap(m.payload?.headers),
  };
}

// Gmail returns snippets with HTML entities still encoded.
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/** Message ids matching a Gmail search query (used for the 30-day backfill). */
export async function listMessageIds(
  token: string,
  opts: { query?: string; max?: number } = {}
): Promise<string[]> {
  const max = opts.max ?? 500;
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const p = new URLSearchParams({ maxResults: String(Math.min(500, max - ids.length)) });
    if (opts.query) p.set("q", opts.query);
    if (pageToken) p.set("pageToken", pageToken);
    const page = await api<{ messages?: { id: string }[]; nextPageToken?: string }>(
      token,
      `/messages?${p.toString()}`
    );
    for (const m of page.messages ?? []) ids.push(m.id);
    pageToken = page.nextPageToken;
  } while (pageToken && ids.length < max);
  return ids.slice(0, max);
}

/** Headers + snippet for one message. No body. */
export async function getMessageMeta(token: string, id: string): Promise<GmailMessageMeta> {
  const raw = await api<RawMessage>(token, `/messages/${id}?format=metadata&${metaHeaderQuery}`);
  return toMeta(raw);
}

/**
 * User-created labels resolve to opaque ids (`Label_12`) in `labelIds`, not to
 * their names — so attributing a message to a stream by label needs this map.
 * System labels (INBOX, SENT, CATEGORY_*) are returned by name.
 */
export async function listLabels(token: string): Promise<Map<string, string>> {
  const raw = await api<{ labels?: { id: string; name: string }[] }>(token, "/labels");
  const byId = new Map<string, string>();
  for (const l of raw.labels ?? []) byId.set(l.id, l.name);
  return byId;
}

/** The current mailbox cursor — the starting point for incremental sync. */
export async function getProfile(
  token: string
): Promise<{ emailAddress: string; historyId: string; messagesTotal: number }> {
  return api<{ emailAddress: string; historyId: string; messagesTotal: number }>(token, "/profile");
}

/**
 * Message ids added since `startHistoryId`.
 *
 * Returns `expired: true` when Gmail has aged the cursor out (HTTP 404) — the
 * caller must then fall back to a bounded query-based resync rather than
 * silently skipping mail, which would be a coverage hole.
 */
export async function listHistoryAdded(
  token: string,
  startHistoryId: string,
  max = 500
): Promise<{ ids: string[]; historyId: string | null; expired: boolean }> {
  const ids = new Set<string>();
  let pageToken: string | undefined;
  let historyId: string | null = null;
  try {
    do {
      const p = new URLSearchParams({
        startHistoryId,
        historyTypes: "messageAdded",
        maxResults: "500",
      });
      if (pageToken) p.set("pageToken", pageToken);
      const page = await api<{
        history?: { messagesAdded?: { message: { id: string; labelIds?: string[] } }[] }[];
        nextPageToken?: string;
        historyId?: string;
      }>(token, `/history?${p.toString()}`);
      for (const h of page.history ?? []) {
        for (const a of h.messagesAdded ?? []) {
          // Drafts and sent mail aren't inflow.
          const labels = a.message.labelIds ?? [];
          if (labels.includes("DRAFT") || labels.includes("SENT")) continue;
          ids.add(a.message.id);
        }
      }
      if (page.historyId) historyId = page.historyId;
      pageToken = page.nextPageToken;
    } while (pageToken && ids.size < max);
  } catch (e) {
    if ((e as Error & { status?: number }).status === 404) {
      return { ids: [], historyId: null, expired: true };
    }
    throw e;
  }
  return { ids: [...ids].slice(0, max), historyId, expired: false };
}

/** Messages in a thread — used to detect "awaiting my reply". Metadata only. */
export async function getThreadMeta(
  token: string,
  threadId: string
): Promise<GmailMessageMeta[]> {
  const raw = await api<{ messages?: RawMessage[] }>(
    token,
    `/threads/${threadId}?format=metadata&${metaHeaderQuery}`
  );
  return (raw.messages ?? []).map(toMeta);
}

// ---- on-demand body ---------------------------------------------------------

function b64urlDecode(data: string): string {
  try {
    return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    return "";
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ");
}

function collectText(part: RawPart | undefined, out: { plain: string[]; html: string[] }): void {
  if (!part) return;
  const mime = part.mimeType ?? "";
  if (part.body?.data) {
    if (mime === "text/plain") out.plain.push(b64urlDecode(part.body.data));
    else if (mime === "text/html") out.html.push(b64urlDecode(part.body.data));
  }
  for (const p of part.parts ?? []) collectText(p, out);
}

/**
 * Full plain-text body, fetched ON DEMAND only. This is the one call that pulls
 * real content, and it is deliberately not part of the sync loop — inflow rows
 * hold a snippet and a `raw_ref`, not the mail itself.
 */
export async function getMessageBody(token: string, id: string, cap = 20000): Promise<string> {
  const raw = await api<RawMessage>(token, `/messages/${id}?format=full`, 20000);
  const out = { plain: [] as string[], html: [] as string[] };
  collectText(raw.payload, out);
  const text = out.plain.length ? out.plain.join("\n") : stripHtml(out.html.join("\n"));
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, cap);
}

// ---- header helpers ---------------------------------------------------------

/** Parse an address header into {name, email} pairs. */
export function parseAddresses(header: string | undefined): Addr[] {
  if (!header) return [];
  const out: Addr[] = [];
  // Split on commas that aren't inside quotes.
  const parts = header.match(/(?:"[^"]*"|[^,])+/g) ?? [];
  for (const raw of parts) {
    const s = raw.trim();
    if (!s) continue;
    const angle = s.match(/^(.*?)<([^>]+)>$/);
    if (angle) {
      out.push({
        name: angle[1].trim().replace(/^"|"$/g, ""),
        email: angle[2].trim().toLowerCase(),
      });
    } else if (s.includes("@")) {
      out.push({ name: "", email: s.replace(/^<|>$/g, "").toLowerCase() });
    }
  }
  return out;
}

export function firstAddress(header: string | undefined): Addr | null {
  return parseAddresses(header)[0] ?? null;
}
