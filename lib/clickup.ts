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
