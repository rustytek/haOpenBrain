// Central config from env (populated by run.sh from HAOS add-on options).

export const VERSION = "1.2.0"; // keep in sync with config.yaml

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
  embedModel: Deno.env.get("EMBED_MODEL") || "nomic-embed-text",
  chatModel: Deno.env.get("CHAT_MODEL") || "qwen3.5-mlx",

  // Telegram: fail-closed — the bot only starts when BOTH a token and a
  // non-empty user-ID allowlist are configured.
  telegramToken: Deno.env.get("TELEGRAM_BOT_TOKEN") || "",
  telegramAllowedIds: (Deno.env.get("TELEGRAM_ALLOWED_USER_IDS") || "")
    .split(",")
    .map((s) => parseInt(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0),

  exportDir: Deno.env.get("EXPORT_DIR") || "/share/openbrain/export",
};

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
