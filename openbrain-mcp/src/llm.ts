// LiteLLM (Node A) client. Every call has a timeout — a sleeping Mac must
// degrade capture, never hang it.

import { cfg, litellmHeaders } from "./config.ts";

const EMBED_TIMEOUT_MS = 45_000;
const META_TIMEOUT_MS = 60_000;
const CHAT_TIMEOUT_MS = 180_000;

export interface ThoughtMetadata {
  people: string[];
  action_items: string[];
  dates_mentioned: string[];
  topics: string[];
  type: "observation" | "task" | "idea" | "reference" | "person_note";
  [key: string]: unknown;
}

export const FALLBACK_META: ThoughtMetadata = {
  people: [],
  action_items: [],
  dates_mentioned: [],
  topics: ["uncategorized"],
  type: "observation",
};

// Batch embedding — one round trip for all chunks of a document. Raw: callers
// use embedDocs / embedQuery below so the task prefix is never forgotten.
async function getEmbeddings(texts: string[]): Promise<number[][]> {
  const res = await fetch(`${cfg.litellmUrl}/embeddings`, {
    method: "POST",
    headers: litellmHeaders(),
    body: JSON.stringify({ model: cfg.embedModel, input: texts }),
    signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Embedding failed: ${res.status} ${res.statusText}`);
  const data = await res.json();
  const items = data.data as { index: number; embedding: number[] }[];
  return items
    .toSorted((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

// nomic-embed-text has a 2048-token window as served by Ollama; longer input is
// cut off silently. Thought chunks are far below this; wiki pages may not be.
const MAX_EMBED_CHARS = 6000;

// Text being stored (thought chunks, wiki pages).
export async function embedDocs(texts: string[]): Promise<number[][]> {
  const p = cfg.embedTaskPrefix === "nomic" ? "search_document: " : "";
  return await getEmbeddings(texts.map((t) => p + t.slice(0, MAX_EMBED_CHARS)));
}

// A search query.
export async function embedQuery(text: string): Promise<number[]> {
  const p = cfg.embedTaskPrefix === "nomic" ? "search_query: " : "";
  return (await getEmbeddings([p + text.slice(0, MAX_EMBED_CHARS)]))[0];
}

// Returns null on any failure so callers can store the thought anyway and let
// the backfill worker re-extract later.
export async function extractMetadata(text: string): Promise<ThoughtMetadata | null> {
  try {
    const res = await fetch(`${cfg.litellmUrl}/chat/completions`, {
      method: "POST",
      headers: litellmHeaders(),
      body: JSON.stringify({
        model: cfg.metaModel,
        response_format: { type: "json_object" },
        messages: [{
          role: "user",
          content: `Extract metadata from the text below. Reply with JSON only.\n` +
            `Fields: people (string[]), action_items (string[]), dates_mentioned (string[] as YYYY-MM-DD), ` +
            `topics (1-3 short tags, string[]), type (one of: observation|task|idea|reference|person_note).\n\n` +
            `Text:\n${text}`,
        }],
      }),
      signal: AbortSignal.timeout(META_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const parsed = parseJsonReply<Partial<ThoughtMetadata>>(data.choices[0].message.content);
    return { ...FALLBACK_META, ...parsed } as ThoughtMetadata;
  } catch {
    return null;
  }
}

// General chat call used by the wiki consolidator.
export async function chat(prompt: string, opts?: { json?: boolean; timeoutMs?: number }): Promise<string> {
  const res = await fetch(`${cfg.litellmUrl}/chat/completions`, {
    method: "POST",
    headers: litellmHeaders(),
    body: JSON.stringify({
      model: cfg.chatModel,
      ...(opts?.json ? { response_format: { type: "json_object" } } : {}),
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(opts?.timeoutMs ?? CHAT_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Chat failed: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return data.choices[0].message.content as string;
}

// Reasoning models (deepseek-r1, qwen3 with thinking on) may wrap the answer in
// <think>…</think> or a code fence even in JSON mode. Take the outermost object.
export function parseJsonReply<T>(raw: string): T {
  const s = raw.replace(/<think>[\s\S]*?<\/think>/g, "");
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("model reply contained no JSON object");
  return JSON.parse(s.slice(a, b + 1)) as T;
}
