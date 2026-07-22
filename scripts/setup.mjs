// One-time setup / health check. Run: npm run setup
// - creates the single owner user (so magic-link sign-in works)
// - verifies the `embed` edge function is deployed
// - verifies the `match_items` RPC exists (migration applied)
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ownerEmail = (process.env.OWNER_EMAIL || "").trim();

function fail(msg) {
  console.error("✗ " + msg);
  process.exit(1);
}

if (!url || !service) fail("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local");
if (!ownerEmail) fail("OWNER_EMAIL is not set in .env.local");

const admin = createClient(url, service, { auth: { persistSession: false } });

// 1. Ensure the owner user exists.
console.log("• Ensuring owner user:", ownerEmail);
let userId = null;
const { data: list, error: le } = await admin.auth.admin.listUsers();
if (le) fail("listUsers failed: " + le.message);
const existing = list.users.find(
  (u) => (u.email || "").toLowerCase() === ownerEmail.toLowerCase()
);
if (existing) {
  userId = existing.id;
  console.log("  ✓ already exists:", userId);
} else {
  const { data, error } = await admin.auth.admin.createUser({
    email: ownerEmail,
    email_confirm: true,
  });
  if (error) fail("createUser failed: " + error.message);
  userId = data.user.id;
  console.log("  ✓ created:", userId);
}

// 2. Embed edge function.
console.log("• Testing embed edge function…");
try {
  const res = await fetch(`${url}/functions/v1/embed`, {
    method: "POST",
    headers: { Authorization: `Bearer ${service}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input: "hello world" }),
  });
  if (!res.ok) {
    console.error("  ✗ embed returned", res.status, (await res.text()).slice(0, 300));
    console.error("    -> deploy it:  supabase functions deploy embed --project-ref " + url.split("//")[1].split(".")[0]);
  } else {
    const d = await res.json();
    console.log("  ✓ embed OK, dims:", Array.isArray(d.embedding) ? d.embedding.length : "?");
  }
} catch (e) {
  console.error("  ✗ embed error:", String(e));
}

// 3. match_items RPC.
console.log("• Testing match_items RPC…");
const zero = new Array(384).fill(0);
const { error: re } = await admin.rpc("match_items", {
  query_embedding: zero,
  match_count: 1,
  owner: userId,
});
if (re) {
  console.error("  ✗ match_items failed:", re.message);
  console.error("    -> run supabase/migrations/0001_rls_and_match.sql in the Supabase SQL editor");
} else {
  console.log("  ✓ match_items OK");
}

console.log("\nOwner user id:", userId);
console.log("Setup checks complete.");
