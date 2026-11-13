// Outdated-fact detection. For each recently captured thought, find older
// current thoughts that are close in meaning and share a person or topic, and
// ask the local chat model whether the newer one replaces the older.
//
// The pass only PROPOSES. A small local model is not trusted to hide memories
// on its own, so nothing is superseded until a person accepts the proposal
// (review_conflicts / resolve_conflict). Pairs judged compatible are recorded
// too, so they are not asked about again.

import { getState, logOp, setState, withConn } from "./db.ts";
import { chat, parseJsonReply } from "./llm.ts";
import { supersedeThought } from "./brain.ts";

const WATERMARK_KEY = "last_conflict_scan_watermark";
const MAX_NEW_PER_RUN = 12;       // bounded: each pair is one local-model call
const MAX_CANDIDATES_PER_NEW = 3;
// Candidate rule (cosine distance; smaller = closer in meaning). Topic tags are
// free text from a small model and rarely match between two notes about the
// same thing, so very close notes qualify on distance alone; looser matches
// also need a shared person or topic. Measured on dev/synthetic.json: real
// replacement pairs sat at 0.11-0.24.
const CLOSE_DISTANCE = 0.25;
const MAX_DISTANCE = 0.35;
const JUDGE_TIMEOUT_MS = 120_000;
const FIRST_RUN_LOOKBACK_DAYS = 30;

interface Row {
  id: string;
  content: string;
  created_at: Date | string;
}

const day = (d: Date | string) => new Date(d).toISOString().slice(0, 10);

async function judge(newer: Row, older: Row): Promise<{ verdict: "supersedes" | "duplicate" | "compatible"; reason: string }> {
  const prompt = `Two notes from one person's memory. Decide whether the NEWER note makes the OLDER note outdated.

OLDER (${day(older.created_at)}): ${older.content}

NEWER (${day(newer.created_at)}): ${newer.content}

Test: imagine the older note were hidden from now on. Would any fact be lost that is still true and is not stated in the newer note?
- If yes, the verdict is "compatible". A follow-up, a next step, more detail, or a different event about the same person or thing is "compatible".
- "supersedes" only when the older note describes a state, plan, quote, problem or number that the newer note says has changed, been decided otherwise, or been resolved, AND the older note has no other lasting fact (such as a date, a name, a preference or a specification) that would be lost.
- "duplicate" only when both notes state the same facts.
- When unsure, answer "compatible".

Reply with JSON only: {"lost_facts": "<still-true facts only the older note has, or none>", "verdict": "supersedes" | "duplicate" | "compatible", "reason": "<one short sentence>"}`;
  const parsed = parseJsonReply<{ verdict?: string; reason?: string }>(
    await chat(prompt, { json: true, timeoutMs: JUDGE_TIMEOUT_MS }),
  );
  const v = parsed.verdict === "supersedes" || parsed.verdict === "duplicate" ? parsed.verdict : "compatible";
  return { verdict: v, reason: String(parsed.reason ?? "").slice(0, 300) };
}

export async function findConflicts(trigger: string): Promise<string> {
  // First run: start 30 days back rather than at the beginning of time. Working
  // through years of history at a dozen thoughts a night would take months and
  // keep the local model busy; set the watermark by hand to go further back.
  const watermark = (await getState<string>(WATERMARK_KEY)) ??
    new Date(Date.now() - FIRST_RUN_LOOKBACK_DAYS * 86_400_000).toISOString();

  const fresh = await withConn(async (c) => {
    const r = await c.queryObject<Row>(
      `SELECT id, content, created_at FROM thoughts
       WHERE created_at > $1::timestamptz AND superseded_by IS NULL AND embedding IS NOT NULL
       ORDER BY created_at ASC LIMIT ${MAX_NEW_PER_RUN}`,
      [watermark],
    );
    return r.rows;
  });
  if (fresh.length === 0) return "No new thoughts to check for outdated facts.";

  let checked = 0, proposed = 0, failed = 0;
  let lastDone: Row | null = null;
  for (const n of fresh) {
    // Older, current, same person or topic, semantically close, not yet judged.
    const cands = await withConn(async (c) => {
      const r = await c.queryObject<Row>(
        `SELECT o.id, o.content, o.created_at
         FROM thoughts n, thoughts o
         WHERE n.id = $1 AND o.id <> n.id
           AND o.created_at < n.created_at AND o.superseded_by IS NULL AND o.embedding IS NOT NULL
           AND COALESCE(o.metadata->>'doc_fingerprint', 'o') <> COALESCE(n.metadata->>'doc_fingerprint', 'n')
           AND (
             (o.embedding <=> n.embedding) < ${CLOSE_DISTANCE}
             OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(n.metadata->'people') = 'array' THEN n.metadata->'people' ELSE '[]'::jsonb END) a
                     JOIN jsonb_array_elements_text(CASE WHEN jsonb_typeof(o.metadata->'people') = 'array' THEN o.metadata->'people' ELSE '[]'::jsonb END) b ON lower(a) = lower(b))
             OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(n.metadata->'topics') = 'array' THEN n.metadata->'topics' ELSE '[]'::jsonb END) a
                     JOIN jsonb_array_elements_text(CASE WHEN jsonb_typeof(o.metadata->'topics') = 'array' THEN o.metadata->'topics' ELSE '[]'::jsonb END) b ON lower(a) = lower(b)
                     WHERE lower(a) <> 'uncategorized')
           )
           AND (o.embedding <=> n.embedding) < ${MAX_DISTANCE}
           AND NOT EXISTS (SELECT 1 FROM thought_conflicts x WHERE x.newer_id = n.id AND x.older_id = o.id)
         ORDER BY o.embedding <=> n.embedding
         LIMIT ${MAX_CANDIDATES_PER_NEW}`,
        [n.id],
      );
      return r.rows;
    });

    let ok = true;
    for (const o of cands) {
      try {
        const { verdict, reason } = await judge(n, o);
        await withConn((c) =>
          c.queryObject(
            `INSERT INTO thought_conflicts (newer_id, older_id, verdict, reason, status)
             VALUES ($1, $2, $3, $4, $5) ON CONFLICT (newer_id, older_id) DO NOTHING`,
            [n.id, o.id, verdict, reason, verdict === "compatible" ? "dismissed" : "pending"],
          )
        );
        checked++;
        if (verdict !== "compatible") proposed++;
      } catch (e) {
        // Node A asleep or the model timed out: stop here and retry this thought next run.
        console.log(`INFO: conflict scan paused: ${(e as Error).message}`);
        failed++;
        ok = false;
        break;
      }
    }
    if (!ok) break;
    lastDone = n;
  }

  if (lastDone) await setState(WATERMARK_KEY, new Date(lastDone.created_at).toISOString());
  await logOp("conflict_scan", trigger, null, { thoughts: fresh.length, pairs_checked: checked, proposed, failed });
  return `Checked ${checked} pair(s) across ${fresh.length} new thought(s): ${proposed} possible outdated fact(s) proposed for review` +
    (failed ? `; stopped early (inference node unavailable), will resume next run.` : ".");
}

export interface Conflict {
  id: number;
  verdict: string;
  reason: string;
  newer_id: string;
  newer_content: string;
  newer_at: Date | string;
  older_id: string;
  older_content: string;
  older_at: Date | string;
}

export async function listConflicts(limit = 10): Promise<Conflict[]> {
  return await withConn(async (c) => {
    const r = await c.queryObject<Conflict>(
      `SELECT x.id::int AS id, x.verdict, x.reason,
              n.id AS newer_id, n.content AS newer_content, n.created_at AS newer_at,
              o.id AS older_id, o.content AS older_content, o.created_at AS older_at
       FROM thought_conflicts x
       JOIN thoughts n ON n.id = x.newer_id
       JOIN thoughts o ON o.id = x.older_id
       WHERE x.status = 'pending'
       ORDER BY x.created_at ASC LIMIT $1`,
      [limit],
    );
    return r.rows;
  });
}

export function formatConflicts(rows: Conflict[]): string {
  if (rows.length === 0) return "No possible outdated facts are waiting for review.";
  return `${rows.length} proposal(s). For each: resolve_conflict with action "accept" (the older note is outdated: hide it from search, keep it on file) or "reject" (both stay current).\n\n` +
    rows.map((r) =>
      `#${r.id} (${r.verdict}) ${r.reason}\n` +
      `  OLDER ${day(r.older_at)} [${r.older_id}]: ${r.older_content.replace(/\s+/g, " ").slice(0, 400)}\n` +
      `  NEWER ${day(r.newer_at)} [${r.newer_id}]: ${r.newer_content.replace(/\s+/g, " ").slice(0, 400)}`
    ).join("\n\n");
}

export async function resolveConflict(id: number, action: "accept" | "reject", source: string): Promise<string> {
  const row = await withConn(async (c) => {
    const r = await c.queryObject<{ newer_id: string; older_id: string; reason: string; status: string }>(
      `SELECT newer_id, older_id, reason, status FROM thought_conflicts WHERE id = $1`, [id],
    );
    return r.rows[0];
  });
  if (!row) return `No proposal #${id}.`;
  if (row.status !== "pending") return `Proposal #${id} was already ${row.status}.`;
  let msg = `Rejected #${id}: both notes stay current.`;
  if (action === "accept") {
    msg = await supersedeThought(row.older_id, row.newer_id, row.reason, source);
    if (!msg.startsWith("Marked")) return msg;
  }
  await withConn((c) =>
    c.queryObject(
      `UPDATE thought_conflicts SET status = $2, resolved_at = now() WHERE id = $1`,
      [id, action === "accept" ? "accepted" : "rejected"],
    )
  );
  return msg;
}
