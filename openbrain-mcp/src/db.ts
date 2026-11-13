import { Pool, PoolClient } from "deno-postgres";

export const pool = new Pool(
  {
    hostname: Deno.env.get("POSTGRES_HOST")!,
    port: parseInt(Deno.env.get("POSTGRES_PORT") || "5432"),
    database: Deno.env.get("POSTGRES_DB")!,
    user: Deno.env.get("POSTGRES_USER")!,
    password: Deno.env.get("POSTGRES_PASSWORD")!,
  },
  20,
  true, // lazy connections
);

export async function withConn<T>(fn: (conn: PoolClient) => Promise<T>): Promise<T> {
  const conn = await pool.connect();
  try {
    return await fn(conn);
  } finally {
    conn.release();
  }
}

// HAOS has no add-on start ordering — retry until the Postgres add-on is up
// instead of crashing into a supervisor restart loop.
export async function waitForPostgres(maxAttempts = 30, delayMs = 2000): Promise<void> {
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      await withConn((c) => c.queryObject`SELECT 1`);
      console.log("INFO: Postgres is reachable.");
      return;
    } catch (e) {
      console.log(`WARN: Postgres not ready (attempt ${i}/${maxAttempts}): ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error("Postgres unreachable after retries — check the OpenBrain Database add-on.");
}

// The MCP add-on can be updated before the Database add-on. Rather than serve
// requests that fail on a missing column or function, wait (then exit, so the
// supervisor restarts us) until the database has the schema this version needs.
export async function waitForMigration(name: string, maxAttempts = 30, delayMs = 10_000): Promise<void> {
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      const ok = await withConn(async (c) => {
        const r = await c.queryObject(`SELECT 1 FROM schema_migrations WHERE name = $1`, [name]);
        return r.rows.length > 0;
      });
      if (ok) return;
    } catch { /* schema_migrations itself missing: same answer */ }
    console.log(
      `WARN: database schema is behind (needs migration ${name}). Update the "OpenBrain Database" add-on to 1.2.0 or later and restart it; waiting (attempt ${i}/${maxAttempts}).`,
    );
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`Database is missing migration ${name}. Update and restart the OpenBrain Database add-on (>= 1.2.0).`);
}

// ── Durable KV (app_state table) ──────────────────────────────────────────────

export async function getState<T>(key: string): Promise<T | null> {
  return await withConn(async (c) => {
    const r = await c.queryObject<{ value: T }>(
      `SELECT value FROM app_state WHERE key = $1`, [key],
    );
    return r.rows.length ? r.rows[0].value : null;
  });
}

export async function setState(key: string, value: unknown): Promise<void> {
  await withConn((c) =>
    c.queryObject(
      `INSERT INTO app_state (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    )
  );
}

// ── Ops log (append-only provenance) ──────────────────────────────────────────

export async function logOp(
  action: string,
  source: string | null,
  subject: string | null,
  detail: Record<string, unknown> = {},
): Promise<void> {
  try {
    await withConn((c) =>
      c.queryObject(
        `INSERT INTO ops_log (action, source, subject, detail) VALUES ($1, $2, $3, $4::jsonb)`,
        [action, source, subject, JSON.stringify(detail)],
      )
    );
  } catch (e) {
    // Logging must never break the operation being logged.
    console.error(`WARN: ops_log write failed: ${(e as Error).message}`);
  }
}
