import { Octokit } from "@octokit/rest";

export type VaultNote = {
  id: string;
  type: string;
  title: string;
  body: string;
  tags: string[];
  priority: string;
  source: string;
  createdAt: string; // ISO
  dueAt?: string | null; // ISO
  entities?: { name: string; kind: string }[];
  links?: { id: string; title: string }[];
  status?: string; // open | done | archived — projected from the DB (source of truth)
  clickupUrl?: string | null; // set once an approved proposal creates the ClickUp task
};

function repoParts() {
  const [owner, repo] = (process.env.VAULT_REPO ?? "").split("/");
  if (!owner || !repo) {
    throw new Error("VAULT_REPO must be in the form 'owner/repo'");
  }
  return { owner, repo, branch: process.env.VAULT_BRANCH || "main" };
}

function yamlList(items: string[]): string {
  if (!items.length) return "[]";
  return "\n" + items.map((t) => `  - ${JSON.stringify(t)}`).join("\n");
}

function renderMarkdown(note: VaultNote): string {
  const fm: string[] = [
    "---",
    `id: ${note.id}`,
    `type: ${note.type}`,
    `tags:${yamlList(note.tags)}`,
    `priority: ${note.priority}`,
  ];
  if (note.status) fm.push(`status: ${note.status}`);
  if (note.dueAt) fm.push(`due: ${note.dueAt}`);
  if (note.entities && note.entities.length) {
    fm.push(`entities:${yamlList(note.entities.map((e) => `${e.name} (${e.kind})`))}`);
  }
  if (note.clickupUrl) fm.push(`clickup: ${note.clickupUrl}`);
  fm.push(`source: ${note.source}`, `created_at: ${note.createdAt}`, "---");

  const parts = [fm.join("\n"), "", `# ${note.title}`, "", note.body.trim(), ""];

  if (note.links && note.links.length) {
    parts.push("## Related", "");
    for (const l of note.links) {
      // vault files are named {id}.md, so [[id]] resolves in Obsidian.
      parts.push(`- [[${l.id}|${l.title}]]`);
    }
    parts.push("");
  }

  return parts.join("\n");
}

// Writes one markdown file per note to the vault repo and returns its path.
export async function writeVaultNote(note: VaultNote): Promise<string> {
  const { owner, repo, branch } = repoParts();
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

  const year = new Date(note.createdAt).getUTCFullYear();
  const path = `notes/${year}/${note.id}.md`;
  const content = Buffer.from(renderMarkdown(note), "utf8").toString("base64");

  // If the file already exists we need its blob sha to update it.
  let sha: string | undefined;
  try {
    const existing = await octokit.repos.getContent({ owner, repo, path, ref: branch });
    if (!Array.isArray(existing.data) && "sha" in existing.data) {
      sha = existing.data.sha;
    }
  } catch {
    // 404 => new file, no sha needed.
  }

  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path,
    message: `note: ${note.title} (${note.id})`,
    content,
    branch,
    sha,
  });

  return path;
}

// Public GitHub URL for a vault path (works when logged in to the private repo).
export function vaultUrl(path: string): string {
  const { owner, repo, branch } = repoParts();
  return `https://github.com/${owner}/${repo}/blob/${branch}/${path}`;
}

// Remove a note's markdown file from the vault (used by review merge/delete).
export async function deleteVaultNote(path: string): Promise<void> {
  const { owner, repo, branch } = repoParts();
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  const existing = await octokit.repos.getContent({ owner, repo, path, ref: branch });
  if (Array.isArray(existing.data) || !("sha" in existing.data)) return;
  await octokit.repos.deleteFile({
    owner,
    repo,
    path,
    message: `remove note ${path}`,
    sha: existing.data.sha,
    branch,
  });
}

// v3.4 — write (create or update) an arbitrary file in the vault repo. Used by
// the backup cron to commit a JSON snapshot of the brain (git history = versions).
export async function writeVaultFile(path: string, content: string, message: string): Promise<void> {
  const { owner, repo, branch } = repoParts();
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  let sha: string | undefined;
  try {
    const existing = await octokit.repos.getContent({ owner, repo, path, ref: branch });
    if (!Array.isArray(existing.data) && "sha" in existing.data) sha = existing.data.sha;
  } catch {
    // new file — no sha
  }
  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path,
    message,
    content: Buffer.from(content, "utf-8").toString("base64"),
    branch,
    ...(sha ? { sha } : {}),
  });
}
