// Retrieval eval set: real questions paired with the thought or wiki page that
// should come back. run_eval replays every question through search() and
// reports hit@5, hit@10 and MRR, so a search change can be measured before and
// after instead of judged by feel. The cases are the owner's private data and
// live in the brain's own database like everything else.

import { logOp, withConn } from "./db.ts";
import { search } from "./brain.ts";
import { slugify } from "./wiki.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface EvalCase {
  id: number;
  question: string;
  expected_kind: "thought" | "page";
  expected_ref: string;
  note: string;
}

// `expected` is a thought UUID or a wiki page slug; which one is worked out here.
export async function addEvalCase(question: string, expected: string, note = ""): Promise<string> {
  const q = question.trim();
  const isThought = UUID_RE.test(expected.trim());
  const ref = isThought ? expected.trim().toLowerCase() : slugify(expected);
  const exists = await withConn(async (c) => {
    const r = isThought
      ? await c.queryObject(`SELECT 1 FROM thoughts WHERE id = $1`, [ref])
      : await c.queryObject(`SELECT 1 FROM wiki_pages WHERE name = $1`, [ref]);
    return r.rows.length > 0;
  });
  if (!exists) {
    return `Not saved: there is no ${isThought ? "thought" : "wiki page"} "${ref}". Pass the id shown in a search result, or a page slug from the index.`;
  }
  await withConn((c) =>
    c.queryObject(
      `INSERT INTO eval_cases (question, expected_kind, expected_ref, note) VALUES ($1, $2, $3, $4)
       ON CONFLICT (question) DO UPDATE SET expected_kind = EXCLUDED.expected_kind,
         expected_ref = EXCLUDED.expected_ref, note = EXCLUDED.note`,
      [q, isThought ? "thought" : "page", ref, note],
    )
  );
  await logOp("eval_case", "eval", ref);
  return `Saved test case: "${q}" should find ${isThought ? "thought" : "page"} ${ref}.`;
}

export async function listEvalCases(): Promise<EvalCase[]> {
  return await withConn(async (c) => {
    const r = await c.queryObject<EvalCase>(
      `SELECT id::int AS id, question, expected_kind, expected_ref, note FROM eval_cases ORDER BY id`,
    );
    return r.rows;
  });
}

export async function deleteEvalCase(id: number): Promise<boolean> {
  return await withConn(async (c) => {
    const r = await c.queryObject(`DELETE FROM eval_cases WHERE id = $1 RETURNING id`, [id]);
    return r.rows.length > 0;
  });
}

export interface EvalReport {
  label: string;
  cases: number;
  hit5: number;
  hit10: number;
  mrr: number;
  mode: string;
  misses: { id: number; question: string; rank: number | null; reason?: string }[];
  previous: { ts: string; label: string; cases: number; hit5: number; hit10: number; mrr: number } | null;
}

export async function runEval(label = ""): Promise<EvalReport | null> {
  const cases = await listEvalCases();
  if (cases.length === 0) return null;

  // A superseded expected thought can never be found by default search; that is
  // a stale test case, not a search failure, so say so.
  const superseded = await withConn(async (c) => {
    const r = await c.queryObject<{ id: string }>(
      `SELECT id FROM thoughts WHERE superseded_by IS NOT NULL AND id::text = ANY($1::text[])`,
      [cases.filter((k) => k.expected_kind === "thought").map((k) => k.expected_ref)],
    );
    return new Set(r.rows.map((x) => x.id));
  });

  let h5 = 0, h10 = 0, rr = 0, textOnly = 0;
  const misses: EvalReport["misses"] = [];
  for (const k of cases) {
    const { hits, mode } = await search(k.question, { limit: 10 });
    if (mode === "text-only") textOnly++;
    const idx = hits.findIndex((h) => h.kind === k.expected_kind && h.ref === k.expected_ref);
    const rank = idx < 0 ? null : idx + 1;
    if (rank !== null) {
      rr += 1 / rank;
      if (rank <= 5) h5++;
      h10++;
    }
    if (rank === null || rank > 5) {
      misses.push({
        id: k.id,
        question: k.question,
        rank,
        ...(superseded.has(k.expected_ref) ? { reason: "expected thought is superseded: update or delete this case" } : {}),
      });
    }
  }
  const n = cases.length;
  const report = {
    label,
    cases: n,
    hit5: h5 / n,
    hit10: h10 / n,
    mrr: rr / n,
    mode: textOnly === 0 ? "hybrid" : textOnly === n ? "text-only" : `mixed (${textOnly}/${n} keyword-only)`,
    misses,
  };

  const previous = await withConn(async (c) => {
    const prev = await c.queryObject<{ ts: Date; label: string; cases: number; hit5: number; hit10: number; mrr: number }>(
      `SELECT ts, label, cases, hit5, hit10, mrr FROM eval_runs ORDER BY ts DESC LIMIT 1`,
    );
    await c.queryObject(
      `INSERT INTO eval_runs (label, cases, hit5, hit10, mrr, detail) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [label, n, report.hit5, report.hit10, report.mrr, JSON.stringify({ mode: report.mode, missed_case_ids: misses.map((m) => m.id) })],
    );
    const p = prev.rows[0];
    // float8 columns arrive as strings from the driver.
    return p
      ? { ts: new Date(p.ts).toISOString(), label: p.label, cases: Number(p.cases), hit5: Number(p.hit5), hit10: Number(p.hit10), mrr: Number(p.mrr) }
      : null;
  });
  await logOp("eval_run", "eval", label || null, { cases: n, hit5: report.hit5, hit10: report.hit10, mrr: report.mrr });
  return { ...report, previous };
}

export function formatEval(r: EvalReport | null): string {
  if (!r) return "No test cases yet. Add some with add_eval_case: a question you would really ask, plus the id of the thought (or the slug of the page) that should come back.";
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
  const lines = [
    `Retrieval test${r.label ? ` "${r.label}"` : ""}: ${r.cases} case(s), search mode ${r.mode}`,
    `hit@5 ${pct(r.hit5)}   hit@10 ${pct(r.hit10)}   MRR ${r.mrr.toFixed(3)}`,
  ];
  if (r.previous) {
    const d = (a: number, b: number) => `${a - b >= 0 ? "+" : ""}${((a - b) * 100).toFixed(0)} pts`;
    lines.push(
      `Previous run (${r.previous.ts.slice(0, 10)}${r.previous.label ? `, "${r.previous.label}"` : ""}, ${r.previous.cases} cases): ` +
        `hit@5 ${pct(r.previous.hit5)} (${d(r.hit5, r.previous.hit5)}), hit@10 ${pct(r.previous.hit10)} (${d(r.hit10, r.previous.hit10)}), MRR ${r.previous.mrr.toFixed(3)}`,
    );
  }
  if (r.mode !== "hybrid") lines.push("Warning: the embedding service was unreachable for some questions, so this run understates search quality.");
  if (r.cases < 20) lines.push(`With only ${r.cases} cases, one question moves hit@5 by ${(100 / r.cases).toFixed(0)} points: add more before trusting small differences.`);
  if (r.misses.length) {
    lines.push(`\nNot in the top 5 (${r.misses.length}):`);
    for (const m of r.misses) {
      lines.push(`- #${m.id} "${m.question}" — ${m.rank ? `rank ${m.rank}` : "not in top 10"}${m.reason ? ` (${m.reason})` : ""}`);
    }
  }
  return lines.join("\n");
}
