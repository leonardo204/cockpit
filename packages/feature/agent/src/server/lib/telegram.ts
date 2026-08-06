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
// CONFIG: a bot token + a chat id. naby is a SEPARATE product from the dotclaude
// messenger — it uses its OWN dedicated bot (create one with @BotFather), NOT the
// dotclaude bot. naby stores its own config (store settings, keys below); the
// chat id can be auto-detected (detectChatId) after the user messages the naby
// bot, so setup stays one-step without coupling to any other tool. No secret is
// ever logged; the token is redacted when the config is read back for the UI.
//
// The pure helpers (keyboard build, callback/text parse) are unit-tested; the IO
// functions are thin wrappers over the Telegram Bot API and verified live.

import { logActivity } from '../../../../../../../dist/naby-runtime.mjs';
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

// -- pure message helpers (unit-tested) -------------------------------------

/** Telegram's hard limit on callback_data. A button whose data exceeds it makes
 *  the whole sendMessage fail, so nothing may be embedded here that can grow. */
export const CALLBACK_DATA_MAX_BYTES = 64;

/**
 * Callback data for an approval button: `nbapv:<decision>:<ref>`.
 *
 * `ref` is a SHORT OPAQUE TOKEN, not the approvalId. The first version embedded
 * the id (`<sessionId>:<toolCallId>`) directly, on the assumption it would fit —
 * and measured, it does not: with an Agent-SDK UUID session id the data reaches 78
 * bytes and Telegram rejects the send outright, so the buttons never appear and
 * the escalation silently degrades to "answer in the app". The caller now mints a
 * short ref and keeps the mapping, which is bounded by construction.
 */
export function buildCallbackData(decision: 'allow' | 'deny', ref: string): string {
  return `nbapv:${decision}:${ref}`;
}

/** Parse an approval callback_data back into its decision + ref, or undefined when
 *  it is not one of ours. */
export function parseCallbackData(
  data: string | undefined,
): { decision: 'allow' | 'deny'; ref: string } | undefined {
  if (!data) return undefined;
  const m = data.match(/^nbapv:(allow|deny):(.+)$/);
  if (!m) return undefined;
  return { decision: m[1] as 'allow' | 'deny', ref: m[2]! };
}

/** Callback data for a check-in option button: `nbchk:<index>:<ref>`. The index is
 *  0-based into the options as they were shown. */
export function buildCheckinCallbackData(index: number, ref: string): string {
  return `nbchk:${index}:${ref}`;
}

/** Parse a check-in callback_data, or undefined when it is not one of ours. */
export function parseCheckinCallbackData(
  data: string | undefined,
): { chosen: number; ref: string } | undefined {
  if (!data) return undefined;
  const m = data.match(/^nbchk:(\d{1,2}):(.+)$/);
  if (!m) return undefined;
  return { chosen: Number(m[1]), ref: m[2]! };
}

/** An inline keyboard with Approve / Deny buttons carrying an approval's
 *  callback data — the bidirectional escalation control. */
export function buildApprovalKeyboard(ref: string): {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
} {
  return {
    inline_keyboard: [
      [
        { text: '✅ Approve', callback_data: buildCallbackData('allow', ref) },
        { text: '❌ Deny', callback_data: buildCallbackData('deny', ref) },
      ],
    ],
  };
}

/** Buttons for a check-in's options, numbered so a phone screen stays readable
 *  and a bare "2" reply means the same thing as tapping. Two per row: the option
 *  labels are sentences, and three across truncates them to uselessness. */
export function buildCheckinKeyboard(
  ref: string,
  optionCount: number,
): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < optionCount; i += 2) {
    const row = [{ text: `${i + 1}`, callback_data: buildCheckinCallbackData(i, ref) }];
    if (i + 1 < optionCount) {
      row.push({ text: `${i + 2}`, callback_data: buildCheckinCallbackData(i + 1, ref) });
    }
    rows.push(row);
  }
  return { inline_keyboard: rows };
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

/** Classify a free-text reply as a check-in OPTION NUMBER (1-based on screen,
 *  0-based here), or undefined when it is not a plain number in range.
 *
 *  Deliberately strict: only a bare number counts. Accepting "the first one" or
 *  "b" would mean guessing at a decision the whole check-in exists because the
 *  agent could not guess — and a wrong guess here is recorded as the user's own
 *  answer, which is worse than not understanding the reply. */
export function classifyNumericReply(text: string | undefined, optionCount: number): number | undefined {
  if (!text) return undefined;
  const m = text.trim().match(/^([1-9]\d?)[.)]?$/);
  if (!m) return undefined;
  const n = Number(m[1]);
  return n >= 1 && n <= optionCount ? n - 1 : undefined;
}

// -- Telegram Bot API IO (thin wrappers) ------------------------------------

const API_BASE = 'https://api.telegram.org';

/**
 * Turn a thrown fetch rejection into a message a HUMAN can act on.
 *
 * `fetch` reports EVERY transport failure as the same five words — `TypeError:
 * fetch failed` — and hides what actually happened one level down in `cause`.
 * Surfaced verbatim in the Settings dialog, those five words read as "naby is
 * broken" or "my token is wrong", and that is exactly how a network fault
 * (Happy Eyeballs abandoning a slow-but-live IPv4 attempt at its 250ms default;
 * see the timeout raised in shell/server.mjs and electron/boot.ts) was
 * misdiagnosed for a whole debugging session as a Telegram config error.
 *
 * So the code comes along: `fetch failed (ETIMEDOUT)`. ENOTFOUND is DNS,
 * ECONNREFUSED is a blocked egress, ETIMEDOUT/EHOSTUNREACH is the network —
 * none of them are a reason to go re-type a bot token.
 *
 * The cause chain is walked because Node wraps differently per failure mode: a
 * single-address failure carries the coded error directly, while a multi-address
 * one arrives as an AggregateError whose `errors[]` hold the codes.
 */
export function describeFetchError(e: unknown): string {
  const base = e instanceof Error ? e.message : String(e);
  const code = findErrorCode(e, 0);
  return code ? `${base} (${code})` : base;
}

function findErrorCode(e: unknown, depth: number): string | undefined {
  if (depth > 4 || e === null || typeof e !== 'object') return undefined;
  const err = e as { code?: unknown; cause?: unknown; errors?: unknown };
  if (typeof err.code === 'string' && err.code) return err.code;
  if (Array.isArray(err.errors)) {
    for (const inner of err.errors) {
      const found = findErrorCode(inner, depth + 1);
      if (found) return found;
    }
  }
  return findErrorCode(err.cause, depth + 1);
}

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
      const error = json?.description ?? `telegram sendMessage failed (${res.status})`;
      logTelegramOut(cfg, text, opts, { ok: false, error });
      return { ok: false, error };
    }
    const messageId = json.result?.message_id ?? 0;
    logTelegramOut(cfg, text, opts, { ok: true, messageId });
    return { ok: true, messageId };
  } catch (e) {
    const error = describeFetchError(e);
    logTelegramOut(cfg, text, opts, { ok: false, error });
    return { ok: false, error };
  }
}

/**
 * EVERY OUTBOUND MESSAGE, logged at the transport (naby-activity-log §3).
 *
 * Here rather than at the callers because there are six of them — a chat reply,
 * an approval escalation, a check-in, the two "answered" confirmations, the final
 * report — and one that forgot would be a message the user received with nothing
 * on record. The trade is that this line says WHAT was sent and not WHY; the why
 * is the `escalation` record its caller writes.
 *
 * THE BOT TOKEN IS NEVER PART OF IT. `cfg` carries one and only `chatId` is read;
 * the log module's masker is a safety net here, not the primary defence.
 */
function logTelegramOut(
  cfg: Pick<TelegramConfig, 'botToken' | 'chatId'>,
  text: string,
  opts: { replyMarkup?: unknown; signal?: AbortSignal } | undefined,
  outcome: { ok: true; messageId: number } | { ok: false; error: string },
): void {
  logActivity('telegram_out', {
    chatId: String(cfg.chatId),
    text,
    hasButtons: opts?.replyMarkup !== undefined,
    ok: outcome.ok,
    ...(outcome.ok ? { messageId: outcome.messageId } : { error: outcome.error }),
  });
}

/** The outcome of one getUpdates poll. `error` is present ONLY when the poll did
 *  not complete — a transport failure or an API-level refusal. It is additive on
 *  purpose: the listener loop can keep ignoring it and retry, while the callers
 *  that must not report "nothing arrived" when the truth is "we never asked"
 *  (detectChatId) can tell the two apart. */
export type TelegramPollResult = {
  updates: TelegramUpdate[];
  nextOffset: number;
  /** Set when the poll FAILED. Absent means "the poll ran"; `updates` being
   *  empty then genuinely means no update was waiting. */
  error?: string;
};

/** One long-poll of getUpdates from `offset`. Returns the raw updates and the
 *  next offset to pass. Never throws — a failure yields [] and the SAME offset
 *  so the caller simply retries, plus an `error` so a caller that cares can see
 *  that the emptiness is a failure rather than an answer. */
export async function pollTelegramUpdates(
  cfg: Pick<TelegramConfig, 'botToken'>,
  offset: number,
  opts?: { timeoutSec?: number; signal?: AbortSignal },
): Promise<TelegramPollResult> {
  try {
    const url = new URL(`${API_BASE}/bot${cfg.botToken}/getUpdates`);
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('timeout', String(opts?.timeoutSec ?? 25));
    url.searchParams.set('allowed_updates', JSON.stringify(['message', 'callback_query']));
    const res = await fetch(url, opts?.signal ? { signal: opts.signal } : {});
    const json = (await res.json().catch(() => null)) as
      | { ok: boolean; result?: TelegramUpdate[]; description?: string }
      | null;
    if (!res.ok || !json?.ok || !json.result) {
      return {
        updates: [],
        nextOffset: offset,
        error: json?.description ?? `telegram getUpdates failed (${res.status})`,
      };
    }
    const updates = json.result;
    const maxId = updates.reduce((mx, u) => Math.max(mx, u.update_id), offset - 1);
    return { updates, nextOffset: maxId + 1 };
  } catch (e) {
    return { updates: [], nextOffset: offset, error: describeFetchError(e) };
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

/**
 * Publish the bot's command menu (`/sessions`, `/use`, …) so Telegram
 * autocompletes them in the input box.
 *
 * DISCOVERABILITY IS THE WHOLE POINT (telegram-chat §2): the alternative to a
 * command menu is the user remembering a syntax nobody wrote down, which is how
 * a control surface goes unused. It is also why this is best-effort — the
 * commands WORK whether or not the menu registered, so a failure is logged and
 * never propagated to the caller that was doing something else (saving settings,
 * starting the loop).
 */
export async function setMyCommands(
  cfg: Pick<TelegramConfig, 'botToken'>,
  commands: ReadonlyArray<{ command: string; description: string }>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${API_BASE}/bot${cfg.botToken}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands }),
    });
    const json = (await res.json().catch(() => null)) as
      | { ok: boolean; description?: string }
      | null;
    if (!res.ok || !json?.ok) {
      return { ok: false, error: json?.description ?? `telegram setMyCommands failed (${res.status})` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: describeFetchError(e) };
  }
}

/** Discover the chat id to send to by reading the most recent update from the
 *  bot — the naby-native, dotclaude-free way to finish setup: the user messages
 *  their naby bot once, then this returns the chat id to save. Needs only the
 *  token. Returns an error string when no message is waiting. */
export async function detectChatId(
  cfg: Pick<TelegramConfig, 'botToken'>,
): Promise<{ ok: true; chatId: string } | { ok: false; error: string }> {
  if (!cfg.botToken) return { ok: false, error: 'Set the bot token first.' };
  const { updates, error } = await pollTelegramUpdates(cfg, 0, { timeoutSec: 0 });
  // A FAILED poll is not an empty inbox. Reporting "no message found" when the
  // request never reached Telegram sends the user off to re-send a message they
  // already sent — the one instruction guaranteed not to help — and hides the
  // network fault that is the actual cause.
  if (error) {
    return { ok: false, error: `Could not reach Telegram: ${error}` };
  }
  for (let i = updates.length - 1; i >= 0; i -= 1) {
    const u = updates[i]!;
    const id = u.message?.chat?.id ?? u.callback_query?.message?.chat?.id;
    if (id != null) return { ok: true, chatId: String(id) };
  }
  return {
    ok: false,
    error: 'No message found. Send any message to your naby bot in Telegram, then try again.',
  };
}

export type TelegramUpdate = {
  update_id: number;
  message?: {
    /** The incoming message's own id. */
    message_id?: number;
    chat?: { id: number };
    text?: string;
    /**
     * The bot message this one is a REPLY to (telegram-chat §1.3). Carries the
     * routing: a reply to an answer goes back to the session that produced it,
     * whatever the chat is currently linked to.
     */
    reply_to_message?: { message_id?: number };
    /** Present when the user sent a photo/document instead of text — answered
     *  with "text only" rather than silence. */
    photo?: unknown[];
    document?: unknown;
  };
  callback_query?: {
    id: string;
    data?: string;
    message?: { chat?: { id: number } };
    from?: { id: number };
  };
};
