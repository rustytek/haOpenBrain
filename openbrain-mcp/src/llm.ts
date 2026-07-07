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

// Batch embedding — one round trip for all chunks of a document.
export async function getEmbeddings(texts: string[]): Promise<number[][]> {
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

export async function getEmbedding(text: string): Promise<number[]> {
  return (await getEmbeddings([text]))[0];
}

// Returns null on any failure so callers can store the thought anyway and let
// the backfill worker re-extract later.
export async function extractMetadata(text: string): Promise<ThoughtMetadata | null> {
  try {
    const res = await fetch(`${cfg.litellmUrl}/chat/completions`, {
      method: "POST",
      headers: litellmHeaders(),
      body: JSON.stringify({
        model: cfg.chatModel,
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
    const parsed = JSON.parse(data.choices[0].message.content);
    return { ...FALLBACK_META, ...parsed } as ThoughtMetadata;
  } catch {
    return null;
  }
}

// General chat call used by the wiki consolidator.
export async function chat(prompt: string, opts?: { json?: boolean }): Promise<string> {
  const res = await fetch(`${cfg.litellmUrl}/chat/completions`, {
    method: "POST",
    headers: litellmHeaders(),
    body: JSON.stringify({
      model: cfg.chatModel,
      ...(opts?.json ? { response_format: { type: "json_object" } } : {}),
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Chat failed: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return data.choices[0].message.content as string;
}
