/**
 * Read / filter / context helpers over RunningCommand buffers.
 *
 * Pipe mode reads directly off `outputLines` (line-array). PTY mode lazily
 * materializes a logical-line view from `ptyRingBuffer.snapshot()` by
 * stripping ANSI + collapsing `\r` overwrites and splitting on `\n`. The two
 * paths produce the same `LinesView` shape so all downstream operations
 * (since / tail / head / around / grep) share one implementation.
 *
 * All line numbers in the returned shapes are GLOBAL — they survive ring
 * buffer trimming, since the counter is maintained monotonically by the
 * registry (see `totalLinesEverWritten` invariant).
 */
import type { RunningCommand } from './RunningCommandRegistry';
import { getFirstAvailableLine } from './RunningCommandRegistry';

/* ───────────────────────────────────────────────────────────────────────── */
/* Pure helpers                                                              */
/* ───────────────────────────────────────────────────────────────────────── */

/** ESC `[` … `<final byte>` / OSC … BEL|ESC\ — covers the sequences likely
 *  to appear in any normal CLI output. Not exhaustive vs the ECMA-48 spec,
 *  but matches what `strip-ansi` does and is the de-facto baseline. */
const ANSI_RE =
  /[\x1b\x9B][[\]()#;?]*(?:(?:(?:[a-zA-Z0-9]*(?:;[a-zA-Z0-9]*)*)?\x07)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PRZcf-ntqry=><~]))/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/**
 * Apply `\r` overwrite semantics to a single line: keep only the substring
 * after the last *in-line* `\r`. Folds progress-bar history away so AI sees
 * the final state rather than every redraw.
 *
 * Trailing `\r`s (one or more) are dropped before the overwrite check.
 * Sources of trailing `\r`:
 *   - PTY `\r\n` line ending → split('\n') glues a single `\r` on the end.
 *   - Multi-process runners like turborepo / pm2-style log prefixers emit
 *     `\x1b[K\r` clear-line + return sequences; after strip-ansi removes
 *     `\x1b[K`, the line ends with `\r\r` (or more). Without trimming
 *     these all, lastIndexOf hits one of them and collapses the whole
 *     line to "", which broke real dev-server log analysis (observed
 *     against turborepo's `api:dev: ...` JSON-log output).
 */
export function collapseCarriageReturn(line: string): string {
  const s = line.replace(/\r+$/, '');
  const idx = s.lastIndexOf('\r');
  return idx === -1 ? s : s.slice(idx + 1);
}

/* ───────────────────────────────────────────────────────────────────────── */
/* LinesView — common shape across pipe/PTY                                  */
/* ───────────────────────────────────────────────────────────────────────── */

export interface LinesViewOptions {
  /** Default true: strip ANSI control sequences. */
  stripAnsi?: boolean;
  /** Default true: collapse `\r`-overwrites within each line. */
  collapseCr?: boolean;
}

export interface LinesView {
  /** Complete lines, indexed by ring-local position. */
  lines: string[];
  /** Global line number of `lines[0]`. (= firstAvailableLine for pipe mode
   *  and PTY mode after stripping.) */
  firstLineGlobal: number;
  /** Global line number just past `lines[lines.length-1]`. */
  nextLineGlobal: number;
}

/**
 * Build a logical-line view of the command's current buffer.
 *
 * Pipe mode: nearly free — already an array of lines.
 * PTY mode: snapshot + stripAnsi + collapseCr + split('\n'). 2 MB cap means
 * this runs at ~5-15ms typical; cheap enough to do per-request.
 *
 * The first PTY line may be a tail-fragment if the ring was trimmed mid-line;
 * callers that care should compare firstLineGlobal against the original
 * `firstAvailableLine` (they are equal for a clean split, off-by-one means
 * `lines[0]` is a fragment of an older line).
 */
export function getLinesView(cmd: RunningCommand, opts: LinesViewOptions = {}): LinesView {
  const stripAnsiFlag = opts.stripAnsi ?? true;
  const collapseCrFlag = opts.collapseCr ?? true;

  if (cmd.ptyRingBuffer) {
    let snap = cmd.ptyRingBuffer.snapshot();
    if (stripAnsiFlag) snap = stripAnsi(snap);
    const parts = snap.split('\n');
    // Last element is the in-flight partial; we drop it from the line view.
    parts.pop();
    let lines = parts;
    if (collapseCrFlag) {
      lines = lines.map(collapseCarriageReturn);
    }
    return {
      lines,
      firstLineGlobal: cmd.ptyRingBuffer.firstAvailableLine,
      nextLineGlobal: cmd.ptyRingBuffer.firstAvailableLine + lines.length,
    };
  }

  // Pipe mode — outputLines is already line-split.
  let lines = cmd.outputLines.slice();
  if (stripAnsiFlag) lines = lines.map(stripAnsi);
  if (collapseCrFlag) lines = lines.map(collapseCarriageReturn);
  const firstLineGlobal = getFirstAvailableLine(cmd);
  return {
    lines,
    firstLineGlobal,
    nextLineGlobal: firstLineGlobal + lines.length,
  };
}

/* ───────────────────────────────────────────────────────────────────────── */
/* Read operations — all return the same envelope                            */
/* ───────────────────────────────────────────────────────────────────────── */

export interface ReadResult {
  /** Selected lines paired with their global line numbers. */
  matches: Array<{ lineno: number; text: string }>;
  /** Cursor for `--since` continuation: the next unread global line. */
  next: number;
  /** Smallest global line number still in the buffer. */
  firstAvailable: number;
  /** Largest global line number ever written. */
  totalLines: number;
  /** True iff some requested or expected lines fell outside the buffer. */
  truncated: boolean;
}

function emptyResult(view: LinesView): ReadResult {
  return {
    matches: [],
    next: view.nextLineGlobal,
    firstAvailable: view.firstLineGlobal,
    totalLines: view.nextLineGlobal,
    truncated: false,
  };
}

/** Slice the view by ring-local index range `[localStart, localEnd)`. */
function sliceView(
  view: LinesView,
  localStart: number,
  localEnd: number,
  truncated: boolean,
): ReadResult {
  const clampedStart = Math.max(0, Math.min(localStart, view.lines.length));
  const clampedEnd = Math.max(clampedStart, Math.min(localEnd, view.lines.length));
  const matches: Array<{ lineno: number; text: string }> = [];
  for (let i = clampedStart; i < clampedEnd; i++) {
    matches.push({
      lineno: view.firstLineGlobal + i,
      text: view.lines[i],
    });
  }
  return {
    matches,
    next: view.nextLineGlobal,
    firstAvailable: view.firstLineGlobal,
    totalLines: view.nextLineGlobal,
    truncated,
  };
}

/** Read all lines from global line number `since` forward.
 *  `since=0` returns everything currently in the buffer. */
export function readSince(
  cmd: RunningCommand,
  since: number,
  opts: LinesViewOptions = {},
): ReadResult {
  const view = getLinesView(cmd, opts);
  if (view.lines.length === 0) return emptyResult(view);
  const localStart = since - view.firstLineGlobal;
  const truncated = since < view.firstLineGlobal;
  return sliceView(view, Math.max(0, localStart), view.lines.length, truncated);
}

/** Last N complete lines. */
export function readTail(
  cmd: RunningCommand,
  n: number,
  opts: LinesViewOptions = {},
): ReadResult {
  const view = getLinesView(cmd, opts);
  if (view.lines.length === 0) return emptyResult(view);
  const localStart = Math.max(0, view.lines.length - n);
  // truncated semantics: the caller asked for N but only got fewer because
  // (a) we never wrote that many, or (b) older lines were trimmed.
  const truncated = view.firstLineGlobal > 0 && n > view.lines.length;
  return sliceView(view, localStart, view.lines.length, truncated);
}

/** First N complete lines currently in the buffer (= oldest N lines reachable). */
export function readHead(
  cmd: RunningCommand,
  n: number,
  opts: LinesViewOptions = {},
): ReadResult {
  const view = getLinesView(cmd, opts);
  if (view.lines.length === 0) return emptyResult(view);
  // truncated iff older content has fallen out of the ring — the "head" the
  // caller sees is actually the head of the available window, not the
  // beginning of the command's output.
  const truncated = view.firstLineGlobal > 0;
  return sliceView(view, 0, Math.min(n, view.lines.length), truncated);
}

/** Lines in the global range `[lineno - context, lineno + context]`. */
export function readAround(
  cmd: RunningCommand,
  lineno: number,
  context: number,
  opts: LinesViewOptions = {},
): ReadResult {
  const view = getLinesView(cmd, opts);
  if (view.lines.length === 0) return emptyResult(view);
  const wantStart = Math.max(0, lineno - context);
  const wantEnd = lineno + context + 1;
  const localStart = wantStart - view.firstLineGlobal;
  const localEnd = wantEnd - view.firstLineGlobal;
  const truncated = wantStart < view.firstLineGlobal;
  return sliceView(view, Math.max(0, localStart), Math.max(0, localEnd), truncated);
}

export interface GrepOptions extends LinesViewOptions {
  /** Case-insensitive match. */
  ignoreCase?: boolean;
  /** Only scan lines with global lineno >= since (default 0 = scan all). */
  since?: number;
  /** Hard cap on number of matches returned (default 1000). */
  maxMatches?: number;
}

/**
 * Run a regex over the buffer and return matching lines with their global
 * line numbers attached. The regex is applied to the post-strip,
 * post-collapse-cr form of each line so users don't need to fight ANSI codes
 * in their patterns.
 */
export function grepOutput(
  cmd: RunningCommand,
  pattern: string,
  opts: GrepOptions = {},
): ReadResult {
  const view = getLinesView(cmd, opts);
  if (view.lines.length === 0) return emptyResult(view);

  const flags = opts.ignoreCase ? 'i' : '';
  let re: RegExp;
  try {
    re = new RegExp(pattern, flags);
  } catch {
    // Bad regex → return empty rather than crash; caller should validate.
    return emptyResult(view);
  }

  const since = opts.since ?? 0;
  const maxMatches = opts.maxMatches ?? 1000;
  const matches: Array<{ lineno: number; text: string }> = [];

  for (let i = 0; i < view.lines.length; i++) {
    const lineno = view.firstLineGlobal + i;
    if (lineno < since) continue;
    if (re.test(view.lines[i])) {
      matches.push({ lineno, text: view.lines[i] });
      if (matches.length >= maxMatches) break;
    }
  }

  return {
    matches,
    next: view.nextLineGlobal,
    firstAvailable: view.firstLineGlobal,
    totalLines: view.nextLineGlobal,
    truncated: since < view.firstLineGlobal,
  };
}
