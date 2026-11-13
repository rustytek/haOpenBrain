// Central config from env (populated by run.sh from HAOS add-on options).

export const VERSION = "1.3.0"; // keep in sync with config.yaml

function required(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const cfg = {
  litellmUrl: required("LITELLM_URL"),
  litellmApiKey: Deno.env.get("LITELLM_API_KEY") || "",
  mcpAccessKey: required("MCP_ACCESS_KEY"),
  port: parseInt(Deno.env.get("PORT") || "8000"),
  embedModel: Deno.env.get("EMBED_MODEL") || "embedding",
  chatModel: Deno.env.get("CHAT_MODEL") || "knowledge_local_high",
  // Model for per-capture metadata extraction (people, topics, type). Defaults
  // to chat_model. A non-reasoning alias such as tooling_local_high does this
  // simple job in a couple of seconds instead of up to a minute.
  metaModel: Deno.env.get("META_MODEL") || Deno.env.get("CHAT_MODEL") || "knowledge_local_high",

  // Telegram: fail-closed — the bot only starts when BOTH a token and a
  // non-empty user-ID allowlist are configured.
  telegramToken: Deno.env.get("TELEGRAM_BOT_TOKEN") || "",
  telegramAllowedIds: (Deno.env.get("TELEGRAM_ALLOWED_USER_IDS") || "")
    .split(",")
    .map((s) => parseInt(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0),

  exportDir: Deno.env.get("EXPORT_DIR") || "/share/openbrain/export",

  // "nomic": prefix stored text with "search_document: " and queries with
  // "search_query: ", as nomic-embed-text (the model behind the `embedding`
  // alias) is documented to expect. "none" (default): send text as is.
  // Off by default: on a 40-note synthetic test (2026-11-12) it made no
  // measurable difference, and turning it on re-embeds the whole brain. Run
  // run_eval before and after on real cases before keeping it on.
  embedTaskPrefix: Deno.env.get("EMBED_TASK_PREFIX") === "nomic" ? "nomic" : "none",
};

// What the embedding_model column is stamped with. It includes the prefix style,
// so changing the style (or the model) makes the backfill worker re-embed
// everything instead of leaving old and new vectors mixed in one index.
export const EMBED_STAMP = cfg.embedTaskPrefix === "nomic" ? `${cfg.embedModel}+nomic-prefix` : cfg.embedModel;

// Database migration this server version needs (openbrain-postgres add-on >= 1.2.0).
export const REQUIRED_MIGRATION = "003_search_supersession_provenance_eval.sql";

// OpenBrain addresses models ONLY by LiteLLM tier alias — never by a concrete
// model name. The alias is the whole point of the indirection: Node A can swap
// the model behind it with no config change here. So this is an ALLOWLIST, not
// a denylist of bad names — a direct name that happens to work today
// (`nomic-embed-text`) is still wrong, because it pins the brain to one model
// and silently stops following the alias.
//
// Extend these when aiProxy gains a new tier alias OpenBrain should use.
const ALLOWED_EMBED_MODELS = ["embedding"]; // dimension-locked: 768-dim, pinned to one model by design
// Both families are local-only by design (privacy): they never fall back to a
// remote model. knowledge_local_* reasons; tooling_local_* is fast and does not.
const ALLOWED_CHAT_MODELS = /^(knowledge|tooling)_local_(high|med|low)$/;

export function assertLiteLLMOnly(): void {
  if (!ALLOWED_EMBED_MODELS.includes(cfg.embedModel)) {
    throw new Error(
      `embed_model="${cfg.embedModel}" is not a LiteLLM tier alias. OpenBrain must ` +
        `address models by alias only, never by a concrete model name. ` +
        `Set embed_model to: ${ALLOWED_EMBED_MODELS.join(" | ")}`,
    );
  }
  for (const [opt, val] of [["chat_model", cfg.chatModel], ["meta_model", cfg.metaModel]]) {
    if (!ALLOWED_CHAT_MODELS.test(val)) {
      throw new Error(
        `${opt}="${val}" is not a local LiteLLM tier alias. OpenBrain must address models ` +
          `by alias only, never by a concrete model name, and only local-only aliases. ` +
          `Set ${opt} to one of: knowledge_local_high | knowledge_local_med | knowledge_local_low | ` +
          `tooling_local_high | tooling_local_med | tooling_local_low`,
      );
    }
  }
  if (/:11434(\/|$)/.test(cfg.litellmUrl)) {
    throw new Error(
      `litellm_url="${cfg.litellmUrl}" points at port 11434 (Ollama). OpenBrain must ` +
        `go through LiteLLM — use the gateway URL (default port 4000).`,
    );
  }
}

export function litellmHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.litellmApiKey) h["Authorization"] = `Bearer ${cfg.litellmApiKey}`;
  return h;
}

// Compare digests instead of raw strings so key comparison is not
// timing-observable.
export async function checkAccessKey(candidate: string | undefined): Promise<boolean> {
  if (!candidate) return false;
  const digest = async (s: string) => {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  };
  return (await digest(candidate)) === (await digest(cfg.mcpAccessKey));
}
