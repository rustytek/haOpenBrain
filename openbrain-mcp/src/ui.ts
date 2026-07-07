// Read-only dashboard served through Home Assistant ingress (sidebar panel).
// Reached only via the supervisor's ingress proxy — HA handles authentication.

import { browseRecent, formatStats, getStats, searchThoughts } from "./brain.ts";
import { getIndex } from "./wiki.ts";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function renderDashboard(query: string | undefined, basePath: string): Promise<string> {
  const stats = await getStats();

  let resultsHtml = "";
  if (query) {
    const { results, mode } = await searchThoughts(query, 10);
    resultsHtml = `<h2>Search: ${esc(query)} ${mode === "text-only" ? "(keyword-only)" : ""}</h2>` +
      (results.length === 0
        ? "<p>No results.</p>"
        : results.map((r) =>
          `<div class="card"><div class="meta">${new Date(r.created_at).toISOString()} · score ${
            Number(r.score ?? 0).toFixed(4)
          }</div><pre>${esc(r.content)}</pre></div>`
        ).join(""));
  }

  const recent = await browseRecent(15);
  const recentHtml = recent.map((r) =>
    `<div class="card"><div class="meta">${new Date(r.created_at).toISOString()} · ${
      esc(((r.metadata as Record<string, unknown>)?.source as string) ?? "?")
    }</div><pre>${esc(r.content.slice(0, 500))}${r.content.length > 500 ? "…" : ""}</pre></div>`
  ).join("");

  const wikiIndex = await getIndex();

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenBrain</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 60rem; margin: 0 auto; padding: 1rem; }
  .card { border: 1px solid color-mix(in srgb, currentColor 25%, transparent); border-radius: 8px; padding: .6rem .8rem; margin: .5rem 0; }
  .meta { font-size: .75rem; opacity: .65; margin-bottom: .3rem; }
  pre { white-space: pre-wrap; word-break: break-word; margin: 0; font: inherit; }
  .stats { font-family: ui-monospace, monospace; font-size: .85rem; white-space: pre-wrap; }
  input[type=search] { width: 100%; padding: .5rem; border-radius: 8px; border: 1px solid currentColor; background: transparent; color: inherit; }
  h1 { font-size: 1.3rem; } h2 { font-size: 1.05rem; margin-top: 1.5rem; }
  details > pre { padding: .5rem 0; }
</style></head><body>
<h1>🧠 OpenBrain</h1>
<form method="get" action="${esc(basePath)}"><input type="search" name="q" placeholder="Search memory…" value="${esc(query ?? "")}"></form>
${resultsHtml}
<h2>Stats</h2><div class="card stats">${esc(formatStats(stats))}</div>
<h2>Wiki index</h2><details${stats.wiki_pages > 0 ? " open" : ""}><summary>${stats.wiki_pages} pages</summary><pre>${esc(wikiIndex)}</pre></details>
<h2>Recent thoughts</h2>${recentHtml || "<p>No thoughts yet.</p>"}
</body></html>`;
}
