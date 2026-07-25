// packages/feature/agent/src/server/lib/telegramEscalation.ts
//
// THE ESCALATION BRIDGE (Phase 3, P3-M3b).
//
// M3a built the channel (send / poll / parse — lib/telegram.ts). This module is
// the BRIDGE that puts the channel in the loop of a real turn:
//
//   1. An agent whose `autonomy.escalation` is 'telegram' or 'both' hits an 'ask'
//      rule. The turn suspends on the M2 approval promise as always, the in-app
//      prompt is emitted as always — AND the question also goes out over Telegram
//      with inline ✅/❌ buttons (`escalateApproval`).
//   2. A short-lived polling loop (`getUpdates`) runs while — and only while — at
//      least one escalated approval is pending. A button press or a plain
//      "yes"/"승인" reply is mapped back onto the SAME approvalId and settled
//      through `resolveApproval`, so the remote answer resumes the paused turn
//      exactly as the in-app button would (one registry, two front-ends).
//   3. When the turn ends, the agent reports the outcome back to the chat
//      (`sendFinalReport`) — the user who answered from their phone learns how it
//      turned out without opening the app.
//
// WHY THE LOOP IS REFERENCE-COUNTED, NOT ALWAYS-ON. Telegram allows exactly ONE
// in-flight `getUpdates` per bot: a permanently running long-poll would make the
// Settings "Detect" button (which also calls getUpdates) fail with 409, and would
// hold a socket open forever for a feature that is idle most of the time. So the
// loop starts on the first pending escalation and exits as soon as the last one is
// settled. Pending approvals are the only thing it exists to serve.
//
// WHY THE OFFSET IS PERSISTED. `getUpdates` replays every unconfirmed update. A
// stale "yes" typed hours ago must never resolve the NEXT approval, so the offset
// (the update_id watermark) is stored, and a freshly started loop first DRAINS
// whatever is waiting before it starts listening. Combined with the watch map —
// only an approvalId we are actually waiting on is honoured — a replay is inert.
//
// Cross-realm safety: the state lives on `globalThis`, the same idiom (and for the
// same Next.js bundling reason) as approvalRegistry — the paused turn and the
// polling loop must see ONE watch map even if their modules are bundled twice.

import type { GateDecision, Store } from '../../../../../../../dist/naby-runtime.mjs';
import { resolveApproval } from './approvalRegistry';
import {
  answerCallbackQuery,
  buildApprovalKeyboard,
  classifyTextReply,
  isTelegramReady,
  parseCallbackData,
  pollTelegramUpdates,
  readTelegramConfig,
  sendTelegramMessage,
  type TelegramConfig,
  type TelegramUpdate,
} from './telegram';

/** Store setting holding the getUpdates watermark (see the header note). */
export const TELEGRAM_OFFSET_KEY = 'telegram.updateOffset';

/** Long-poll window. Telegram holds the request open this long when idle, so the
 *  loop costs one socket and no polling churn. */
const POLL_TIMEOUT_SEC = 25;

/** Floor between iterations. A long-poll that fails (offline, 409) returns at
 *  once; without this the loop would spin hot on a network error. */
const MIN_ITERATION_MS = 2000;

/** How much of a tool's input is quoted in the escalation message. Enough to
 *  judge the call ("rm -rf …"), never a wall of JSON on a phone screen. */
const INPUT_PREVIEW_CHARS = 400;

/** How much of the answer the final report quotes. */
const REPORT_PREVIEW_CHARS = 1200;

// -- pure formatting / interpretation (unit-tested) ---------------------------

/** Shorten to `max` chars with an ellipsis, so a preview never dominates a
 *  message. Returns the input untouched when it already fits. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

/** The escalation message: who is asking, what they want to run, and what the
 *  buttons mean. Plain text (no Markdown) — a tool input can contain any
 *  characters, and an unescaped `_`/`*` would make Telegram reject the send. */
export function formatApprovalMessage(opts: {
  toolName: string;
  input?: unknown;
  agentName?: string;
  cwd?: string;
}): string {
  const who = opts.agentName ? `@${opts.agentName}` : 'naby';
  const lines = [`🔐 ${who} needs approval`, '', `Tool: ${opts.toolName}`];
  if (opts.cwd) lines.push(`Dir: ${opts.cwd}`);
  const input = formatInputPreview(opts.input);
  if (input) lines.push('', input);
  lines.push('', 'Approve or deny below (or reply yes / no).');
  return lines.join('\n');
}

/** One-line-ish preview of a tool input. A string input is shown as-is; an object
 *  is compact JSON. Undefined/empty yields '' so the caller omits the block. */
function formatInputPreview(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input.trim() ? truncate(input.trim(), INPUT_PREVIEW_CHARS) : '';
  try {
    const json = JSON.stringify(input);
    if (!json || json === '{}' || json === 'null') return '';
    return truncate(json, INPUT_PREVIEW_CHARS);
  } catch {
    return '';
  }
}

/** The end-of-turn report — the other half of "the user can be away". Says
 *  whether the turn succeeded and quotes the answer (or the error).
 *
 *  P3-M3c: for an AUTONOMOUS run it also reports the step spend and why the loop
 *  ended, because "finished in 2/5 steps" and "ran out at 5/5" are very different
 *  outcomes to read on a phone. */
export type FinalReport = {
  ok: boolean;
  text?: string;
  error?: string;
  agentName?: string;
  durationMs?: number;
  numTurns?: number;
  /** Autonomous steps actually taken (omit for a single-turn run). */
  steps?: number;
  /** The step budget those steps came out of. */
  stepsMax?: number;
  /** Why the autonomy loop stopped (`AutonomyDecision.reason`). */
  stopReason?: string;
};

export function formatFinalReport(opts: FinalReport): string {
  const who = opts.agentName ? `@${opts.agentName}` : 'naby';
  const head = opts.ok ? `✅ ${who} finished` : `⚠️ ${who} stopped`;
  const meta: string[] = [];
  if (opts.durationMs != null) meta.push(`${Math.round(opts.durationMs / 1000)}s`);
  if (opts.steps != null) {
    meta.push(opts.stepsMax != null ? `${opts.steps}/${opts.stepsMax} steps` : `${opts.steps} steps`);
    if (opts.stopReason && opts.stopReason !== 'done-marker') meta.push(opts.stopReason);
  }
  if (opts.numTurns != null) meta.push(`${opts.numTurns} turns`);
  const lines = [meta.length > 0 ? `${head} (${meta.join(', ')})` : head];
  const body = opts.ok ? (opts.text ?? '').trim() : (opts.error ?? '').trim();
  if (body) lines.push('', truncate(body, REPORT_PREVIEW_CHARS));
  return lines.join('\n');
}

/** What an incoming update MEANS to this bridge — the whole dispatch decision as
 *  a pure function, so the loop below is only IO.
 *
 *  * `callback`  — one of our inline buttons was pressed. `watched` says whether
 *    the approval is still pending: an unwatched one is still ACKNOWLEDGED (so
 *    Telegram stops the button spinner) but resolves nothing.
 *  * `text`      — a free-text yes/no. It carries no approvalId, so the caller
 *    applies it to the newest pending approval (`pickTextReplyTarget`).
 *  * undefined   — anything else (chatter, a foreign callback, an ambiguous
 *    reply): ignored on purpose, never guessed at. */
export function interpretUpdate(
  update: TelegramUpdate,
  isWatched: (approvalId: string) => boolean,
):
  | { kind: 'callback'; callbackQueryId: string; approvalId: string; decision: 'allow' | 'deny'; watched: boolean }
  | { kind: 'text'; decision: 'allow' | 'deny' }
  | undefined {
  if (update.callback_query) {
    const parsed = parseCallbackData(update.callback_query.data);
    if (!parsed) return undefined;
    return {
      kind: 'callback',
      callbackQueryId: update.callback_query.id,
      approvalId: parsed.approvalId,
      decision: parsed.decision,
      watched: isWatched(parsed.approvalId),
    };
  }
  const decision = classifyTextReply(update.message?.text);
  return decision ? { kind: 'text', decision } : undefined;
}

/** Which pending approval a bare "yes" answers: the most recently escalated one —
 *  the message the user is looking at. Undefined when nothing is pending, so an
 *  unsolicited "yes" resolves nothing. */
export function pickTextReplyTarget<T extends { approvalId: string; escalatedAt: number }>(
  watching: Iterable<T>,
): T | undefined {
  let best: T | undefined;
  for (const w of watching) {
    if (!best || w.escalatedAt > best.escalatedAt) best = w;
  }
  return best;
}

/** The decision, as the gate's `GateDecision`, with a reason that names Telegram
 *  as the source — so the transcript and the tool_result say where it came from. */
export function telegramDecision(decision: 'allow' | 'deny'): GateDecision {
  return decision === 'allow'
    ? { behavior: 'allow' }
    : { behavior: 'deny', reason: 'you denied this tool call from Telegram' };
}

// -- the shared state (globalThis-pinned, see header) -------------------------

type Watched = {
  approvalId: string;
  toolName: string;
  /** caller's clock — this module never reads the time itself. */
  escalatedAt: number;
};

type BridgeState = {
  watching: Map<string, Watched>;
  offset: number;
  /** whether the loop already drained the pre-existing backlog this process. */
  drained: boolean;
  loopRunning: boolean;
};

const g = globalThis as unknown as { __nabyTelegramBridge?: BridgeState };
const state: BridgeState =
  g.__nabyTelegramBridge ??
  (g.__nabyTelegramBridge = { watching: new Map(), offset: 0, drained: false, loopRunning: false });

/** Test/diagnostic view of what the bridge is waiting on. */
export function pendingEscalations(): Watched[] {
  return [...state.watching.values()];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function readOffset(store: Store): number {
  const n = Number(store.getSetting(TELEGRAM_OFFSET_KEY) ?? '0');
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function writeOffset(store: Store, offset: number): void {
  try {
    store.setSetting(TELEGRAM_OFFSET_KEY, String(offset));
  } catch {
    /* best-effort — an unpersisted watermark only risks a replay, which the
       watch map makes inert */
  }
}

// -- send + watch -------------------------------------------------------------

/** Escalate a pending approval to Telegram: send the question with ✅/❌ buttons
 *  and start watching for the answer. Fire-and-forget by design — the in-app
 *  prompt is already up, so a Telegram failure must degrade to "answer in the
 *  app", never break or delay the turn. Never throws. */
export async function escalateApproval(opts: {
  store: Store;
  approvalId: string;
  toolName: string;
  input?: unknown;
  agentName?: string;
  cwd?: string;
  /** caller's clock (this module keeps no clock of its own). */
  now: number;
}): Promise<void> {
  const cfg = readTelegramConfig(opts.store);
  if (!isTelegramReady(cfg)) {
    console.log(
      `[telegram] escalation skipped for ${opts.toolName}: Telegram not configured — answer in the app`,
    );
    return;
  }
  // Watch BEFORE sending: the answer can arrive between the send returning and
  // this line, and an unwatched approvalId would be dropped.
  state.watching.set(opts.approvalId, {
    approvalId: opts.approvalId,
    toolName: opts.toolName,
    escalatedAt: opts.now,
  });
  ensureListener(opts.store);
  const sent = await sendTelegramMessage(
    cfg,
    formatApprovalMessage({
      toolName: opts.toolName,
      input: opts.input,
      ...(opts.agentName ? { agentName: opts.agentName } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    }),
    { replyMarkup: buildApprovalKeyboard(opts.approvalId) },
  );
  if (!sent.ok) {
    // Could not ask remotely — stop watching so the loop can exit; the in-app
    // prompt (and the TTL) still governs this approval.
    state.watching.delete(opts.approvalId);
    console.warn(`[telegram] escalation send failed: ${sent.error}`);
    return;
  }
  console.log(`[telegram] escalated ${opts.toolName} (${opts.approvalId})`);
}

/** The approval was settled by someone OTHER than Telegram (the in-app prompt, a
 *  turn abort, or the TTL). Stop watching and tell the chat, so the buttons still
 *  sitting in the user's phone are not the last word they see.
 *
 *  A no-op when the id is not being watched — which is exactly the case when the
 *  loop itself resolved it (it unwatches first and confirms in-chat), so the two
 *  paths never double-report. */
export async function finishEscalation(opts: {
  store: Store;
  approvalId: string;
  decision: 'allow' | 'deny';
  reason?: string;
}): Promise<void> {
  const watched = state.watching.get(opts.approvalId);
  if (!watched) return;
  state.watching.delete(opts.approvalId);
  const cfg = readTelegramConfig(opts.store);
  if (!isTelegramReady(cfg)) return;
  const mark = opts.decision === 'allow' ? '✅ Approved' : '❌ Denied';
  // The reason (a policy deny, an abort, the TTL) is the informative part when
  // there is one; without one the decision came from the in-app buttons.
  const detail = opts.reason ? ` — ${opts.reason}` : ' — answered in the app';
  await sendTelegramMessage(cfg, `${mark}: ${watched.toolName}${detail}`);
}

/** Report a finished turn to the chat (the second half of escalation). Awaited by
 *  the engine so the report is actually out before the turn's work ends. */
export async function sendFinalReport(store: Store, report: FinalReport): Promise<void> {
  const cfg = readTelegramConfig(store);
  if (!isTelegramReady(cfg)) return;
  const sent = await sendTelegramMessage(cfg, formatFinalReport(report));
  if (!sent.ok) console.warn(`[telegram] final report failed: ${sent.error}`);
}

// -- the polling loop ---------------------------------------------------------

/** Start the loop if it is not already running. Idempotent and synchronous: the
 *  caller (a paused turn) must not wait on a long-poll. */
export function ensureListener(store: Store): void {
  if (state.loopRunning) return;
  state.loopRunning = true;
  void runListener(store).finally(() => {
    state.loopRunning = false;
    // A watch added during the shutdown window would otherwise be stranded, so
    // hand it to a fresh loop.
    if (state.watching.size > 0) ensureListener(store);
  });
}

async function runListener(store: Store): Promise<void> {
  const cfg = readTelegramConfig(store);
  if (!isTelegramReady(cfg)) return;
  if (state.offset === 0) state.offset = readOffset(store);
  // Skip the backlog once per process: whatever is already waiting was typed
  // before this escalation existed and must not answer it.
  if (!state.drained) {
    state.drained = true;
    const { updates, nextOffset } = await pollTelegramUpdates(cfg, state.offset, { timeoutSec: 0 });
    if (nextOffset !== state.offset) {
      console.log(`[telegram] dropped ${updates.length} stale update(s) before listening`);
      state.offset = nextOffset;
      writeOffset(store, nextOffset);
    }
  }
  console.log(`[telegram] listening for approvals (offset ${state.offset})`);
  while (state.watching.size > 0) {
    // Re-read each iteration so disabling Telegram (or clearing the token) in
    // Settings ends the loop rather than being noticed only next turn.
    const live = readTelegramConfig(store);
    if (!isTelegramReady(live)) {
      console.log('[telegram] listener stopping: Telegram disabled');
      return;
    }
    const started = Date.now();
    const { updates, nextOffset } = await pollTelegramUpdates(live, state.offset, {
      timeoutSec: POLL_TIMEOUT_SEC,
    });
    if (nextOffset !== state.offset) {
      state.offset = nextOffset;
      writeOffset(store, nextOffset);
    }
    for (const update of updates) {
      await handleUpdate(live, update);
    }
    const elapsed = Date.now() - started;
    if (elapsed < MIN_ITERATION_MS && state.watching.size > 0) {
      await sleep(MIN_ITERATION_MS - elapsed);
    }
  }
  console.log('[telegram] listener idle — no pending approvals');
}

/** Apply one update. Unwatches BEFORE resolving so the turn's own `settle`
 *  (which calls finishEscalation) sees nothing left to report — this path already
 *  confirmed in-chat. */
async function handleUpdate(cfg: TelegramConfig, update: TelegramUpdate): Promise<void> {
  const seen = interpretUpdate(update, (id) => state.watching.has(id));
  if (!seen) return;

  if (seen.kind === 'callback') {
    if (!seen.watched) {
      // A button from a turn that has already moved on (answered in the app,
      // timed out, or a server restart). Acknowledge so the spinner stops and
      // say so, rather than silently doing nothing.
      await answerCallbackQuery(cfg, seen.callbackQueryId, 'This request is no longer waiting.');
      return;
    }
    const watched = state.watching.get(seen.approvalId)!;
    state.watching.delete(seen.approvalId);
    const resolved = resolveApproval(seen.approvalId, telegramDecision(seen.decision));
    await answerCallbackQuery(
      cfg,
      seen.callbackQueryId,
      resolved
        ? seen.decision === 'allow'
          ? 'Approved'
          : 'Denied'
        : 'This request is no longer waiting.',
    );
    if (resolved) {
      await sendTelegramMessage(
        cfg,
        `${seen.decision === 'allow' ? '✅ Approved' : '❌ Denied'}: ${watched.toolName}`,
      );
      console.log(`[telegram] ${seen.decision} from button → ${seen.approvalId}`);
    }
    return;
  }

  // A bare yes/no answers the newest pending approval.
  const target = pickTextReplyTarget(state.watching.values());
  if (!target) return;
  state.watching.delete(target.approvalId);
  const resolved = resolveApproval(target.approvalId, telegramDecision(seen.decision));
  if (resolved) {
    await sendTelegramMessage(
      cfg,
      `${seen.decision === 'allow' ? '✅ Approved' : '❌ Denied'}: ${target.toolName}`,
    );
    console.log(`[telegram] ${seen.decision} from reply → ${target.approvalId}`);
  }
}
