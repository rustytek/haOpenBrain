// Dev helper: load synthetic.json into a DEV brain over REST, register its
// questions as eval cases, and print the key -> id map.
//   deno run --allow-net --allow-read --allow-write dev/seed.ts http://127.0.0.1:8011 <access-key>
// Never point this at the real brain: it adds 40 invented notes.
const [base, key] = Deno.args;
if (!base || !key) { console.error("usage: seed.ts <base-url> <access-key>"); Deno.exit(1); }
const data = JSON.parse(await Deno.readTextFile(new URL("./synthetic.json", import.meta.url)));
const h = { "x-brain-key": key, "Content-Type": "application/json" };
const ids: Record<string, string> = {};
for (const n of data.notes) {
  const r = await fetch(`${base}/api/thoughts`, { method: "POST", headers: h, body: JSON.stringify({ content: n.t, source: "synthetic" }) });
  const j = await r.json();
  ids[n.k] = j.ids[0];
  console.log(`${n.k} -> ${j.ids[0]}${j.pending_embedding ? " (pending embedding)" : ""}`);
}
for (const q of data.questions) {
  const r = await fetch(`${base}/api/eval/cases`, { method: "POST", headers: h, body: JSON.stringify({ question: q.q, expected: ids[q.k], note: q.k }) });
  console.log((await r.json()).result);
}
await Deno.writeTextFile(new URL("./.ids.json", import.meta.url), JSON.stringify(ids, null, 2));
