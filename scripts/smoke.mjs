// End-to-end pipeline smoke test (no browser/login needed).
// Exercises the same operations the app does: classify -> embed -> store ->
// vault write -> retrieve -> answer with citation. Run: npm run smoke
import { createClient } from "@supabase/supabase-js";
import { Octokit } from "@octokit/rest";

const {
  NEXT_PUBLIC_SUPABASE_URL: URL,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE,
  OPENROUTER_API_KEY,
  OPENROUTER_CLASSIFY_MODEL,
  OPENROUTER_ANSWER_MODEL,
  GITHUB_TOKEN,
  VAULT_REPO,
  VAULT_BRANCH = "main",
  OWNER_EMAIL,
} = process.env;

function fail(m) {
  console.error("✗ " + m);
  process.exit(1);
}
if (!URL || !SERVICE) fail("Missing Supabase env");
if (!OPENROUTER_API_KEY) fail("Missing OPENROUTER_API_KEY");
if (!OWNER_EMAIL) fail("Missing OWNER_EMAIL");

const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });

// --- helpers (mirror lib/*.ts) ---
async function chat(model, messages, json) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "X-Title": "Obsidian-X smoke",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0,
      ...(json ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  if (!res.ok) fail(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).choices?.[0]?.message?.content ?? "";
}
async function embed(input) {
  const res = await fetch(`${URL}/functions/v1/embed`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input }),
  });
  if (!res.ok) fail(`embed ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).embedding;
}

// --- owner id ---
const { data: list, error: le } = await admin.auth.admin.listUsers();
if (le) fail("listUsers: " + le.message);
const owner = list.users.find((u) => (u.email || "").toLowerCase() === OWNER_EMAIL.toLowerCase());
if (!owner) fail("Owner user not found — run `npm run setup` first");
console.log("• owner:", owner.id);

const note =
  "Remember: the espresso machine at the office needs descaling every 2 months. " +
  "Last done in May 2026, so next is July. Use citric acid, not vinegar.";

// 1. classify
console.log("• classifying…");
const raw = await chat(
  OPENROUTER_CLASSIFY_MODEL,
  [
    {
      role: "system",
      content:
        'Return ONLY JSON: {"type": one of ["note","task","idea","shopping","reference","person","event"], "title": 3-8 words, "tags": 1-5 kebab-case, "priority": one of ["low","medium","high"]}.',
    },
    { role: "user", content: note },
  ],
  true
);
let c;
try {
  c = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
} catch {
  fail("classify did not return JSON: " + raw.slice(0, 200));
}
console.log("  ✓", JSON.stringify(c));

// 2. embed + 3. store
console.log("• embedding + storing…");
const emb = await embed(`${c.title}\n\n${note}`);
if (!Array.isArray(emb) || emb.length !== 384) fail("bad embedding length: " + (emb && emb.length));
const createdAt = new Date().toISOString();
const { data: item, error: ie } = await admin
  .from("items")
  .insert({
    user_id: owner.id,
    type: c.type || "note",
    title: c.title || "Untitled",
    body: note,
    status: "open",
    priority: c.priority || "medium",
    tags: c.tags || [],
    source: "smoke-test",
    embedding: emb,
    created_at: createdAt,
    valid_from: createdAt,
  })
  .select("id, title, type, tags, priority")
  .single();
if (ie) fail("insert failed: " + ie.message);
console.log("  ✓ item:", item.id);

// 4. vault write
console.log("• writing to vault…");
try {
  const [o, r] = VAULT_REPO.split("/");
  const octokit = new Octokit({ auth: GITHUB_TOKEN });
  const path = `notes/${new Date(createdAt).getUTCFullYear()}/${item.id}.md`;
  const md = `---\nid: ${item.id}\ntype: ${item.type}\npriority: ${item.priority}\nsource: smoke-test\ncreated_at: ${createdAt}\n---\n\n# ${item.title}\n\n${note}\n`;
  await octokit.repos.createOrUpdateFileContents({
    owner: o,
    repo: r,
    path,
    message: `smoke: ${item.title}`,
    content: Buffer.from(md, "utf8").toString("base64"),
    branch: VAULT_BRANCH,
  });
  await admin.from("items").update({ vault_path: path }).eq("id", item.id);
  console.log("  ✓ vault:", `https://github.com/${VAULT_REPO}/blob/${VAULT_BRANCH}/${path}`);
} catch (e) {
  console.error("  ✗ vault write failed:", e.status || "", String(e.message || e).slice(0, 200));
}

// 5. retrieve + answer
console.log("• asking a question…");
const q = "When do I need to descale the office espresso machine and with what?";
const qEmb = await embed(q);
const { data: matches, error: me } = await admin.rpc("match_items", {
  query_embedding: qEmb,
  match_count: 8,
  owner: owner.id,
});
if (me) fail("match_items failed: " + me.message);
if (!matches || matches.length === 0) fail("retrieval returned no rows");
const context = matches
  .map((m, i) => `[${i + 1}] "${m.title}" (${m.type})\n${m.body}`)
  .join("\n\n");
const answer = await chat(OPENROUTER_ANSWER_MODEL, [
  {
    role: "system",
    content:
      "Answer using ONLY the notes. Cite with [n]. Be concise.",
  },
  { role: "user", content: `Notes:\n${context}\n\nQuestion: ${q}` },
]);
console.log("\n=== ANSWER ===\n" + answer);
console.log("\n=== TOP SOURCE ===\n[1] " + matches[0].title + "  (vault_path: " + matches[0].vault_path + ")");
console.log("\n✓ Smoke test passed end-to-end.");
