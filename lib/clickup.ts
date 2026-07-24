// ClickUp task creation (v1.5 T3). The app's first real outward action —
// only ever runs on an approved proposal. Personal API token in CLICKUP_API_TOKEN,
// target list in CLICKUP_LIST_ID (both in .env.rotation / Vercel).

const API = "https://api.clickup.com/api/v2";

export type ClickUpTask = { id: string; url: string; name: string };

export function clickupConfigured(): boolean {
  return !!(process.env.CLICKUP_API_TOKEN && process.env.CLICKUP_LIST_ID);
}

// ClickUp priority ids: 1 urgent, 2 high, 3 normal, 4 low.
const PRIORITY: Record<string, number> = { high: 2, medium: 3, low: 4 };

export async function createClickUpTask(input: {
  name: string;
  description?: string | null;
  dueAt?: string | null; // ISO
  priority?: string | null; // low | medium | high
}): Promise<ClickUpTask> {
  const token = process.env.CLICKUP_API_TOKEN;
  const list = process.env.CLICKUP_LIST_ID;
  if (!token || !list) throw new Error("ClickUp is not configured");

  const body: Record<string, unknown> = { name: input.name.slice(0, 250) };
  if (input.description) body.description = input.description;
  if (input.dueAt) body.due_date = new Date(input.dueAt).getTime();
  const p = input.priority ? PRIORITY[input.priority] : undefined;
  if (p) body.priority = p;

  const res = await fetch(`${API}/list/${list}/task`, {
    method: "POST",
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`ClickUp ${res.status}: ${detail.slice(0, 300)}`);
  }
  const j = (await res.json()) as { id: string; url: string; name: string };
  return { id: j.id, url: j.url, name: j.name };
}

// --- v2.2: two-way sync helpers ---------------------------------------------

async function api<T>(path: string, init?: RequestInit): Promise<T | null> {
  const token = process.env.CLICKUP_API_TOKEN;
  if (!token) return null;
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: token, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) return null;
  return (await res.json()) as T;
}

// The owner's first ClickUp workspace (team) id — webhooks are team-scoped.
export async function clickupTeamId(): Promise<string | null> {
  const j = await api<{ teams?: { id: string }[] }>("/team");
  return j?.teams?.[0]?.id ?? null;
}

// A task's current status + its type ("open" | "custom" | "closed" | "done").
export async function getClickUpTaskStatus(
  taskId: string
): Promise<{ status: string; type: string } | null> {
  const j = await api<{ status?: { status?: string; type?: string } }>(`/task/${taskId}`);
  if (!j?.status) return null;
  return { status: j.status.status ?? "", type: j.status.type ?? "" };
}

// A "done" ClickUp status is one whose type is closed/done.
export function isClickUpDone(type: string): boolean {
  return type === "closed" || type === "done";
}

// Register (once) a team webhook that pings `endpoint` on task status changes.
// Returns the webhook id + signing secret (store the secret to verify pings).
export async function registerClickUpWebhook(
  endpoint: string
): Promise<{ id: string; secret: string } | { error: string }> {
  const team = await clickupTeamId();
  if (!team) return { error: "no team" };
  const res = await fetch(`${API}/team/${team}/webhook`, {
    method: "POST",
    headers: { Authorization: process.env.CLICKUP_API_TOKEN!, "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint, events: ["taskStatusUpdated"] }),
  });
  const j = (await res.json()) as { id?: string; webhook?: { id: string; secret: string }; err?: string };
  if (!res.ok || !j.webhook) return { error: j.err ?? JSON.stringify(j).slice(0, 200) };
  return { id: j.webhook.id, secret: j.webhook.secret };
}
