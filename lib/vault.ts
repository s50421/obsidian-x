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
  const frontmatter = [
    "---",
    `id: ${note.id}`,
    `type: ${note.type}`,
    `tags:${yamlList(note.tags)}`,
    `priority: ${note.priority}`,
    `source: ${note.source}`,
    `created_at: ${note.createdAt}`,
    "---",
    "",
    `# ${note.title}`,
    "",
    note.body.trim(),
    "",
  ].join("\n");
  return frontmatter;
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
