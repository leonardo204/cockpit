// packages/feature/agent/src/server/lib/telegramProgress.ts
//
// LIVE PROGRESS FOR A TELEGRAM-STARTED TURN (telegram-chat §4.1).
//
// Before this, a turn started from the phone was silent for up to a minute and
// then said "⏳ 작업 중..." exactly once. A user who asked for something that
// takes four minutes had no way to tell "working" from "the bot is broken", and
// the run's tool calls — the only evidence that anything is happening — never
// left the machine.
//
// THE SHAPE OF THE ANSWER IS AN EDIT, NOT A STREAM. Telegram's practical ceiling
// is around 20 writes per minute to one chat and an edit counts against it, so
// a message per tool call is both unreadable and over budget within seconds of a
// normal turn. Instead ONE message is posted after a short grace and then
// REWRITTEN in place at most once every `PROGRESS_EDIT_INTERVAL_MS`:
//
//   grace 3s + one edit / 4s  →  1 + 15 = 16 writes/min worst case,
//   plus the turn's single answer message. Inside the ceiling with room for the
//   approval and check-in escalations that ride the same chat.
//
// SCOPE: TELEGRAM-ORIGINATED TURNS ONLY (§4.1). The reporter is wired inside the
// chat path's `runTurn`, which is the only caller, so a desktop turn mirrored in
// `always` mode is untouched. Streaming those would put a progress message on
// the phone for work the user is watching on a screen in front of them, and
// several desktop turns at once would spend the whole rate budget on noise.
//
// STRUCTURE follows fileBrowserOps.ts: every DECISION here is a pure function —
// what a run event means, how the accumulated state reads, whether an edit is
// due — and `startProgressReporter` is the thin shell that owns a timer and
// calls an injected IO seam. That is what lets the tests drive a whole turn's
// worth of progress with no bot, no engine and no clock.

import { STR, projectHeader } from './telegramChatStrings';

/** How long a turn must run before it gets a progress message at all. An answer
 *  that arrives in two seconds should be the ONLY thing in the chat. */
export const PROGRESS_GRACE_MS = 3_000;

/** Floor between edits of the progress message — the rate-limit arithmetic in
 *  the header. */
export const PROGRESS_EDIT_INTERVAL_MS = 4_000;

/** How many recent tool lines the message shows. A phone screen, and the older
 *  ones are no longer what the run is doing. */
export const PROGRESS_RECENT_LINES = 4;

/** Hard cap on a tool's target. A command or a path can be arbitrarily long and
 *  one of them must not push the rest of the message off the screen. */
export const PROGRESS_TARGET_CHARS = 40;

// -- reading a run event (pure) ----------------------------------------------

/** What one run event means to the progress message, or undefined for the many
 *  events (text deltas, thinking, init) that it does not report. */
export type ProgressEvent =
  | { kind: 'tool'; name: string; target?: string }
  | { kind: 'toolResult'; isError: boolean }
  | { kind: 'result' };

/** One tool call as the message lists it. */
export type ProgressToolLine = {
  name: string;
  target?: string;
  /** Set once the call's result came back with `is_error`. */
  failed?: boolean;
};

export type ProgressState = {
  /** epoch ms — the elapsed clock's origin. */
  startedAt: number;
  /** Every tool call seen this turn, not just the ones still listed. */
  toolCount: number;
  /** The tail, newest last, capped at `PROGRESS_RECENT_LINES`. */
  recent: ProgressToolLine[];
  /** Changes accumulated since the last edit went out. The throttle coalesces
   *  them: five tool calls inside one interval are ONE rewrite. */
  pending: number;
  /** A terminal `result` arrived — the run is over and the answer is next. */
  done: boolean;
};

export function initialProgressState(startedAt: number): ProgressState {
  return { startedAt, toolCount: 0, recent: [], pending: 0, done: false };
}

/**
 * The short target of a tool call: the ONE piece of its input that says what it
 * touched. A file gets its basename (the directory is the project, already in
 * the header), a command gets its first line, a search gets its pattern.
 *
 * DEFENSIVE BY CONSTRUCTION. The naby engine's own shapes are known, but the
 * claude / codex / ollama engines emit their own and any field may be missing or
 * be the wrong type — a progress line is never worth throwing inside a listener
 * that runs on the engine's own callback.
 */
export function shortToolTarget(input: unknown): string | undefined {
  if (typeof input === 'string') return clampTarget(input);
  if (!input || typeof input !== 'object') return undefined;
  const o = input as Record<string, unknown>;
  const path = firstString(o, ['file_path', 'filePath', 'notebook_path', 'path']);
  if (path) return clampTarget(basename(path));
  const command = firstString(o, ['command', 'cmd']);
  if (command) return clampTarget(command);
  const pattern = firstString(o, ['pattern', 'query']);
  if (pattern) return clampTarget(pattern);
  const url = firstString(o, ['url']);
  if (url) return clampTarget(url);
  const prompt = firstString(o, ['description', 'prompt']);
  if (prompt) return clampTarget(prompt);
  return undefined;
}

function firstString(o: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

/** Basename over both separators, so a Windows path is not printed whole. */
function basename(p: string): string {
  const parts = p.replace(/[/\\]+$/, '').split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

/** First line, collapsed whitespace, hard cap. A multi-line heredoc is one line
 *  of evidence here, not a wall. */
function clampTarget(raw: string): string {
  const line = raw.split('\n')[0]!.replace(/\s+/g, ' ').trim();
  if (!line) return '';
  return line.length <= PROGRESS_TARGET_CHARS
    ? line
    : `${line.slice(0, PROGRESS_TARGET_CHARS)}…`;
}

/**
 * Read one raw run-hub event. Recognizes the naby engine's translation shapes
 * (engines/naby.ts) and tolerates anything else by returning undefined.
 */
export function readProgressEvent(raw: unknown): ProgressEvent | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const ev = raw as { type?: unknown; message?: unknown };
  if (ev.type === 'result') return { kind: 'result' };
  if (ev.type !== 'assistant' && ev.type !== 'user') return undefined;
  const message = ev.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return undefined;
  for (const rawBlock of content) {
    if (!rawBlock || typeof rawBlock !== 'object') continue;
    const block = rawBlock as { type?: unknown; name?: unknown; input?: unknown; is_error?: unknown };
    if (block.type === 'tool_use') {
      const name = typeof block.name === 'string' && block.name ? block.name : 'tool';
      const target = shortToolTarget(block.input);
      return { kind: 'tool', name, ...(target ? { target } : {}) };
    }
    if (block.type === 'tool_result') {
      return { kind: 'toolResult', isError: block.is_error === true };
    }
  }
  return undefined;
}

/**
 * Fold one event into the running state. PURE — a new state, so a test can
 * replay a whole turn and assert on the result.
 *
 * A tool_result marks the CURRENT last line failed rather than adding a line of
 * its own: the interesting fact is "the Bash call failed", and a separate
 * "result" line would double the length of the message for no new information.
 */
export function reduceProgress(state: ProgressState, ev: ProgressEvent): ProgressState {
  switch (ev.kind) {
    case 'tool': {
      const line: ProgressToolLine = { name: ev.name, ...(ev.target ? { target: ev.target } : {}) };
      const recent = [...state.recent, line].slice(-PROGRESS_RECENT_LINES);
      return { ...state, toolCount: state.toolCount + 1, recent, pending: state.pending + 1 };
    }
    case 'toolResult': {
      if (!ev.isError || state.recent.length === 0) return state;
      const recent = state.recent.slice();
      recent[recent.length - 1] = { ...recent[recent.length - 1]!, failed: true };
      return { ...state, recent, pending: state.pending + 1 };
    }
    case 'result':
      return { ...state, done: true, pending: state.pending + 1 };
  }
}

// -- when to write (pure) -----------------------------------------------------

/**
 * Whether the progress message is due for a rewrite.
 *
 * Two conditions, both necessary: something must have CHANGED since the last
 * edit (an interval that saw no events has nothing to say, and Telegram rejects
 * an identical edit anyway), and the interval must have elapsed. `lastEditAt` of
 * 0 means "never edited", which is due as soon as there is anything to report.
 */
export function shouldEditNow(opts: {
  lastEditAt: number;
  now: number;
  pending: number;
  intervalMs?: number;
}): boolean {
  if (opts.pending <= 0) return false;
  if (opts.lastEditAt <= 0) return true;
  return opts.now - opts.lastEditAt >= (opts.intervalMs ?? PROGRESS_EDIT_INTERVAL_MS);
}

// -- rendering (pure) ---------------------------------------------------------

/** Elapsed time as a phone reads it. Coarse on purpose — the difference between
 *  71 and 74 seconds never changes what the user does next. */
export function formatElapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}초`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}분 ${sec % 60}초`;
  return `${Math.floor(min / 60)}시간 ${min % 60}분`;
}

/** One tool line: the tool's name and the short target, with a marker when the
 *  call came back an error. */
export function formatToolLine(line: ProgressToolLine): string {
  const mark = line.failed ? '✗' : '•';
  return line.target ? `${mark} ${line.name} — ${line.target}` : `${mark} ${line.name}`;
}

/**
 * The whole progress body: the project (§0), how long it has been going, how
 * many tool calls, and the last few of them.
 */
export function renderProgress(state: ProgressState, opts: { project: string; now: number }): string {
  return [
    projectHeader(opts.project),
    STR.progress({
      elapsed: formatElapsed(opts.now - state.startedAt),
      tools: state.toolCount,
      lines: state.recent.map(formatToolLine),
      done: state.done,
    }),
  ].join('\n');
}

// -- the thin IO shell --------------------------------------------------------

/** The seam. Production wires the bot; the tests wire arrays. */
export type ProgressIo = {
  send: (text: string) => Promise<{ ok: true; messageId: number } | { ok: false; error: string }>;
  edit: (messageId: number, text: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  now: () => number;
};

export type ProgressReporter = {
  /** Feed one raw run-hub event. Never throws — it runs on the engine's own
   *  callback and a rendering slip must not take a turn down. */
  onEvent: (raw: unknown) => void;
  /** The turn ended: flush the last state and stop. Awaited before the answer
   *  goes out, so the progress message never claims to still be working. */
  finish: () => Promise<void>;
};

/**
 * Post one progress message after the grace period and keep it current until
 * `finish`.
 *
 * DEGRADE TO SILENCE, NEVER TO SPAM. The first failed write — the user deleted
 * the message, Telegram rate-limited us, the network dropped — ends the
 * reporter for the rest of the turn. Retrying an edit in a loop is how a
 * rate-limit becomes a ban, and the answer is coming either way.
 *
 * The answer is a SEPARATE message and this one is never reused for it: reply
 * routing (`rememberChatMessage`) is keyed on the answer's own message id, and
 * an edited progress balloon would give the user something to reply to that
 * routes nowhere.
 */
export function startProgressReporter(
  io: ProgressIo,
  opts: { project: string; graceMs?: number; intervalMs?: number },
): ProgressReporter {
  let state = initialProgressState(io.now());
  let messageId: number | undefined;
  let lastEditAt = 0;
  let stopped = false;
  let ended = false;
  /** Serializes writes: an edit issued while another is in flight would race and
   *  could land out of order, showing an older state as the final one. */
  let writing: Promise<void> = Promise.resolve();

  const grace = setTimeout(() => {
    void enqueue(async () => {
      if (stopped || ended || messageId !== undefined) return;
      const sent = await io.send(renderProgress(state, { project: opts.project, now: io.now() }));
      if (!sent.ok) {
        stopped = true;
        return;
      }
      messageId = sent.messageId;
      lastEditAt = io.now();
      state = { ...state, pending: 0 };
    });
  }, opts.graceMs ?? PROGRESS_GRACE_MS);
  // A turn can outlive the process's other work; this timer must never be the
  // reason Node stays up.
  grace.unref?.();

  function enqueue(fn: () => Promise<void>): Promise<void> {
    writing = writing.then(fn, () => {}).catch(() => {});
    return writing;
  }

  async function flush(force: boolean): Promise<void> {
    if (stopped || messageId === undefined) return;
    const now = io.now();
    if (!force && !shouldEditNow({ lastEditAt, now, pending: state.pending, ...(opts.intervalMs !== undefined ? { intervalMs: opts.intervalMs } : {}) })) {
      return;
    }
    if (force && state.pending <= 0) return;
    const body = renderProgress(state, { project: opts.project, now });
    state = { ...state, pending: 0 };
    const edited = await io.edit(messageId, body);
    if (!edited.ok) {
      stopped = true;
      return;
    }
    lastEditAt = now;
  }

  return {
    onEvent: (raw: unknown): void => {
      if (stopped || ended) return;
      try {
        const ev = readProgressEvent(raw);
        if (!ev) return;
        state = reduceProgress(state, ev);
      } catch {
        return;
      }
      void enqueue(() => flush(false));
    },
    finish: async (): Promise<void> => {
      ended = true;
      clearTimeout(grace);
      // Wait out whatever is in flight, THEN force the last state, so the final
      // rewrite is the one the user is left looking at.
      await enqueue(() => flush(true));
    },
  };
}
