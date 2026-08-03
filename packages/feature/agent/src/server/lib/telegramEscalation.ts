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
// THE LOOP IS NOW ALWAYS-ON (telegram-chat §5). It used to be reference-counted —
// started by the first pending escalation, ended by the last — because a
// permanently open long-poll was cost with no benefit while the only thing the
// chat could say was "yes" or "no" to a question naby had asked first.
//
// Two-way chat inverts that: the user starts the conversation, so there is no
// pending anything to key a loop off. Telegram still allows exactly ONE in-flight
// `getUpdates` per bot (a second gets 409), so the answer is not a second loop —
// it is THIS loop, promoted: it runs whenever Telegram is enabled with a chat id,
// and the approval/check-in watches ride on top of it exactly as before. The
// Settings "Detect" button, which also calls getUpdates, PAUSES it for the
// duration (pauseTelegramListener) rather than colliding with it.
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
import { resolveCheckin } from './checkinRegistry';
import {
  answerCallbackQuery,
  buildApprovalKeyboard,
  buildCheckinKeyboard,
  classifyNumericReply,
  classifyTextReply,
  isTelegramReady,
  parseCallbackData,
  parseCheckinCallbackData,
  pollTelegramUpdates,
  readTelegramConfig,
  sendTelegramMessage,
  setMyCommands,
  type TelegramConfig,
  type TelegramUpdate,
} from './telegram';
import { BOT_COMMANDS } from './telegramChatStrings';

/** Store setting holding the getUpdates watermark (see the header note). */
export const TELEGRAM_OFFSET_KEY = 'telegram.updateOffset';

/** Long-poll window. Telegram holds the request open this long when idle, so the
 *  loop costs one socket and no polling churn. */
const POLL_TIMEOUT_SEC = 25;

/** Floor between EMPTY iterations. A long-poll that fails (offline, 409) returns
 *  at once; without this the loop would spin hot on a network error. It does not
 *  apply when the poll actually delivered something: consecutive messages are
 *  exactly what the loop exists to carry, and making the second one wait two
 *  seconds behind the first is latency for nothing. */
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

/** Prefix of the in-chat confirmation after a check-in is answered. */
export const CHECKIN_ANSWERED = '🦋 Chose';

/** The check-in as it reads on a phone: the question, then the numbered options.
 *  The numbers are the whole interface — they match the buttons AND a bare "2"
 *  reply, so the user can answer either way without being told which. */
export function formatCheckinMessage(opts: {
  question: string;
  options: readonly string[];
  agentName?: string;
  cwd?: string;
}): string {
  const who = opts.agentName ? `@${opts.agentName}` : 'naby';
  const lines = [`🤔 ${who} is asking how to proceed`, '', truncate(opts.question, INPUT_PREVIEW_CHARS)];
  if (opts.cwd) lines.push('', `Dir: ${opts.cwd}`);
  lines.push('');
  opts.options.forEach((o, i) => lines.push(`${i + 1}. ${truncate(o, INPUT_PREVIEW_CHARS)}`));
  lines.push('', 'Tap a number below (or just reply with it).');
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
  /** The session this report is about. Not printed — it is what makes the sent
   *  message REPLYABLE (telegram-chat §1.3) and what tells a chat-started turn
   *  apart from an escalated one (§4). */
  sessionId?: string;
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
  ctx: {
    /** Short token → the id it names, or undefined for a stale/foreign button. */
    idForRef: (ref: string) => string | undefined;
    /** How many options the newest pending CHECK-IN offered, for a numeric reply.
     *  0 when none is pending, which makes every number ambiguous and ignored. */
    pendingOptionCount: number;
  },
):
  | { kind: 'approvalCallback'; callbackQueryId: string; id?: string; decision: 'allow' | 'deny' }
  | { kind: 'checkinCallback'; callbackQueryId: string; id?: string; chosen: number }
  | { kind: 'approvalText'; decision: 'allow' | 'deny' }
  | { kind: 'checkinText'; chosen: number }
  | undefined {
  if (update.callback_query) {
    const approval = parseCallbackData(update.callback_query.data);
    if (approval) {
      return {
        kind: 'approvalCallback',
        callbackQueryId: update.callback_query.id,
        ...(idForRefSafe(ctx, approval.ref) ? { id: idForRefSafe(ctx, approval.ref)! } : {}),
        decision: approval.decision,
      };
    }
    const checkin = parseCheckinCallbackData(update.callback_query.data);
    if (checkin) {
      return {
        kind: 'checkinCallback',
        callbackQueryId: update.callback_query.id,
        ...(idForRefSafe(ctx, checkin.ref) ? { id: idForRefSafe(ctx, checkin.ref)! } : {}),
        chosen: checkin.chosen,
      };
    }
    return undefined;
  }
  const text = update.message?.text;
  // A NUMBER is checked first and only against a pending check-in's option count:
  // "1" is a plausible answer to a choice and meaningless as an approval, while
  // "yes" is the reverse. Neither is ever guessed into the other's slot.
  const chosen = classifyNumericReply(text, ctx.pendingOptionCount);
  if (chosen !== undefined) return { kind: 'checkinText', chosen };
  const decision = classifyTextReply(text);
  return decision ? { kind: 'approvalText', decision } : undefined;
}

/** Tiny helper so the branches above read straight. */
function idForRefSafe(ctx: { idForRef: (ref: string) => string | undefined }, ref: string): string | undefined {
  return ctx.idForRef(ref);
}

/** Which pending approval a bare "yes" answers: the most recently escalated one —
 *  the message the user is looking at. Undefined when nothing is pending, so an
 *  unsolicited "yes" resolves nothing. */
export function pickTextReplyTarget<T extends { escalatedAt: number }>(
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

/** One question the bridge is waiting on. TWO KINDS through one loop: an approval
 *  is allow/deny about a tool, a check-in is a choice among ways to do the work.
 *  They share the poll loop, the watermark and the backlog drain — running a second
 *  loop would mean two `getUpdates` in flight, which Telegram answers with a 409
 *  and which would break both. */
type Watched = {
  /** The registry id the resolver is keyed by (approvalId / checkinId). */
  id: string;
  /** Short opaque token embedded in callback_data — see `mintRef`. */
  ref: string;
  /** What to call it in the confirmation message. */
  label: string;
  /** caller's clock — this module never reads the time itself. */
  escalatedAt: number;
} & (
  | { kind: 'approval' }
  | { kind: 'checkin'; options: string[] }
);

type BridgeState = {
  watching: Map<string, Watched>;
  /** Short token → watched id. THE REASON IT EXISTS: Telegram caps callback_data
   *  at 64 bytes and an id of the form `<sessionId>:<toolCallId>` measures 78 with
   *  a UUID session — the send fails outright and the buttons never appear. A
   *  bounded token keeps the data small whatever the ids grow into. */
  refs: Map<string, string>;
  refSeq: number;
  offset: number;
  /** whether the loop already drained the pre-existing backlog this process. */
  drained: boolean;
  loopRunning: boolean;
  /** The last poll failure LOGGED, so a network outage reports itself once on
   *  the way down and once on the way back up instead of every iteration. A
   *  silent listener spinning against a dead network is indistinguishable from
   *  an idle one, which is precisely how a transport fault gets read as "the
   *  user never answered". */
  lastPollError?: string;
  /** The Settings "Detect" button is holding the bot's single getUpdates slot
   *  (telegram-chat §5). The loop exits on this and is restarted on resume. */
  paused: boolean;
  /** Shutdown (or a test) asked the loop to end regardless of config. */
  stopRequested: boolean;
  /** Aborts the poll in flight, so a pause takes effect in milliseconds rather
   *  than at the end of a 25-second long-poll. */
  pollAbort?: AbortController;
  /** Ends the back-off sleep early, for the same reason. */
  wake?: () => void;
  /** message_id → the session that message came out of (telegram-chat §1.3).
   *  Bounded: a reply to a message older than this is answered by the LINK, which
   *  is the same thing the user would get from a fresh message. */
  sentBySession: Map<number, string>;
  /** Sessions with a Telegram-originated turn in flight. Two jobs: the busy
   *  notice (§4), and suppressing the engine's own final report for a turn whose
   *  answer the chat path is already going to send. */
  chatTurns: Set<string>;
  /** Whether the bot's command menu has been published this process. */
  commandsRegistered: boolean;
};

/** How many sent messages stay routable by reply. */
const SENT_MAP_MAX = 50;

const g = globalThis as unknown as { __nabyTelegramBridge?: BridgeState };
const state: BridgeState =
  g.__nabyTelegramBridge ??
  (g.__nabyTelegramBridge = {
    watching: new Map(),
    refs: new Map(),
    refSeq: 0,
    offset: 0,
    drained: false,
    loopRunning: false,
    paused: false,
    stopRequested: false,
    sentBySession: new Map(),
    chatTurns: new Set(),
    commandsRegistered: false,
  });

// -- what the chat half needs from the bridge --------------------------------

/** Remember which session a bot message came out of, so a REPLY to it routes
 *  back there (telegram-chat §1.3). Oldest entries fall off — the map is a
 *  convenience, not a record. */
export function rememberChatMessage(messageId: number, sessionId: string): void {
  if (!messageId) return;
  state.sentBySession.set(messageId, sessionId);
  while (state.sentBySession.size > SENT_MAP_MAX) {
    const oldest = state.sentBySession.keys().next();
    if (oldest.done) break;
    state.sentBySession.delete(oldest.value);
  }
}

/** The session a replied-to bot message belongs to, or undefined when it is
 *  older than the map or from a previous process. */
export function sessionForChatMessage(messageId: number): string | undefined {
  return state.sentBySession.get(messageId);
}

/** Mark (or clear) a Telegram-originated turn on a session. */
export function markChatTurn(sessionId: string, running: boolean): void {
  if (running) state.chatTurns.add(sessionId);
  else state.chatTurns.delete(sessionId);
}

/** True while a Telegram-originated turn is in flight on that session. */
export function isChatTurnInFlight(sessionId: string): boolean {
  return state.chatTurns.has(sessionId);
}

/** A short token for one escalation. Process-local and monotonic — it only has to
 *  be unique among what is currently being watched, and a button from a previous
 *  process is answered with "no longer waiting" either way. */
function mintRef(id: string): string {
  state.refSeq += 1;
  const ref = `r${state.refSeq.toString(36)}`;
  state.refs.set(ref, id);
  return ref;
}

/** Forget a watch and its token together, so the map cannot outlive the loop. */
function unwatch(id: string): Watched | undefined {
  const w = state.watching.get(id);
  if (!w) return undefined;
  state.watching.delete(id);
  state.refs.delete(w.ref);
  return w;
}

/** Test/diagnostic view of what the bridge is waiting on. */
export function pendingEscalations(): Watched[] {
  return [...state.watching.values()];
}

/** Resolve a callback's short token back to the id it names. */
function idForRef(ref: string): string | undefined {
  return state.refs.get(ref);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The back-off between empty polls — INTERRUPTIBLE.
 *
 * A plain sleep would make "stop the loop" mean "stop the loop within two
 * seconds", and both callers of stop are waiting on the answer: the Detect
 * button holds the user, and a shutdown holds the process. Waking the sleep
 * makes the pause handshake immediate.
 */
function idleSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      state.wake = undefined;
      resolve();
    };
    const timer = setTimeout(done, ms);
    state.wake = done;
  });
}

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
  // this line, and an unwatched id would be dropped.
  const ref = mintRef(opts.approvalId);
  state.watching.set(opts.approvalId, {
    kind: 'approval',
    id: opts.approvalId,
    ref,
    label: opts.toolName,
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
    { replyMarkup: buildApprovalKeyboard(ref) },
  );
  if (!sent.ok) {
    // Could not ask remotely — stop watching so the loop can exit; the in-app
    // prompt (and the TTL) still governs this approval.
    unwatch(opts.approvalId);
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
  const watched = unwatch(opts.approvalId);
  if (!watched) return;
  const cfg = readTelegramConfig(opts.store);
  if (!isTelegramReady(cfg)) return;
  const mark = opts.decision === 'allow' ? '✅ Approved' : '❌ Denied';
  // The reason (a policy deny, an abort, the TTL) is the informative part when
  // there is one; without one the decision came from the in-app buttons.
  const detail = opts.reason ? ` — ${opts.reason}` : ' — answered in the app';
  await sendTelegramMessage(cfg, `${mark}: ${watched.label}${detail}`);
}

/** Escalate a paused CHECK-IN to Telegram: send the question with numbered
 *  buttons and start watching. Fire-and-forget for the same reason as an approval —
 *  the in-app prompt is already up, so a Telegram failure must degrade to
 *  "answer in the app". Never throws. */
export async function escalateCheckin(opts: {
  store: Store;
  checkinId: string;
  question: string;
  options: readonly string[];
  agentName?: string;
  cwd?: string;
  /** caller's clock (this module keeps no clock of its own). */
  now: number;
}): Promise<void> {
  const cfg = readTelegramConfig(opts.store);
  if (!isTelegramReady(cfg)) {
    console.log('[telegram] check-in escalation skipped: Telegram not configured — answer in the app');
    return;
  }
  const ref = mintRef(opts.checkinId);
  state.watching.set(opts.checkinId, {
    kind: 'checkin',
    id: opts.checkinId,
    ref,
    // The question, shortened — it is what the confirmation message names.
    label: truncate(opts.question, 60),
    options: [...opts.options],
    escalatedAt: opts.now,
  });
  ensureListener(opts.store);
  const sent = await sendTelegramMessage(
    cfg,
    formatCheckinMessage({
      question: opts.question,
      options: opts.options,
      ...(opts.agentName ? { agentName: opts.agentName } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    }),
    { replyMarkup: buildCheckinKeyboard(ref, opts.options.length) },
  );
  if (!sent.ok) {
    unwatch(opts.checkinId);
    console.warn(`[telegram] check-in escalation send failed: ${sent.error}`);
    return;
  }
  console.log(`[telegram] escalated check-in (${opts.checkinId}, ${opts.options.length} options)`);
}

/** The check-in was settled by someone OTHER than Telegram (the in-app prompt, an
 *  abort, or the TTL). Stop watching and tell the chat, so live buttons on a phone
 *  are not the last word the user sees.
 *
 *  A no-op when the id is not watched — exactly the case when the loop itself
 *  answered it, so the two paths never double-report. */
export async function finishCheckinEscalation(opts: {
  store: Store;
  checkinId: string;
  /** The option index the user picked, or -1 / undefined when nobody answered. */
  chosen?: number;
}): Promise<void> {
  const watched = unwatch(opts.checkinId);
  if (!watched || watched.kind !== 'checkin') return;
  const cfg = readTelegramConfig(opts.store);
  if (!isTelegramReady(cfg)) return;
  const option =
    opts.chosen !== undefined && opts.chosen >= 0 ? watched.options[opts.chosen] : undefined;
  const detail = option
    ? `${opts.chosen! + 1}. ${option} — answered in the app`
    : 'no longer waiting — answered in the app, or it expired';
  await sendTelegramMessage(cfg, `${CHECKIN_ANSWERED} ${detail}`);
}

/** Report a finished turn to the chat (the second half of escalation). Awaited by
 *  the engine so the report is actually out before the turn's work ends. */
export async function sendFinalReport(store: Store, report: FinalReport): Promise<void> {
  const cfg = readTelegramConfig(store);
  if (!isTelegramReady(cfg)) return;
  // A turn the CHAT started reports itself (telegram-chat §4): the chat path
  // waits for the run and sends the answer, so letting the engine also report
  // would put the same answer on the phone twice.
  if (report.sessionId && state.chatTurns.has(report.sessionId)) return;
  const sent = await sendTelegramMessage(cfg, formatFinalReport(report));
  if (!sent.ok) {
    console.warn(`[telegram] final report failed: ${sent.error}`);
    return;
  }
  // A report is a reply target too: answering it continues THAT session.
  if (report.sessionId) rememberChatMessage(sent.messageId, report.sessionId);
}

// -- the polling loop ---------------------------------------------------------

/** Start the loop if it is not already running. Idempotent and synchronous: the
 *  caller (a paused turn) must not wait on a long-poll. */
export function ensureListener(store: Store): void {
  if (state.loopRunning) return;
  state.stopRequested = false;
  state.loopRunning = true;
  void runListener(store).finally(() => {
    state.loopRunning = false;
    // A watch added during the shutdown window would otherwise be stranded, so
    // hand it to a fresh loop. (Not while paused or stopped: those are deliberate
    // silences, and the pause handshake below waits for the loop to be gone.)
    if (state.watching.size > 0 && !state.paused && !state.stopRequested) ensureListener(store);
  });
}

/**
 * Hand the bot's single `getUpdates` slot to someone else (the Settings "Detect"
 * button) — telegram-chat §5.
 *
 * Resolves once the loop has actually EXITED, not merely been asked to: two
 * concurrent getUpdates on one bot is the 409 this exists to prevent, so a
 * caller that starts polling on the strength of a request that has not landed
 * yet has gained nothing. The in-flight long-poll is aborted so the handshake
 * takes milliseconds instead of up to 25 seconds.
 */
export async function pauseTelegramListener(): Promise<void> {
  state.paused = true;
  interruptLoop();
  const deadline = Date.now() + 5000;
  while (state.loopRunning && Date.now() < deadline) await sleep(20);
}

/** Give the slot back and start listening again (a no-op when Telegram is off —
 *  `ensureListener` re-reads the config). */
export function resumeTelegramListener(store: Store): void {
  state.paused = false;
  ensureListener(store);
}

/** Whether a poll loop is alive right now (diagnostics, and test teardown). */
export function telegramListenerRunning(): boolean {
  return state.loopRunning;
}

/** End the loop regardless of config (shutdown, and test teardown). It restarts
 *  on the next `ensureListener`. */
export function stopTelegramListener(): void {
  state.stopRequested = true;
  interruptLoop();
}

/** Cut short whatever the loop is currently waiting on — the long-poll in flight
 *  and the back-off sleep — so a pause/stop lands in milliseconds. */
function interruptLoop(): void {
  try {
    state.pollAbort?.abort();
  } catch {
    /* nothing in flight */
  }
  state.wake?.();
}

/**
 * Whether the loop should keep going. ALWAYS-ON when Telegram can chat (enabled
 * + token + chat id, telegram-chat §5); before that promotion this was
 * `watching.size > 0`, and a pending escalation still keeps a loop alive for the
 * transitional case where the config is half-written.
 */
function shouldKeepListening(store: Store): boolean {
  if (state.stopRequested || state.paused) return false;
  return isTelegramReady(readTelegramConfig(store));
}

async function runListener(store: Store): Promise<void> {
  // Someone else holds the slot (Detect). Return before the backlog drain below,
  // which is itself a getUpdates and would be the very 409 the pause prevents —
  // reachable when the first escalation of the process lands mid-detect.
  if (state.paused || state.stopRequested) return;
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
  // The command menu, published once per process on the way into the loop
  // (telegram-chat §2). Best-effort: the commands work either way.
  void registerBotCommands(cfg);
  console.log(`[telegram] listening (offset ${state.offset})`);
  // Consecutive polls that came back empty IMMEDIATELY. A long-poll is supposed
  // to block for 25 seconds, so one fast empty answer is ordinary (a confirm
  // round-trip); a run of them means something is wrong — offline, or a 409 —
  // and that is the hot spin the back-off exists to stop. Counting them, rather
  // than sleeping after every empty poll, keeps the first message after an idle
  // stretch from waiting two seconds for no reason.
  let fastEmptyStreak = 0;
  while (shouldKeepListening(store) || state.watching.size > 0) {
    // Re-read each iteration so disabling Telegram (or clearing the token) in
    // Settings ends the loop rather than being noticed only next turn.
    const live = readTelegramConfig(store);
    if (!isTelegramReady(live)) {
      console.log('[telegram] listener stopping: Telegram disabled');
      return;
    }
    if (state.stopRequested || state.paused) {
      console.log(`[telegram] listener ${state.paused ? 'paused' : 'stopped'}`);
      return;
    }
    const started = Date.now();
    const abort = new AbortController();
    state.pollAbort = abort;
    const { updates, nextOffset, error } = await pollTelegramUpdates(live, state.offset, {
      timeoutSec: POLL_TIMEOUT_SEC,
      signal: abort.signal,
    });
    state.pollAbort = undefined;
    // Report the TRANSITION only — first failure, and the recovery — so an
    // outage is visible in the log without burying it under one line per poll.
    if (error && error !== state.lastPollError) {
      console.warn(`[telegram] poll failed: ${error} — retrying`);
    } else if (!error && state.lastPollError) {
      console.log('[telegram] poll recovered');
    }
    state.lastPollError = error;
    if (nextOffset !== state.offset) {
      state.offset = nextOffset;
      writeOffset(store, nextOffset);
    }
    for (const update of updates) {
      // One bad update must not end an ALWAYS-ON loop. While the loop lived only
      // as long as a pending approval, a throw here ended something that was
      // about to end anyway; now it would take the whole channel down — every
      // future message and every future escalation — until the next restart.
      try {
        await handleUpdate(store, live, update);
      } catch (e) {
        console.error(`[telegram] update ${update.update_id} failed:`, e);
      }
    }
    const elapsed = Date.now() - started;
    const fastEmpty = updates.length === 0 && elapsed < MIN_ITERATION_MS;
    fastEmptyStreak = fastEmpty ? fastEmptyStreak + 1 : 0;
    // A FAILED poll backs off immediately — that is the hot spin (offline, 409)
    // the floor was written for. A poll that merely came back empty too fast gets
    // one free retry first, so the first message after an idle stretch is not
    // held for two seconds behind a poll that had nothing to say.
    if ((error || fastEmptyStreak > 1) && !state.paused && !state.stopRequested) {
      await idleSleep(Math.max(0, MIN_ITERATION_MS - elapsed));
    }
  }
  console.log('[telegram] listener ended');
}

/** Publish the "/" command menu once per process (best-effort, §2). */
async function registerBotCommands(cfg: TelegramConfig): Promise<void> {
  if (state.commandsRegistered) return;
  state.commandsRegistered = true;
  const done = await setMyCommands(cfg, BOT_COMMANDS);
  if (!done.ok) {
    // Not fatal and not retried in a tight loop: the commands themselves work
    // whether or not the menu lists them.
    console.warn(`[telegram] setMyCommands failed: ${done.error}`);
  }
}

/** Force the next loop start (or save) to publish the menu again — used when the
 *  bot token changes, since the menu belongs to the bot, not to the process. */
export function resetBotCommandRegistration(): void {
  state.commandsRegistered = false;
}

/** Publish the menu now, for the Settings save path. */
export async function registerTelegramCommands(store: Store): Promise<void> {
  const cfg = readTelegramConfig(store);
  if (!cfg.botToken) return;
  await registerBotCommands(cfg);
}

/** The chat an update came from, or undefined when it names none. */
function updateChatId(update: TelegramUpdate): string | undefined {
  const id = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
  return id === undefined ? undefined : String(id);
}

/**
 * Apply one update — THE ROUTING PRIORITY of telegram-chat §1.
 *
 *   1. an answer to a pending approval / check-in (buttons and bare yes/no/N),
 *   2. a "/" command,
 *   3. a reply to one of the bot's own messages,
 *   4. plain text on the linked session.
 *
 * 1 outranks the rest because an answer to a question naby ASKED is never a new
 * request: if a check-in is waiting and the user types "2", they are choosing
 * option 2, not starting a turn that says "2".
 *
 * Unwatches BEFORE resolving so the turn's own `settle` (which calls
 * finishEscalation) sees nothing left to report — this path already confirmed
 * in-chat.
 */
async function handleUpdate(store: Store, cfg: TelegramConfig, update: TelegramUpdate): Promise<void> {
  // §6 — the configured chat is the only authenticated one. An update from a
  // foreign chat is dropped whole, before any interpretation: the bot token is
  // enough to message the bot, so this check is what stands between a stranger
  // and a turn on the user's machine.
  const from = updateChatId(update);
  if (from !== undefined && from !== String(cfg.chatId)) {
    console.warn(`[telegram] ignoring update from unknown chat ${from}`);
    return;
  }

  const newestCheckin = pickTextReplyTarget(
    [...state.watching.values()].filter((w): w is Watched & { kind: 'checkin' } => w.kind === 'checkin'),
  );
  const seen = interpretUpdate(update, {
    idForRef,
    pendingOptionCount: newestCheckin?.options.length ?? 0,
  });
  // Nothing pending recognizes it → it belongs to the chat (priorities 2–4).
  if (!seen) {
    routeToChat(store, cfg, update);
    return;
  }

  // -- a button from a question that has already moved on ---------------------
  // (answered in the app, timed out, or a server restart lost the map).
  // Acknowledge so the spinner stops and SAY so, rather than doing nothing.
  if (seen.kind === 'approvalCallback' || seen.kind === 'checkinCallback') {
    const watched = seen.id ? state.watching.get(seen.id) : undefined;
    if (!watched) {
      await answerCallbackQuery(cfg, seen.callbackQueryId, 'This request is no longer waiting.');
      return;
    }
    if (seen.kind === 'approvalCallback' && watched.kind === 'approval') {
      unwatch(watched.id);
      const resolved = resolveApproval(watched.id, telegramDecision(seen.decision));
      await answerCallbackQuery(
        cfg,
        seen.callbackQueryId,
        resolved ? (seen.decision === 'allow' ? 'Approved' : 'Denied') : 'This request is no longer waiting.',
      );
      if (resolved) {
        await sendTelegramMessage(
          cfg,
          `${seen.decision === 'allow' ? '✅ Approved' : '❌ Denied'}: ${watched.label}`,
        );
        console.log(`[telegram] ${seen.decision} from button → ${watched.id}`);
      }
      return;
    }
    if (seen.kind === 'checkinCallback' && watched.kind === 'checkin') {
      // An out-of-range index can only come from a tampered or stale button; it
      // must not be recorded as the user's answer.
      const option = watched.options[seen.chosen];
      if (option === undefined) {
        await answerCallbackQuery(cfg, seen.callbackQueryId, 'That option is no longer valid.');
        return;
      }
      unwatch(watched.id);
      const resolved = resolveCheckin(watched.id, { chosen: seen.chosen });
      await answerCallbackQuery(
        cfg,
        seen.callbackQueryId,
        resolved ? `Chose ${seen.chosen + 1}` : 'This request is no longer waiting.',
      );
      if (resolved) {
        await sendTelegramMessage(cfg, `${CHECKIN_ANSWERED} ${seen.chosen + 1}. ${option}`);
        console.log(`[telegram] check-in option ${seen.chosen + 1} from button → ${watched.id}`);
      }
      return;
    }
    // A button of one kind pressed against a watch of the other: only possible
    // from a stale message after a restart reused a token. Say so, change nothing.
    await answerCallbackQuery(cfg, seen.callbackQueryId, 'This request is no longer waiting.');
    return;
  }

  // -- a bare number answers the newest pending CHECK-IN ----------------------
  if (seen.kind === 'checkinText') {
    // No check-in is waiting for it after all (it was answered in the app between
    // the poll and here): a bare number is then ordinary text, and swallowing it
    // would lose a message the user typed to the linked session.
    if (!newestCheckin) {
      routeToChat(store, cfg, update);
      return;
    }
    const option = newestCheckin.options[seen.chosen];
    if (option === undefined) return;
    unwatch(newestCheckin.id);
    if (resolveCheckin(newestCheckin.id, { chosen: seen.chosen })) {
      await sendTelegramMessage(cfg, `${CHECKIN_ANSWERED} ${seen.chosen + 1}. ${option}`);
      console.log(`[telegram] check-in option ${seen.chosen + 1} from reply → ${newestCheckin.id}`);
    }
    return;
  }

  // -- a bare yes/no answers the newest pending APPROVAL ----------------------
  const target = pickTextReplyTarget(
    [...state.watching.values()].filter((w) => w.kind === 'approval'),
  );
  // Nothing is waiting on a yes/no, so "네" is just a message — send it to the
  // linked session rather than dropping it (pre-chat, dropping was correct: there
  // was nowhere for it to go).
  if (!target) {
    routeToChat(store, cfg, update);
    return;
  }
  unwatch(target.id);
  const resolved = resolveApproval(target.id, telegramDecision(seen.decision));
  if (resolved) {
    await sendTelegramMessage(
      cfg,
      `${seen.decision === 'allow' ? '✅ Approved' : '❌ Denied'}: ${target.label}`,
    );
    console.log(`[telegram] ${seen.decision} from reply → ${target.id}`);
  }
}

/**
 * Hand an update to the chat half (telegram-chat §1.2–1.4).
 *
 * FIRE AND FORGET, and that is the load-bearing part: a chat turn can run for
 * minutes, and awaiting it here would stop the poll — which is exactly the loop
 * that has to keep running for the approval or check-in THAT TURN raises to reach
 * the phone. The one thing that must not happen is the loop waiting on a turn
 * that is waiting on the loop.
 */
function routeToChat(store: Store, cfg: TelegramConfig, update: TelegramUpdate): void {
  if (!update.message) return;
  void (async () => {
    try {
      const chat = await import('./telegramChat');
      const runtime = await chat.chatRuntimeDeps();
      await chat.handleChatUpdate(
        {
          store,
          send: (text: string) => sendTelegramMessage(cfg, text),
          rememberMessage: rememberChatMessage,
          sessionForMessage: sessionForChatMessage,
          now: () => Date.now(),
          isBusy: (sessionId: string) => runtime.isBusy(sessionId) || isChatTurnInFlight(sessionId),
          runTurn: async (opts) => {
            markChatTurn(opts.sessionId, true);
            try {
              return await runtime.runTurn(opts);
            } finally {
              markChatTurn(opts.sessionId, false);
            }
          },
        },
        cfg,
        update,
      );
    } catch (e) {
      // A chat failure must never take the listener down with it — the next
      // update, and every pending approval, still need this loop.
      console.error('[telegram] chat handling failed:', e);
    }
  })();
}
