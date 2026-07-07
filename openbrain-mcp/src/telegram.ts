// Hardened Telegram capture bot.
//
// Security model (fail closed):
//   - The bot does not start unless BOTH telegram_bot_token AND a non-empty
//     telegram_allowed_user_ids allowlist are configured.
//   - Long polling only (outbound HTTPS to api.telegram.org) — no webhook, no
//     inbound port, nothing new exposed on the LAN.
//   - Private chats only; sender must be on the allowlist; bot senders and
//     non-text messages are ignored.
//   - Unauthorized messages are dropped silently (no reply — replying would
//     confirm the bot exists) and logged at most once per sender per hour.
//   - First-ever run drops backlog older than 10 minutes so a leaked/reused
//     token can't replay a queue of old messages into the brain.
//   - Message text is never logged, only lengths and user IDs.
//   - Replies are plain text (no parse_mode) — nothing to inject.
//   - Per-user rate limit: 20 messages/minute, then a cooldown notice.

import { cfg } from "./config.ts";
import { getState, setState } from "./db.ts";
import { browseRecent, captureThought, formatStats, getStats, searchThoughts } from "./brain.ts";

const OFFSET_KEY = "telegram_offset";
const POLL_TIMEOUT_S = 50;
const MAX_MSG_LEN = 8000;
const RATE_LIMIT = 20; // messages per minute per user
const STARTUP_BACKLOG_S = 600;

interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    text?: string;
    chat: { id: number; type: string };
    from?: { id: number; is_bot: boolean; first_name?: string };
  };
}

const api = (method: string) => `https://api.telegram.org/bot${cfg.telegramToken}/${method}`;

async function tg(method: string, body: Record<string, unknown>, timeoutMs = 15_000): Promise<unknown> {
  const res = await fetch(api(method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.error_code} ${data.description}`);
  return data.result;
}

async function reply(chatId: number, msg: string): Promise<void> {
  // Telegram caps messages at 4096 chars; split conservatively.
  for (let i = 0; i < msg.length; i += 4000) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: msg.slice(i, i + 4000),
      disable_web_page_preview: true,
    });
  }
}

// ── Rate limiting & unauthorized-log throttling ───────────────────────────────

const msgTimes = new Map<number, number[]>();
const unauthorizedLogged = new Map<number, number>();

function rateLimited(userId: number): boolean {
  const now = Date.now();
  const times = (msgTimes.get(userId) ?? []).filter((t) => now - t < 60_000);
  times.push(now);
  msgTimes.set(userId, times);
  return times.length > RATE_LIMIT;
}

function logUnauthorized(userId: number): void {
  const last = unauthorizedLogged.get(userId) ?? 0;
  if (Date.now() - last > 3_600_000) {
    console.warn(`WARN: telegram message from unauthorized user id ${userId} dropped.`);
    unauthorizedLogged.set(userId, Date.now());
  }
}

// ── Command handling ──────────────────────────────────────────────────────────

const HELP = `OpenBrain capture bot.

Send any text to capture it as a thought.

Commands:
/search <query> — hybrid search your memory
/recent [n] — list recent thoughts (default 10)
/stats — brain statistics
/help — this message`;

async function handleText(chatId: number, textMsg: string): Promise<void> {
  const [cmd, ...rest] = textMsg.trim().split(/\s+/);
  const arg = rest.join(" ");

  switch (cmd) {
    case "/start":
    case "/help":
      await reply(chatId, HELP);
      return;

    case "/search": {
      if (!arg) return await reply(chatId, "Usage: /search <query>");
      const { results, mode } = await searchThoughts(arg, 5);
      if (results.length === 0) return await reply(chatId, "No results.");
      const out = results
        .map((r, i) => `${i + 1}. ${r.content.slice(0, 400)}${r.content.length > 400 ? "…" : ""}`)
        .join("\n\n");
      await reply(chatId, `${mode === "text-only" ? "(keyword-only — inference node offline)\n" : ""}${out}`);
      return;
    }

    case "/recent": {
      const n = Math.min(parseInt(arg) || 10, 25);
      const rows = await browseRecent(n);
      if (rows.length === 0) return await reply(chatId, "No thoughts yet.");
      await reply(
        chatId,
        rows.map((r, i) => `${i + 1}. ${r.content.slice(0, 150)}${r.content.length > 150 ? "…" : ""}`).join("\n"),
      );
      return;
    }

    case "/stats":
      await reply(chatId, formatStats(await getStats()));
      return;

    default: {
      const r = await captureThought(textMsg, "telegram");
      const note = r.pendingEmbedding ? " (inference node offline — will embed later)" : "";
      await reply(chatId, `Captured${r.chunks > 1 ? ` as ${r.chunks} chunks` : ""}${note}. id: ${r.ids[0].slice(0, 8)}`);
      return;
    }
  }
}

// ── Update processing ─────────────────────────────────────────────────────────

async function handleUpdate(u: TgUpdate, startupTime: number): Promise<void> {
  const m = u.message;
  if (!m || typeof m.text !== "string") return; // text messages only — no media, captions, edits
  if (m.chat.type !== "private") return; // no groups/channels
  if (!m.from || m.from.is_bot) return;

  if (!cfg.telegramAllowedIds.includes(m.from.id)) {
    logUnauthorized(m.from.id);
    return; // silent drop
  }

  // First-run backlog protection: ignore stale queued messages.
  if (m.date * 1000 < startupTime - STARTUP_BACKLOG_S * 1000) {
    console.log(`INFO: telegram dropping stale queued message (age ${Math.round((startupTime - m.date * 1000) / 1000)}s)`);
    return;
  }

  if (m.text.length > MAX_MSG_LEN) {
    await reply(m.chat.id, `Message too long (${m.text.length} chars, max ${MAX_MSG_LEN}).`);
    return;
  }

  if (rateLimited(m.from.id)) {
    // Notify once per limit window at most — the (RATE_LIMIT+1)th message.
    const times = msgTimes.get(m.from.id)!;
    if (times.length === RATE_LIMIT + 1) await reply(m.chat.id, "Rate limited — slow down a little.");
    return;
  }

  try {
    await handleText(m.chat.id, m.text);
  } catch (e) {
    console.error(`ERROR: telegram handler: ${(e as Error).message}`);
    await reply(m.chat.id, "Something went wrong handling that — check the add-on logs.").catch(() => {});
  }
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

export function startTelegramBot(): void {
  if (!cfg.telegramToken) {
    console.log("INFO: Telegram bot disabled (no telegram_bot_token configured).");
    return;
  }
  if (cfg.telegramAllowedIds.length === 0) {
    console.error(
      "ERROR: telegram_bot_token is set but telegram_allowed_user_ids is empty. " +
        "Refusing to start the bot without an allowlist (fail closed). " +
        "Add your numeric Telegram user ID in the add-on configuration.",
    );
    return;
  }

  (async () => {
    const startupTime = Date.now();
    let backoffMs = 1000;

    // Ensure polling mode; keep any queued updates (offset + age check filter them).
    try {
      await tg("deleteWebhook", { drop_pending_updates: false });
      const me = await tg("getMe", {}) as { username: string };
      console.log(
        `INFO: Telegram bot @${me.username} polling; allowlist: ${cfg.telegramAllowedIds.length} user id(s).`,
      );
    } catch (e) {
      console.error(`ERROR: Telegram startup failed (bad token?): ${(e as Error).message}`);
      return;
    }

    let offset = (await getState<number>(OFFSET_KEY)) ?? 0;

    while (true) {
      try {
        const updates = await tg("getUpdates", {
          offset,
          timeout: POLL_TIMEOUT_S,
          allowed_updates: ["message"],
        }, (POLL_TIMEOUT_S + 15) * 1000) as TgUpdate[];

        for (const u of updates) {
          offset = u.update_id + 1;
          await handleUpdate(u, startupTime);
        }
        if (updates.length > 0) await setState(OFFSET_KEY, offset);
        backoffMs = 1000;
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.includes("409")) {
          // Another poller holds this token — do not fight it.
          console.error("ERROR: Telegram 409 conflict (token in use elsewhere). Pausing 5 minutes.");
          await new Promise((r) => setTimeout(r, 300_000));
        } else {
          console.log(`WARN: telegram poll error, retrying in ${backoffMs / 1000}s: ${msg}`);
          await new Promise((r) => setTimeout(r, backoffMs));
          backoffMs = Math.min(backoffMs * 2, 60_000);
        }
      }
    }
  })();
}
