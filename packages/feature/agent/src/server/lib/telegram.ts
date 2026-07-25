// packages/feature/agent/src/server/lib/telegram.ts
//
// THE TELEGRAM CHANNEL (Phase 3, P3-M3).
//
// naby's persona agent escalates a critical decision — and reports when it is
// done — OUT OF BAND, over Telegram, so the user can be away from the app and
// still stay in the loop. This module is that channel: it SENDS a message (with
// optional inline Approve/Deny buttons) and RECEIVES the user's answer (a button
// press or a text reply), which the escalation bridge maps back onto the paused
// approval (approvalRegistry), resolving the same turn the in-app prompt would.
//
// CONFIG: a bot token + a chat id. naby stores its OWN (store settings, keys
// below) but PRE-FILLS them once from the dotclaude messenger the user already
// has (~/.claude/messenger.json) so it works with zero setup on this machine and
// stays portable off it. No secret is ever logged; the token is redacted when
// the config is read back for the UI.
//
// The pure helpers (keyboard build, callback/text parse) are unit-tested; the IO
// functions are thin wrappers over the Telegram Bot API and verified live.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import type { Store } from '../../../../../../../dist/naby-runtime.mjs';

// -- settings keys (in the naby store) --------------------------------------

export const TELEGRAM_ENABLED_KEY = 'telegram.enabled';
export const TELEGRAM_TOKEN_KEY = 'telegram.botToken';
export const TELEGRAM_CHAT_KEY = 'telegram.chatId';

export type TelegramConfig = {
  enabled: boolean;
  botToken: string;
  chatId: string;
};

/** Read naby's Telegram config from the store. Missing = empty/disabled. */
export function readTelegramConfig(store: Store): TelegramConfig {
  return {
    enabled: (store.getSetting(TELEGRAM_ENABLED_KEY) ?? 'false') === 'true',
    botToken: store.getSetting(TELEGRAM_TOKEN_KEY) ?? '',
    chatId: store.getSetting(TELEGRAM_CHAT_KEY) ?? '',
  };
}

/** Persist naby's Telegram config. Only the provided fields are written. */
export function writeTelegramConfig(store: Store, patch: Partial<TelegramConfig>): void {
  if (patch.enabled !== undefined) store.setSetting(TELEGRAM_ENABLED_KEY, patch.enabled ? 'true' : 'false');
  if (patch.botToken !== undefined) store.setSetting(TELEGRAM_TOKEN_KEY, patch.botToken.trim());
  if (patch.chatId !== undefined) store.setSetting(TELEGRAM_CHAT_KEY, patch.chatId.trim());
}

/** True when the config can actually send (enabled + both credentials present). */
export function isTelegramReady(cfg: TelegramConfig): boolean {
  return cfg.enabled && cfg.botToken.length > 0 && cfg.chatId.length > 0;
}

/** Show a token as `1234…AAE1` — enough to recognize, never the secret. Empty
 *  stays empty so the UI can show a "not set" state. */
export function redactToken(token: string): string {
  if (!token) return '';
  if (token.length <= 8) return '••••';
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

// -- dotclaude messenger pre-fill -------------------------------------------

/** The dotclaude messenger config the user may already have. We READ it only to
 *  pre-fill naby's own settings once (never write it). */
export function readDotclaudeMessengerConfig(): { botToken: string; chatId: string } | undefined {
  try {
    const path = join(homedir(), '.claude', 'messenger.json');
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      bot_token?: string;
      chat_id?: string | number;
    };
    const botToken = (raw.bot_token ?? '').trim();
    const chatId = String(raw.chat_id ?? '').trim();
    if (!botToken || !chatId) return undefined;
    return { botToken, chatId };
  } catch {
    return undefined; // absent / unreadable — nothing to pre-fill
  }
}

/** IDEMPOTENT one-time pre-fill: if naby has no Telegram token yet and a
 *  dotclaude messenger config exists, seed naby's settings from it (disabled by
 *  default — the user opts in). Never overwrites an existing naby token. Returns
 *  whether it seeded. */
export function seedTelegramFromDotclaude(store: Store): boolean {
  const current = readTelegramConfig(store);
  if (current.botToken) return false; // already configured — leave it
  const imported = readDotclaudeMessengerConfig();
  if (!imported) return false;
  writeTelegramConfig(store, {
    botToken: imported.botToken,
    chatId: imported.chatId,
    // Seeded but OFF: escalation is a deliberate opt-in, not an ambient default.
    enabled: false,
  });
  return true;
}

// -- pure message helpers (unit-tested) -------------------------------------

/** Callback data for an approval button. Telegram caps callback_data at 64
 *  bytes, so the approvalId (`<sessionId>:<toolCallId>`) must fit — it does
 *  (uuid-ish + short id). Format: `nbapv:<decision>:<approvalId>`. */
export function buildCallbackData(decision: 'allow' | 'deny', approvalId: string): string {
  return `nbapv:${decision}:${approvalId}`;
}

/** Parse an approval callback_data back into its decision + approvalId, or
 *  undefined when it is not one of ours. */
export function parseCallbackData(
  data: string | undefined,
): { decision: 'allow' | 'deny'; approvalId: string } | undefined {
  if (!data) return undefined;
  const m = data.match(/^nbapv:(allow|deny):(.+)$/);
  if (!m) return undefined;
  return { decision: m[1] as 'allow' | 'deny', approvalId: m[2]! };
}

/** An inline keyboard with Approve / Deny buttons carrying an approval's
 *  callback data — the bidirectional escalation control. */
export function buildApprovalKeyboard(approvalId: string): {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
} {
  return {
    inline_keyboard: [
      [
        { text: '✅ Approve', callback_data: buildCallbackData('allow', approvalId) },
        { text: '❌ Deny', callback_data: buildCallbackData('deny', approvalId) },
      ],
    ],
  };
}

/** Classify a free-text reply as approve / deny, or undefined when ambiguous.
 *  Matches on the FIRST token so it is Unicode-safe (ASCII `\b` does not fire on
 *  Korean). Supports EN + KO affirmations so a plain "yes"/"승인"/"ok" reply also
 *  works when the user does not tap a button. */
const REPLY_ALLOW = new Set([
  'y', 'yes', 'ok', 'okay', 'approve', 'allow', 'go', 'sure',
  '승인', '허용', '네', '예', '응', 'ㅇㅇ', '진행', '해', '해줘', '좋아',
]);
const REPLY_DENY = new Set([
  'n', 'no', 'nope', 'deny', 'block', 'stop', 'reject', 'cancel',
  '거부', '차단', '아니', '아니오', '안돼', '멈춰', '중지', '하지마', 'ㄴㄴ',
]);
export function classifyTextReply(text: string | undefined): 'allow' | 'deny' | undefined {
  if (!text) return undefined;
  const first = text.trim().toLowerCase().split(/[\s,.!?]+/)[0] ?? '';
  if (REPLY_ALLOW.has(first)) return 'allow';
  if (REPLY_DENY.has(first)) return 'deny';
  return undefined;
}

// -- Telegram Bot API IO (thin wrappers) ------------------------------------

const API_BASE = 'https://api.telegram.org';

/** Send a message to the configured chat, optionally with an inline keyboard.
 *  Returns the sent message_id on success, or an error string. Never throws. */
export async function sendTelegramMessage(
  cfg: Pick<TelegramConfig, 'botToken' | 'chatId'>,
  text: string,
  opts?: { replyMarkup?: unknown; signal?: AbortSignal },
): Promise<{ ok: true; messageId: number } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${API_BASE}/bot${cfg.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: cfg.chatId,
        text,
        ...(opts?.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
      }),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
    const json = (await res.json().catch(() => null)) as
      | { ok: boolean; result?: { message_id: number }; description?: string }
      | null;
    if (!res.ok || !json?.ok) {
      return { ok: false, error: json?.description ?? `telegram sendMessage failed (${res.status})` };
    }
    return { ok: true, messageId: json.result?.message_id ?? 0 };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** One long-poll of getUpdates from `offset`. Returns the raw updates and the
 *  next offset to pass. Never throws — a transient failure yields [] and the
 *  same offset so the caller simply retries. */
export async function pollTelegramUpdates(
  cfg: Pick<TelegramConfig, 'botToken'>,
  offset: number,
  opts?: { timeoutSec?: number; signal?: AbortSignal },
): Promise<{ updates: TelegramUpdate[]; nextOffset: number }> {
  try {
    const url = new URL(`${API_BASE}/bot${cfg.botToken}/getUpdates`);
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('timeout', String(opts?.timeoutSec ?? 25));
    url.searchParams.set('allowed_updates', JSON.stringify(['message', 'callback_query']));
    const res = await fetch(url, opts?.signal ? { signal: opts.signal } : {});
    const json = (await res.json().catch(() => null)) as
      | { ok: boolean; result?: TelegramUpdate[] }
      | null;
    if (!res.ok || !json?.ok || !json.result) return { updates: [], nextOffset: offset };
    const updates = json.result;
    const maxId = updates.reduce((mx, u) => Math.max(mx, u.update_id), offset - 1);
    return { updates, nextOffset: maxId + 1 };
  } catch {
    return { updates: [], nextOffset: offset };
  }
}

/** Acknowledge a callback query so Telegram stops the button's spinner. */
export async function answerCallbackQuery(
  cfg: Pick<TelegramConfig, 'botToken'>,
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  try {
    await fetch(`${API_BASE}/bot${cfg.botToken}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, ...(text ? { text } : {}) }),
    });
  } catch {
    /* best-effort — the decision is already recorded */
  }
}

export type TelegramUpdate = {
  update_id: number;
  message?: { chat?: { id: number }; text?: string };
  callback_query?: {
    id: string;
    data?: string;
    message?: { chat?: { id: number } };
    from?: { id: number };
  };
};
