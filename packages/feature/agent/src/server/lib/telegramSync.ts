// packages/feature/agent/src/server/lib/telegramSync.ts
//
// DESKTOP-TURN MIRRORING (telegram-chat §8) — the `always` delivery mode.
//
// The chat half (telegramChat.ts) lets the phone talk TO naby; this module is
// the other direction: when `telegram.syncMode` is `always`, every turn that
// finishes on the desktop — the user's request plus the final answer — is also
// sent to the chat, so a user away from the desk sees the work move and can
// pick any of it up by REPLYING to the mirror message (§8.4, the same reply
// routing a final report has always had).
//
// WHO CALLS IT. The orchestrator's run teardown — the one door every turn goes
// through, on every engine and from every caller — fires `mirrorTurn` and does
// not wait for it (§8.2). A mirror that is slow or fails must never hold a
// turn's completion; a failed send is a warning in the log (`telegram_out`
// records ok=false at the transport) and nothing more, because a mirror is a
// snapshot and the next turn is the next snapshot.
//
// WHAT IT NEVER MIRRORS (§8.3):
//   * Telegram-originated turns — the chat path already sends that answer.
//   * Aborted turns — a stop is something the user did at the desktop.
//   * Anything while the mode is `manual` — the pre-v0.2 behaviour, untouched.
//
// STRUCTURE. Follows telegramChat.ts: the render is PURE, the IO goes through
// an injectable seam (`MirrorIo`) so the tests need neither a bot nor a store.

import type { Store } from '../../../../../../../dist/naby-runtime.mjs';
import {
  isTelegramReady,
  readTelegramConfig,
  sendTelegramMessage,
} from './telegram';
import {
  formatFinalReport,
  isChatTurnInFlight,
  rememberChatMessage,
  truncate,
  type FinalReport,
} from './telegramEscalation';
import { projectHeader } from './telegramChatStrings';
import { projectDisplayName } from './projectDisplayName';

/** How much of the user's request the mirror quotes. Enough to recognize the
 *  ask on a phone; the full text is in the app (and the transcript). */
export const MIRROR_PROMPT_PREVIEW_CHARS = 300;

/** A finished desktop turn, as the orchestrator's teardown sees it. */
export type MirrorTurn = {
  /** The dispatch source (`chat`, `telegram`, `scheduled`, …). */
  source: string;
  sessionId: string;
  /** The user's request (absent for an images-only turn). */
  prompt?: string;
  ok: boolean;
  /** The final answer (success) — read from the run's `result` event. */
  text?: string;
  /** What went wrong (failure). */
  error?: string;
  durationMs?: number;
  numTurns?: number;
  /** Autonomy steps actually taken, when the run was autonomous. */
  steps?: number;
  /** multi-agent-chat §8.7(a): the PARTICIPANTS that spoke in this turn, in
   *  order (naby is never listed). Empty or absent = a naby-only turn, whose
   *  message keeps its old shape exactly. */
  speakers?: MirrorSpeaker[];
};

/** A participant as the mirror names it. */
export type MirrorSpeaker = { displayName: string; emoji?: string };

/** The speaker line (§8.7a): `🌐 Translator:` for one, `🌐 Translator · 🧐 Critic`
 *  for several (each speech in the text is then labelled on its own). */
export function mirrorSpeakerLine(speakers: readonly MirrorSpeaker[]): string | undefined {
  const names = speakers
    .filter((s) => s.displayName.trim())
    .map((s) => `${s.emoji ? `${s.emoji} ` : ''}${s.displayName.trim()}`);
  if (names.length === 0) return undefined;
  return names.length === 1 ? `${names[0]}:` : names.join(' · ');
}

/** The IO seam — the production default sends over the real bot and registers
 *  the reply route; the tests pass fakes. */
export type MirrorIo = {
  send: (text: string) => Promise<{ ok: true; messageId: number } | { ok: false; error: string }>;
  remember: (messageId: number, sessionId: string) => void;
};

/**
 * The mirror message (§8.2): ONE message per turn — the project line, a
 * session-title header, the quoted request, then the exact `formatFinalReport`
 * skeleton the escalation report uses, so the phone reads the same shape
 * whichever path delivered it.
 *
 * The project is the mirror's OWN first line rather than a field on the embedded
 * report: a mirror already carries a title and a quoted request above the
 * report, and printing the project down there would bury the one thing the
 * reader scans for (§0).
 */
export function formatMirrorMessage(
  sessionTitle: string | undefined,
  turn: MirrorTurn,
  project?: string,
): string {
  const lines: string[] = [];
  if (project !== undefined) lines.push(projectHeader(project));
  // §8.7(a): who answered goes RIGHT AFTER the project line — the two things a
  // phone reader scans for first. A naby-only turn has no such line.
  const speakerLine = mirrorSpeakerLine(turn.speakers ?? []);
  if (speakerLine) lines.push(speakerLine);
  lines.push(`🔁 ${sessionTitle?.trim() || turn.sessionId}`);
  const prompt = (turn.prompt ?? '').trim();
  if (prompt) lines.push(`🙋 ${truncate(prompt, MIRROR_PROMPT_PREVIEW_CHARS)}`);
  // One speaker: the round's text opens with that same label
  // (`roundResultText`); it is already on the speaker line, so it is not
  // repeated. Several speakers keep their per-speech labels.
  let text = turn.text;
  if (text && speakerLine && (turn.speakers ?? []).length === 1 && text.startsWith(`${speakerLine}\n`)) {
    text = text.slice(speakerLine.length + 1);
  }
  const report: FinalReport = {
    ok: turn.ok,
    ...(text ? { text } : {}),
    ...(turn.error ? { error: turn.error } : {}),
    ...(turn.durationMs != null ? { durationMs: turn.durationMs } : {}),
    ...(turn.numTurns != null ? { numTurns: turn.numTurns } : {}),
    ...(turn.steps != null ? { steps: turn.steps } : {}),
  };
  lines.push('', formatFinalReport(report));
  return lines.join('\n');
}

/**
 * Mirror one finished desktop turn to the chat, when the mode says to (§8).
 *
 * Every guard lives HERE rather than at the call site, so the orchestrator's
 * teardown stays one unconditional fire-and-forget line and a future caller
 * cannot forget a rule. Returns what happened for the tests; the caller
 * ignores it.
 */
export async function mirrorTurn(
  store: Store,
  turn: MirrorTurn,
  io?: MirrorIo,
): Promise<{ mirrored: boolean; reason?: string }> {
  const cfg = readTelegramConfig(store);
  if (cfg.syncMode !== 'always') return { mirrored: false, reason: 'manual-mode' };
  if (!isTelegramReady(cfg)) return { mirrored: false, reason: 'not-ready' };
  // §8.3 — the chat path already answers its own turns. The source check is the
  // primary guard (the orchestrator knows where the turn came from); the
  // in-flight set is the belt to its braces.
  if (turn.source === 'telegram') return { mirrored: false, reason: 'telegram-turn' };
  if (isChatTurnInFlight(turn.sessionId)) return { mirrored: false, reason: 'telegram-turn' };

  const session = store.getSession?.(turn.sessionId);
  const text = formatMirrorMessage(session?.title, turn, projectDisplayName(store, session?.cwd));
  const realIo: MirrorIo = io ?? {
    send: (t) => sendTelegramMessage(cfg, t),
    remember: (messageId, sessionId) => rememberChatMessage(messageId, sessionId, store),
  };
  const sent = await realIo.send(text);
  if (!sent.ok) {
    // §8.2 — log and move on. The transport already wrote the telegram_out
    // record with ok=false; this line is the human-readable half.
    console.warn(`[telegram] mirror failed: ${sent.error}`);
    return { mirrored: false, reason: 'send-failed' };
  }
  // §8.4 — the mirror is a reply target: answering it continues THAT session,
  // with no /use in between. This is what makes remote continuity whole.
  realIo.remember(sent.messageId, turn.sessionId);
  return { mirrored: true };
}
