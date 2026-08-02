// Shared helper: replay stored inflow rows through the CURRENT ranker,
// IN MEMORY, without touching the database.
//
// The stored model read (importance / deadline / question / money / confidence)
// is held fixed and only the scoring is re-run, which isolates a scoring change
// as the single variable. Importance is recovered by subtracting the
// deterministic contributions from the stored total — exact for rows that were
// neither capped nor floored, and for the rows where it ISN'T exact the new
// rules ignore importance anyway (a bulk row is capped regardless of it).
//
// Nothing here writes. Rescoring stored history in place would overwrite real
// measurements with reconstructions, and the reconstruction is not good enough
// to be the system of record — only good enough to answer "what would this
// letter have looked like?"

export async function rescoreRows(rows, { admin, userId, mailbox = "david@manhartgroup.com" }) {
  const { scoreMail, deterministicSignals, loadVip, loadDemote, loadIdentities, loadKnownSenders } =
    await import("../lib/rank-mail.ts");

  const vip = await loadVip(admin, userId);
  const demote = await loadDemote(admin, userId);
  const identities = await loadIdentities(admin, userId, mailbox);
  const known = await loadKnownSenders(admin, userId);

  return rows.map((r) => {
    const rr = r.ranked_reason ?? {};
    const sig = new Set(rr.signals ?? []);
    const base =
      (r.ranked_score ?? 0) -
      (sig.has("VIP sender") ? 35 : 0) -
      (sig.has("direct to me") ? 15 : 0) -
      (sig.has("awaiting my reply") ? 20 : sig.has("thread reply") ? 5 : 0) -
      (sig.has("deadline") ? 20 : 0) -
      (sig.has("direct question") ? 15 : 0) -
      (sig.has("money/legal") ? 15 : 0) -
      (sig.has("known correspondent") ? 10 : 0);

    const content = {
      importance: Math.min(1, Math.max(0, base / 25)),
      deadline: sig.has("deadline"),
      question: sig.has("direct question"),
      money: sig.has("money/legal"),
      reason: rr.reason ?? "",
      confidence: Number(rr.confidence ?? 0),
      usage: null,
    };

    const meta = {
      id: r.id,
      snippet: r.snippet ?? "",
      labelIds: sig.has("promotions") ? ["CATEGORY_PROMOTIONS"] : [],
      headers: {
        from: r.sender ?? "",
        to: sig.has("direct to me") ? identities[0] : "someone-else@example.com",
        cc: "",
        subject: r.subject ?? "",
        date: r.ts ?? new Date().toISOString(),
        "list-unsubscribe": sig.has("bulk") ? "<mailto:x@y.z>" : "",
        "auto-submitted": sig.has("automated") ? "auto-generated" : "",
        "in-reply-to": sig.has("thread reply") ? "<x@y.z>" : "",
      },
    };

    const signals = deterministicSignals(meta, identities, vip, demote, sig.has("awaiting my reply"), known);
    const next = scoreMail(signals, content);
    return {
      ...r,
      ranked_score: next.score,
      ranked_reason: { ...rr, signals: next.signals, vip: next.vip, bulk: next.bulk },
    };
  });
}
