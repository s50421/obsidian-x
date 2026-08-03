// Obsidian-X — the pairwise similarity landscape of the live corpus.
//
//   node --env-file=.env.local scripts/measure-pairs.mjs
//
// Existing thresholds were measured for a DIFFERENT job (auto-linking at
// capture time, N=29, 2026-07-28). Reusing that number for the connection graph
// was an assumption, not a measurement — so measure it.

import { createClient } from "@supabase/supabase-js";
const a = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {auth:{persistSession:false}});
const { data: u } = await a.auth.admin.listUsers();
const owner = u.users.find(x => x.email === process.env.OWNER_EMAIL);

const { data: items } = await a.from("items")
  .select("id,title,type,tags,source,embedding_v2")
  .eq("user_id", owner.id).neq("status","archived").is("valid_to",null);

const live = items.filter(i => i.source !== "system" && i.embedding_v2);
const vec = (v) => (typeof v === "string" ? JSON.parse(v) : v);
const cos = (x, y) => {
  let d = 0, nx = 0, ny = 0;
  for (let i = 0; i < x.length; i++) { d += x[i]*y[i]; nx += x[i]*x[i]; ny += y[i]*y[i]; }
  return d / (Math.sqrt(nx) * Math.sqrt(ny));
};
const V = live.map(i => vec(i.embedding_v2));

const pairs = [];
for (let i = 0; i < live.length; i++)
  for (let j = i+1; j < live.length; j++)
    pairs.push({ s: cos(V[i], V[j]), a: live[i].title, b: live[j].title });
pairs.sort((p,q) => q.s - p.s);

console.log(`${live.length} non-system items · ${pairs.length} pairs\n`);
console.log("TOP 25 PAIRS BY SEMANTIC SIMILARITY:");
for (const p of pairs.slice(0, 25))
  console.log(`  ${p.s.toFixed(3)}  ${p.a.slice(0,42).padEnd(42)} ↔ ${p.b.slice(0,42)}`);

const q = (f) => pairs[Math.floor(pairs.length * (1-f))].s;
console.log(`\ndistribution: max ${pairs[0].s.toFixed(3)} · p99 ${q(0.99).toFixed(3)} · p95 ${q(0.95).toFixed(3)} · p90 ${q(0.90).toFixed(3)} · p75 ${q(0.75).toFixed(3)} · median ${q(0.5).toFixed(3)}`);
for (const t of [0.45,0.5,0.55,0.6,0.662]) console.log(`  >= ${t}: ${pairs.filter(p=>p.s>=t).length} pairs`);

// ---- what would ADAPTIVE (relative) linking produce? -----------------------
// An absolute cosine threshold cannot survive a changing corpus: 0.662 was
// right for a 29-item set in July and is unreachable today. Rank-based linking
// asks a different question — "who is this item's nearest neighbour?" — which
// needs no re-tuning as the brain grows.
const N = live.length;
const sim = Array.from({length:N}, () => new Array(N).fill(0));
for (let i=0;i<N;i++) for (let j=i+1;j<N;j++) { const s = cos(V[i],V[j]); sim[i][j]=s; sim[j][i]=s; }
const rank = (i) => [...Array(N).keys()].filter(j=>j!==i).sort((x,y)=>sim[i][y]-sim[i][x]);
const FLOOR = 0.30; // sanity floor: never link two items that share nothing

for (const K of [1,2,3]) {
  const tops = Array.from({length:N}, (_,i)=>rank(i).slice(0,K));
  const mutual = [], oneway = [];
  for (let i=0;i<N;i++) for (const j of tops[i]) {
    if (j < i && tops[j].includes(i)) continue;
    if (sim[i][j] < FLOOR) continue;
    (tops[j].includes(i) ? mutual : oneway).push([i,j]);
  }
  const seen = new Set();
  const uniq = [...mutual, ...oneway].filter(([i,j]) => { const k=[i,j].sort().join("|"); if(seen.has(k))return false; seen.add(k); return true; });
  console.log(`\n=== mutual top-${K} (floor ${FLOOR}) → ${mutual.length} mutual, ${uniq.length} total ===`);
  for (const [i,j] of uniq.slice(0,14))
    console.log(`  ${sim[i][j].toFixed(3)} ${tops[j].includes(i)?"↔":"→"} ${live[i].title.slice(0,38).padEnd(38)} ${live[j].title.slice(0,38)}`);
}
