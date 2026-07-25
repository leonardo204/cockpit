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
};

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
  });

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
  const newestCheckin = pickTextReplyTarget(
    [...state.watching.values()].filter((w): w is Watched & { kind: 'checkin' } => w.kind === 'checkin'),
  );
  const seen = interpretUpdate(update, {
    idForRef,
    pendingOptionCount: newestCheckin?.options.length ?? 0,
  });
  if (!seen) return;

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
    if (!newestCheckin) return;
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
  if (!target) return;
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
