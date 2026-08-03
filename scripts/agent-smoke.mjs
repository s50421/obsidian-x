// Obsidian-X v4.2.3 — run one agent turn from the terminal.
//
//   node --env-file=.env.local --experimental-strip-types --no-warnings \
//     scripts/agent-smoke.mjs "are these in ClickUp?"
//
// Prints latency, tool steps, cost and cache hit rate — the four numbers the
// brief's cost exit test is about. Sends nothing to Telegram; it exercises the
// loop directly so a change can be measured without a phone in hand.
//
// Note on cost readings: the FIRST call after a change writes the prompt cache
// at a premium, so judge steady state from the second run onward.

import { register } from "node:module";
import { createClient } from "@supabase/supabase-js";
register(new URL("./_alias-hook.mjs", import.meta.url), import.meta.url);
const { runAgent } = await import("../lib/agent.ts");
const a = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {auth:{persistSession:false}});
const { data: u } = await a.auth.admin.listUsers();
const o = u.users.find(x => x.email === process.env.OWNER_EMAIL);

const q = process.argv[2];
const t0 = Date.now();
const r = await runAgent(a, o.id, q, { tz: "America/Vancouver", turns: [], recentItemIds: [] });
const cost = r.usage.reduce((n,u)=>n+(u.cost_usd??0),0);
console.log(`Q: ${q}`);
const cached = r.usage.reduce((n,u)=>n+(u.cached_tokens??0),0);
const prompt = r.usage.reduce((n,u)=>n+(u.prompt_tokens??0),0);
console.log(`--- ${Date.now()-t0}ms · ${r.steps} steps · $${cost.toFixed(4)} · cached ${cached}/${prompt} prompt tokens · tools: ${r.toolsUsed.join(" → ")||"none"}`);
console.log(r.reply);
