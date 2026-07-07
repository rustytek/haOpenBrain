// Background worker that finishes what capture couldn't:
//   - embeds thoughts stored while Node A was offline (embedding IS NULL)
//   - re-embeds thoughts whose embedding_model differs from the configured
//     EMBED_MODEL (safe model swaps without data loss)
//   - re-extracts metadata for rows flagged pending_metadata
// Runs forever; failures just mean it tries again next tick.

import { cfg } from "./config.ts";
import { logOp, withConn } from "./db.ts";
import { vecLiteral } from "./brain.ts";
import { extractMetadata, getEmbeddings } from "./llm.ts";

const TICK_MS = 60_000;
const BATCH = 16;

interface PendingRow {
  id: string;
  content: string;
  embed_context: string | null;
  pending_metadata: boolean;
}

let lastErrorLogged = 0;

async function tick(): Promise<void> {
  const rows = await withConn(async (c) => {
    const r = await c.queryObject<PendingRow>(
      `SELECT id, content,
              metadata->>'embed_context' AS embed_context,
              COALESCE((metadata->>'pending_metadata')::boolean, false) AS pending_metadata
       FROM thoughts
       WHERE embedding IS NULL
          OR embedding_model IS DISTINCT FROM $1
          OR COALESCE((metadata->>'pending_metadata')::boolean, false)
       ORDER BY created_at ASC
       LIMIT ${BATCH}`,
      [cfg.embedModel],
    );
    return r.rows;
  });
  if (rows.length === 0) return;

  const embeddings = await getEmbeddings(
    rows.map((r) => (r.embed_context ? `[${r.embed_context}]\n\n${r.content}` : r.content)),
  );

  let embedded = 0;
  let metaFixed = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    let metaSql = "";
    const params: unknown[] = [vecLiteral(embeddings[i]), cfg.embedModel, row.id];
    if (row.pending_metadata) {
      const meta = await extractMetadata(row.content);
      if (meta !== null) {
        metaSql = `, metadata = (metadata - 'pending_metadata') || $4::jsonb`;
        // Preserve capture-time fields the extractor doesn't know about.
        const { source: _s, ...cleaned } = meta as Record<string, unknown>;
        params.push(JSON.stringify(cleaned));
        metaFixed++;
      }
    }

    await withConn((c) =>
      c.queryObject(
        `UPDATE thoughts
         SET embedding = $1::vector(768), embedding_model = $2
         ${metaSql}
         WHERE id = $3`,
        params,
      )
    );
    embedded++;
  }

  console.log(`INFO: backfill embedded ${embedded} thought(s)${metaFixed ? `, re-extracted metadata for ${metaFixed}` : ""}`);
  await logOp("backfill", "worker", null, { embedded, metadata_fixed: metaFixed });
}

export function startBackfillWorker(): void {
  (async () => {
    while (true) {
      try {
        await tick();
      } catch (e) {
        // Expected whenever Node A is asleep — log at most once per 10 min.
        if (Date.now() - lastErrorLogged > 600_000) {
          console.log(`INFO: backfill waiting for LiteLLM: ${(e as Error).message}`);
          lastErrorLogged = Date.now();
        }
      }
      await new Promise((r) => setTimeout(r, TICK_MS));
    }
  })();
  console.log("INFO: backfill worker started (60s interval)");
}
