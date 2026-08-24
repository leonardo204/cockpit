// packages/feature/agent/src/server/lib/telegramChat.ts
//
// TWO-WAY CHAT OVER TELEGRAM (specs/telegram-chat.md).
//
// The escalation bridge already let the phone ANSWER naby. This module lets the
// phone TALK to it: `/sessions` lists the recent sessions, `/use 2` links one to
// the chat, and from then on every plain message is a turn in that session whose
// answer comes back as a message.
//
// WHY COMMANDS AND NOT NATURAL LANGUAGE (§1). Parsing "이 세션 연결해" means a
// misread is a wrong action — connecting the wrong session, or starting a turn
// that was meant as control. Telegram's own "/" commands are deterministic AND
// more discoverable (they autocomplete from the bot menu, see `setMyCommands`),
// so control is commands and conversation is plain text, with no overlap to get
// wrong.
//
// STRUCTURE. Everything here is either PURE (parse / render / expiry) or takes
// its IO through `ChatDeps` — sending, dispatching a turn, asking whether a run
// is live. The polling loop in telegramEscalation.ts builds the real deps; the
// tests build fakes, which is why no test in this file needs a model, a database
// or a socket. The heavy engine imports live behind `chatRuntimeDeps()`, loaded
// lazily so that merely importing the bridge does not pull the whole runtime in.
//
// SECURITY (§6). The configured chat_id is the ONLY authentication. Every
// update from any other chat is dropped before a single character of it is read
// as a command, because a turn here is arbitrary work on the user's machine.

import { defaultSessionName, projectNameFromCwd } from '@cockpit/shared-utils';
import { logActivity } from '../../../../../../../dist/naby-runtime.mjs';
import type { SessionRef, Store } from '../../../../../../../dist/naby-runtime.mjs';
import { formatFinalReport, truncate } from './telegramEscalation';
import { projectDisplayName, projectDisplayNames } from './projectDisplayName';
import { startProgressReporter, type ProgressIo } from './telegramProgress';
import type { TelegramConfig, TelegramUpdate } from './telegram';
import { BOT_COMMANDS, formatAge, STR, type ProjectLine, type SessionLine } from './telegramChatStrings';

// -- settings keys ------------------------------------------------------------

/** The chat's linked session (§3). One chat_id, so one link. */
export const TELEGRAM_LINK_KEY = 'telegram.link';
/** The ids behind the numbers of the last `/sessions` answer (§2). */
export const TELEGRAM_SESSION_LIST_KEY = 'telegram.sessionList';
/** Same, for `/projects` — the numbers `/new N` resolves against. */
export const TELEGRAM_PROJECT_LIST_KEY = 'telegram.projectList';

/** How long a link survives without activity (§3). Judged ON ARRIVAL, never by a
 *  timer: a background job that exists only to forget something is a cost paid
 *  every minute for an event that happens once. */
export const TELEGRAM_LINK_IDLE_MS = 60 * 60_000;

/** How many sessions/projects a list shows. A phone screen, not a report. */
export const LIST_SIZE = 8;

/** A turn that outlives this gets ONE "작업 중..." message (§4) — enough to say
 *  the silence is work, few enough not to become noise. */
export const TELEGRAM_INTERIM_MS = 60_000;

/** How long the chat waits for a dispatched turn before giving up on reporting
 *  it. Mirrors the scheduled-task deadline. */
export const TELEGRAM_TURN_DEADLINE_MS = 30 * 60_000;

/** Answer preview cap — the same 1200 chars the final report uses. */
const ANSWER_PREVIEW_CHARS = 1200;

// -- link state (pure over the store) ----------------------------------------

export type TelegramLink = {
  sessionId: string;
  /** epoch ms */
  linkedAt: number;
  /** epoch ms — the idle clock (§3). */
  lastActivityAt: number;
  /** Which list render the number came from; diagnostic, see `ListState`. */
  listEpoch?: number;
};

export function readLink(store: Store): TelegramLink | undefined {
  const raw = store.getSetting(TELEGRAM_LINK_KEY);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<TelegramLink>;
    if (typeof parsed.sessionId !== 'string' || !parsed.sessionId) return undefined;
    return {
      sessionId: parsed.sessionId,
      linkedAt: typeof parsed.linkedAt === 'number' ? parsed.linkedAt : 0,
      lastActivityAt: typeof parsed.lastActivityAt === 'number' ? parsed.lastActivityAt : 0,
      ...(typeof parsed.listEpoch === 'number' ? { listEpoch: parsed.listEpoch } : {}),
    };
  } catch {
    // A corrupt setting means "no link", never a crashed poll loop.
    return undefined;
  }
}

export function writeLink(store: Store, link: TelegramLink): void {
  store.setSetting(TELEGRAM_LINK_KEY, JSON.stringify(link));
}

export function clearLink(store: Store): void {
  store.setSetting(TELEGRAM_LINK_KEY, '');
}

/**
 * REPOINT THE LINK when the session it names was continued in a new tab
 * (session-context-management §2.2).
 *
 * The link is what makes a plain phone message a turn, and it names ONE session
 * id. When that conversation is continued elsewhere, the desktop moves and the
 * phone does not: every reply typed on the phone would keep landing in the
 * session the user just left, for up to the idle window (an hour) — answered by
 * an agent with none of the context the continuation carries.
 *
 * ONLY WHEN IT ACTUALLY POINTS AT THE OLD SESSION. A link the user set to some
 * other conversation is their choice, and a continuation happening in a third
 * session is no reason to steal the phone away from it. `false` = nothing to do,
 * which is the ordinary case (most machines have no Telegram link at all).
 *
 * `linkedAt` is preserved because the link is the same link; `lastActivityAt` is
 * stamped because continuing IS activity — a link about to expire should not die
 * a second after being moved.
 */
export function repointLink(
  store: Store,
  fromSessionId: string,
  toSessionId: string,
  now: number = Date.now(),
): boolean {
  const link = readLink(store);
  if (!link || link.sessionId !== fromSessionId) return false;
  writeLink(store, { ...link, sessionId: toSessionId, lastActivityAt: now });
  return true;
}

/** True when the link has gone quiet for longer than the idle window (§3). */
export function isLinkExpired(link: TelegramLink, now: number): boolean {
  return now - link.lastActivityAt >= TELEGRAM_LINK_IDLE_MS;
}

// -- list state (the numbers the user is looking at) --------------------------

export type ListState = {
  /** The ids in the order they were shown; index 0 is the number 1. */
  ids: string[];
  /** Monotonic per render, so a stale answer is recognizable as stale. */
  epoch: number;
};

function readList(store: Store, key: string): ListState | undefined {
  const raw = store.getSetting(key);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<ListState>;
    if (!Array.isArray(parsed.ids)) return undefined;
    return { ids: parsed.ids.map(String), epoch: typeof parsed.epoch === 'number' ? parsed.epoch : 0 };
  } catch {
    return undefined;
  }
}

function writeList(store: Store, key: string, ids: string[]): ListState {
  const prev = readList(store, key);
  const next: ListState = { ids, epoch: (prev?.epoch ?? 0) + 1 };
  store.setSetting(key, JSON.stringify(next));
  return next;
}

/**
 * Resolve `N` against the list the user was looking at (§2).
 *
 * THE STALENESS RULE. The ids are stored, so a number can never resolve to a
 * session it did not name. But the list MOVES — every turn re-sorts it by last
 * use — so a number typed against yesterday's screen names something the user is
 * no longer thinking about. When the stored list no longer matches what the
 * command would show right now, the number is refused and the FRESH list is
 * shown in the same breath: a one-step recovery instead of a dead end.
 */
export function resolveListPick(
  stored: ListState | undefined,
  currentIds: readonly string[],
  n: number,
): { ok: true; id: string } | { ok: false; reason: 'none' | 'stale' | 'range'; max: number } {
  if (!stored || stored.ids.length === 0) return { ok: false, reason: 'none', max: currentIds.length };
  const fresh =
    stored.ids.length === currentIds.length && stored.ids.every((id, i) => id === currentIds[i]);
  if (!fresh) return { ok: false, reason: 'stale', max: currentIds.length };
  if (!Number.isInteger(n) || n < 1 || n > stored.ids.length) {
    return { ok: false, reason: 'range', max: stored.ids.length };
  }
  return { ok: true, id: stored.ids[n - 1]! };
}

// -- command parsing (pure) ---------------------------------------------------

export type ChatCommandName =
  | 'sessions'
  | 'use'
  | 'new'
  | 'projects'
  | 'status'
  | 'stop'
  | 'start'
  | 'help';

export type ParsedCommand =
  | { cmd: ChatCommandName; args: string[] }
  | { cmd: 'unknown'; name: string; args: string[] };

const KNOWN: ReadonlySet<string> = new Set<ChatCommandName>([
  'sessions',
  'use',
  'new',
  'projects',
  'status',
  'stop',
  'start',
  'help',
]);

/**
 * Read a message as a "/" command, or `undefined` when it is ordinary text.
 *
 * STRICT ON PURPOSE: a leading "/" and a known verb, nothing else. Anything that
 * merely mentions a command ("/status 봐줘" is fine, "status?" is not) stays
 * conversation, because guessing here means either swallowing a message the user
 * meant to send or running a command they did not.
 *
 * A leading "/" with an UNKNOWN verb is reported as `unknown` rather than sent to
 * the model — on Telegram a "/" is always a command attempt, and answering a typo
 * with a model turn is the confusing outcome.
 */
export function parseTelegramCommand(text: string | undefined): ParsedCommand | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return undefined;
  const [head, ...args] = trimmed.slice(1).split(/\s+/);
  if (!head) return undefined;
  // Telegram appends `@botname` when several bots share a chat.
  const name = head.split('@')[0]!.toLowerCase();
  // A command name is `[A-Za-z0-9_]{1,32}` and nothing else. Anything wider is
  // not a typo'd command, it is TEXT that happens to start with a slash — an
  // absolute path most of the time — and answering "/Users/me/x 이거 봐줘" with a
  // help hint would swallow a message the user meant for the session.
  if (!/^[a-z0-9_]{1,32}$/.test(name)) return undefined;
  if (!KNOWN.has(name)) return { cmd: 'unknown', name, args };
  return { cmd: name as ChatCommandName, args };
}

/** The `N` of `/use 3`, or undefined when it is missing or not a plain number. */
export function parseIndexArg(args: readonly string[]): number | undefined {
  const raw = args[0];
  if (!raw) return undefined;
  const m = raw.match(/^([1-9]\d?)[.)]?$/);
  return m ? Number(m[1]) : undefined;
}

// -- rendering (pure) ---------------------------------------------------------

/** The project label for a LIST ROW: the folder name, or undefined so the row
 *  can leave the ` · project` suffix off entirely. A full path is unreadable on
 *  a phone and identical for every session in the same tree.
 *
 *  The basename itself is `projectNameFromCwd` — one implementation shared with
 *  the client — and the undefined is this function's only remaining job. Where
 *  the store is in hand, prefer `projectDisplayName`, which lets a project the
 *  user renamed answer by its own name. */
export function projectLabel(cwd: string | undefined): string | undefined {
  return projectNameFromCwd(cwd) || undefined;
}

/**
 * A session's display title: its own, or — for a session nobody has named — the
 * same default name every other surface shows it under.
 *
 * IT USED TO BE A PIECE OF THE ID (`(제목 없음) s-mt167d`), which is the worst
 * label a phone can be handed: unreadable, unsayable, and identical-looking to
 * the next one. `/new` answers with this string the instant it mints a session,
 * so it was also the FIRST thing the user saw of a session they had just asked
 * for. `defaultSessionName` is computed from the same two facts the tab strip
 * and the session lists compute it from, so the name on the phone is the name
 * on the screen.
 */
export function sessionTitle(s: Pick<SessionRef, 'sessionId' | 'title' | 'createdAt'>): string {
  const t = (s.title ?? '').trim();
  return t.length > 0 ? truncate(t, 48) : defaultSessionName(s.sessionId, s.createdAt);
}

/** `labelFor` lets the caller hand in the store-aware namer so a renamed project
 *  reads the same here as it does in every other message. It defaults to the
 *  folder name, which keeps this function pure and testable on its own. */
export function renderSessionList(
  sessions: readonly SessionRef[],
  now: number,
  labelFor: (cwd: string | undefined) => string = (cwd) => projectNameFromCwd(cwd),
): string {
  if (sessions.length === 0) return STR.noSessions;
  const lines: SessionLine[] = sessions.map((s, i) => {
    const project = labelFor(s.cwd).trim();
    return {
      n: i + 1,
      title: sessionTitle(s),
      ...(project ? { project } : {}),
      age: formatAge(Math.max(0, now - s.lastUsedAt)),
    };
  });
  return STR.sessionList(lines);
}

export function renderProjectList(
  projects: readonly { cwd: string; title?: string }[],
): string {
  if (projects.length === 0) return STR.noProjects;
  const lines: ProjectLine[] = projects.map((p, i) => ({
    n: i + 1,
    title: p.title?.trim() || projectLabel(p.cwd) || p.cwd,
    cwd: p.cwd,
  }));
  return STR.projectList(lines);
}

// -- the turn's answer, read back out of the run ------------------------------

export type TurnResult = {
  ok: boolean;
  text?: string;
  error?: string;
  durationMs?: number;
  numTurns?: number;
};

/**
 * The answer a finished run produced, read from the events the run registry
 * kept. PURE so the mapping from "a pile of engine events" to "what to say on a
 * phone" is testable without an engine.
 *
 * The LAST terminal `result` is the answer: an autonomous run emits one per step
 * and suppresses all but the final one, and a stopped run gets a synthesized one
 * — either way the last is the one that describes the turn as a whole.
 */
export function extractRunAnswer(events: readonly unknown[]): TurnResult {
  let out: TurnResult | undefined;
  let firstError: string | undefined;
  for (const raw of events) {
    if (!raw || typeof raw !== 'object') continue;
    const ev = raw as { type?: string; is_error?: boolean; result?: unknown; error?: unknown; duration_ms?: unknown; num_turns?: unknown };
    if (ev.type === 'error' && firstError === undefined && typeof ev.error === 'string') {
      firstError = ev.error;
    }
    if (ev.type !== 'result') continue;
    const text = typeof ev.result === 'string' ? ev.result : '';
    out = {
      ok: ev.is_error !== true,
      ...(text ? { text } : {}),
      ...(typeof ev.duration_ms === 'number' ? { durationMs: ev.duration_ms } : {}),
      ...(typeof ev.num_turns === 'number' ? { numTurns: ev.num_turns } : {}),
    };
    if (ev.is_error === true) out.error = text || firstError || 'run failed';
  }
  if (out) return out;
  return { ok: false, error: firstError ?? 'run ended without a result' };
}

/** The chat's version of the final report. Same 1200-char cap and the same
 *  success/failure framing as the escalation report — it IS `formatFinalReport`,
 *  minus the autonomy fields a chat turn does not report.
 *
 *  `project` is passed through so the answer opens with the same project line as
 *  every other outbound message (§0). Undefined omits the line. */
export function formatChatAnswer(result: TurnResult, project?: string): string {
  return formatFinalReport({
    ok: result.ok,
    ...(project !== undefined ? { project } : {}),
    ...(result.text ? { text: truncate(result.text, ANSWER_PREVIEW_CHARS) } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.durationMs != null ? { durationMs: result.durationMs } : {}),
    ...(result.numTurns != null ? { numTurns: result.numTurns } : {}),
  });
}

// -- the deps seam ------------------------------------------------------------

export type ChatDeps = {
  store: Store;
  /** Sends to the configured chat and reports the message_id back, which is what
   *  makes a later reply routable to this session. */
  send: (text: string) => Promise<{ ok: true; messageId: number } | { ok: false; error: string }>;
  /** Start a turn and resolve when it has ended. `project` is the already-resolved
   *  display name, handed down so the progress reporter can print it without a
   *  second store lookup per turn. */
  runTurn: (opts: {
    sessionId: string;
    cwd?: string;
    text: string;
    project?: string;
  }) => Promise<TurnResult>;
  /** Is a run live on this session right now (the 409 guard's question)? */
  isBusy: (sessionId: string) => boolean;
  /** Remember which session a bot message belongs to (reply routing, §1.3). */
  rememberMessage: (messageId: number, sessionId: string) => void;
  /** Which session an earlier bot message belongs to, if we still know. */
  sessionForMessage: (messageId: number) => string | undefined;
  now: () => number;
  /** Overridable for tests; production waits the full minute. */
  interimMs?: number;
  /** `runTurn` reports its own progress live (§4.1), so the one-shot interim
   *  message below is redundant and would be a second "still working" balloon a
   *  minute into a turn the user is already watching. Set by the production deps
   *  that wire the reporter; absent everywhere else, which keeps the interim as
   *  the fallback for a deps set with no live channel. */
  liveProgress?: boolean;
};

/** What the handler did — returned for the loop's log and the tests, never sent. */
export type ChatOutcome = {
  kind: 'ignored' | 'command' | 'notice' | 'turn';
  /** The reply text, when one was sent. */
  reply?: string;
  /** The session a turn was dispatched on. */
  sessionId?: string;
};

// -- the handler --------------------------------------------------------------

/**
 * Apply one message update to the chat (§1, priorities 2–4). The approval and
 * check-in interpretation happens BEFORE this in the bridge loop and never
 * reaches here — an answer to a pending question outranks everything.
 */
export async function handleChatUpdate(
  deps: ChatDeps,
  cfg: Pick<TelegramConfig, 'chatId'>,
  update: TelegramUpdate,
): Promise<ChatOutcome> {
  const msg = update.message;
  if (!msg) return { kind: 'ignored' };

  // §6: the configured chat is the only authenticated one. An update from any
  // other chat — or one that names no chat at all — is dropped before its text
  // is looked at, because the next thing this function does with text is run it.
  const from = msg.chat?.id;
  if (from === undefined || String(from) !== String(cfg.chatId)) return { kind: 'ignored' };

  // EVERY AUTHENTICATED INBOUND MESSAGE (naby-activity-log §3). Logged here,
  // after the chat check and before any branch, so one line exists per message
  // the bridge accepted — whether it becomes a command, a turn, or a notice.
  logActivity('telegram_in', {
    chatId: String(from),
    messageId: msg.message_id,
    ...(msg.reply_to_message?.message_id !== undefined
      ? { replyTo: msg.reply_to_message.message_id }
      : {}),
    text: typeof msg.text === 'string' ? msg.text : '',
    ...(msg.photo ? { hasPhoto: true } : {}),
    ...(msg.document ? { hasDocument: true } : {}),
  });

  const text = typeof msg.text === 'string' ? msg.text.trim() : '';
  if (!text) {
    // A photo or a file is a message the user expects an answer to; silence
    // reads as "the bot is broken" (§8: text only, for now).
    if (msg.photo || msg.document) return reply(deps, STR.textOnly, 'notice');
    return { kind: 'ignored' };
  }

  const command = parseTelegramCommand(text);
  if (command) return handleCommand(deps, command);

  // §1.3 — a reply to one of the bot's own messages goes to THAT message's
  // session, whatever the chat is currently linked to. This is what makes an
  // hours-old report answerable without re-linking.
  const repliedTo = msg.reply_to_message?.message_id;
  if (repliedTo !== undefined) {
    const target = deps.sessionForMessage(repliedTo);
    if (target) return startTurn(deps, target, text);
  }

  // §1.4 — plain text is a turn in the linked session.
  const link = readLink(deps.store);
  if (!link) return reply(deps, STR.notLinked, 'notice');
  if (isLinkExpired(link, deps.now())) {
    clearLink(deps.store);
    return reply(deps, STR.expired, 'notice');
  }
  if (!deps.store.getSession(link.sessionId)) {
    clearLink(deps.store);
    return reply(deps, STR.sessionGone, 'notice');
  }
  writeLink(deps.store, { ...link, lastActivityAt: deps.now() });
  return startTurn(deps, link.sessionId, text);
}

async function reply(deps: ChatDeps, text: string, kind: ChatOutcome['kind']): Promise<ChatOutcome> {
  const sent = await deps.send(text);
  if (!sent.ok) console.warn(`[telegram] chat reply failed: ${sent.error}`);
  return { kind, reply: text };
}

// -- commands -----------------------------------------------------------------

async function handleCommand(deps: ChatDeps, command: ParsedCommand): Promise<ChatOutcome> {
  const now = deps.now();
  switch (command.cmd) {
    case 'start':
    case 'help':
      return reply(deps, STR.help, 'command');

    case 'sessions': {
      const sessions = listSessions(deps.store);
      if (sessions.length === 0) return reply(deps, STR.noSessions, 'command');
      writeList(deps.store, TELEGRAM_SESSION_LIST_KEY, sessions.map((s) => s.sessionId));
      // One projects read for the whole screen — see `projectDisplayNames`.
      return reply(deps, renderSessionList(sessions, now, projectDisplayNames(deps.store)), 'command');
    }

    case 'projects': {
      const projects = listProjects(deps.store);
      if (projects.length === 0) return reply(deps, STR.noProjects, 'command');
      writeList(deps.store, TELEGRAM_PROJECT_LIST_KEY, projects.map((p) => p.cwd));
      return reply(deps, renderProjectList(projects), 'command');
    }

    case 'use':
      return handleUse(deps, command.args, now);

    case 'new':
      return handleNew(deps, command.args, now);

    case 'status':
      return handleStatus(deps, now);

    case 'stop': {
      clearLink(deps.store);
      return reply(deps, STR.unlinked, 'command');
    }

    default:
      return reply(deps, STR.unknownCommand(command.name), 'command');
  }
}

async function handleUse(deps: ChatDeps, args: string[], now: number): Promise<ChatOutcome> {
  const n = parseIndexArg(args);
  if (n === undefined) return reply(deps, STR.useNeedsNumber, 'command');
  const sessions = listSessions(deps.store);
  const picked = resolveListPick(
    readList(deps.store, TELEGRAM_SESSION_LIST_KEY),
    sessions.map((s) => s.sessionId),
    n,
  );
  if (!picked.ok) {
    if (picked.reason === 'range') return reply(deps, STR.outOfRange(picked.max), 'command');
    // 'none' and 'stale' are the same recovery: show the CURRENT list, with the
    // numbers that are true right now, and let the user pick again.
    if (sessions.length === 0) return reply(deps, STR.noSessions, 'command');
    writeList(deps.store, TELEGRAM_SESSION_LIST_KEY, sessions.map((s) => s.sessionId));
    return reply(
      deps,
      `${STR.staleList}\n\n${renderSessionList(sessions, now, projectDisplayNames(deps.store))}`,
      'command',
    );
  }
  const session = deps.store.getSession(picked.id);
  if (!session) {
    // Deleted between the list and the pick.
    return reply(deps, STR.sessionGone, 'command');
  }
  linkSession(deps, session, now);
  return reply(
    deps,
    STR.linked(sessionTitle(session), projectDisplayName(deps.store, session.cwd) || undefined),
    'command',
  );
}

async function handleNew(deps: ChatDeps, args: string[], now: number): Promise<ChatOutcome> {
  const projects = listProjects(deps.store);
  let cwd: string | undefined;
  const n = parseIndexArg(args);
  if (n !== undefined) {
    const picked = resolveListPick(
      readList(deps.store, TELEGRAM_PROJECT_LIST_KEY),
      projects.map((p) => p.cwd),
      n,
    );
    if (!picked.ok) {
      if (picked.reason === 'range') return reply(deps, STR.outOfRange(picked.max), 'command');
      if (projects.length === 0) return reply(deps, STR.noProjects, 'command');
      writeList(deps.store, TELEGRAM_PROJECT_LIST_KEY, projects.map((p) => p.cwd));
      return reply(deps, `${STR.staleList}\n\n${renderProjectList(projects)}`, 'command');
    }
    cwd = picked.id;
  } else {
    // No argument: the most recent project, which is what "새 세션" means to
    // someone who was just working in one. A projectless session is valid, so an
    // empty project list is not an error.
    cwd = projects[0]?.cwd;
  }
  // providerId is left empty exactly as the engine does when it mints a session:
  // it records whoever actually answers, on the first turn.
  const session = deps.store.createSession('', undefined, cwd);
  linkSession(deps, session, now);
  return reply(
    deps,
    STR.created(sessionTitle(session), projectDisplayName(deps.store, session.cwd ?? cwd) || undefined),
    'command',
  );
}

async function handleStatus(deps: ChatDeps, now: number): Promise<ChatOutcome> {
  const link = readLink(deps.store);
  if (!link) return reply(deps, STR.notLinked, 'command');
  const session = deps.store.getSession(link.sessionId);
  if (!session) {
    clearLink(deps.store);
    return reply(deps, STR.sessionGone, 'command');
  }
  if (isLinkExpired(link, now)) {
    clearLink(deps.store);
    return reply(deps, STR.expired, 'command');
  }
  return reply(
    deps,
    STR.statusLinked({
      title: sessionTitle(session),
      ...(projectDisplayName(deps.store, session.cwd)
        ? { project: projectDisplayName(deps.store, session.cwd) }
        : {}),
      idle: formatAge(Math.max(0, now - link.lastActivityAt)),
      running: deps.isBusy(link.sessionId),
    }),
    'command',
  );
}

function linkSession(deps: ChatDeps, session: SessionRef, now: number): void {
  writeLink(deps.store, { sessionId: session.sessionId, linkedAt: now, lastActivityAt: now });
}

function listSessions(store: Store): SessionRef[] {
  try {
    return store.listSessions().slice(0, LIST_SIZE);
  } catch (e) {
    console.warn('[telegram] could not list sessions:', e);
    return [];
  }
}

function listProjects(store: Store): { cwd: string; title?: string }[] {
  try {
    return store.listProjects().slice(0, LIST_SIZE);
  } catch (e) {
    console.warn('[telegram] could not list projects:', e);
    return [];
  }
}

// -- the turn -----------------------------------------------------------------

/**
 * Run one incoming message as a turn on `sessionId` and report the answer (§4).
 *
 * NOT QUEUED (§4). A session already running gets the busy notice and the message
 * is dropped: the running turn will report itself when it ends, and a queue would
 * mean messages executing minutes after they were sent, against a state the user
 * has stopped thinking about.
 */
async function startTurn(deps: ChatDeps, sessionId: string, text: string): Promise<ChatOutcome> {
  // `isBusy` covers BOTH the run registry (a turn started from the app) and the
  // chat's own in-flight mark (a turn started here whose run has not registered
  // yet) — see the bridge's deps. There is no await between this check and the
  // mark inside `runTurn`, so two messages a second apart cannot both pass.
  if (deps.isBusy(sessionId)) {
    return reply(deps, STR.busy, 'notice');
  }
  const session = deps.store.getSession(sessionId);
  if (!session) {
    // Only reachable on the reply-routed path (the linked path checked already).
    return reply(deps, STR.sessionGone, 'notice');
  }

  // §0 — resolved ONCE per turn and used twice: the live progress message and
  // the answer. Both must name the same project, and a turn is the unit over
  // which a rename cannot happen mid-flight in any way the user would notice.
  const project = projectDisplayName(deps.store, session.cwd);

  // The one interim message, cancelled the moment the turn ends so a fast turn
  // never sends it. Skipped entirely when the turn reports itself live (§4.1).
  let interim: ReturnType<typeof setTimeout> | undefined = deps.liveProgress
    ? undefined
    : setTimeout(() => {
        interim = undefined;
        void deps.send(STR.working);
      }, deps.interimMs ?? TELEGRAM_INTERIM_MS);

  try {
    console.log(`[telegram] chat turn → session ${sessionId} (from Telegram)`);
    const result = await deps.runTurn({
      sessionId,
      ...(session.cwd ? { cwd: session.cwd } : {}),
      text,
      project,
    });
    const answer = formatChatAnswer(result, project);
    const sent = await deps.send(answer);
    if (sent.ok) {
      // The answer is now a reply target: replying to it comes back HERE (§1.3).
      deps.rememberMessage(sent.messageId, sessionId);
    } else {
      console.warn(`[telegram] chat answer failed: ${sent.error}`);
    }
    // The turn IS activity: without this the idle clock would run from the last
    // message the user typed, expiring a link in the middle of a long exchange.
    const link = readLink(deps.store);
    if (link?.sessionId === sessionId) {
      writeLink(deps.store, { ...link, lastActivityAt: deps.now() });
    }
    return { kind: 'turn', sessionId, reply: answer };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return reply(deps, STR.dispatchFailed(why), 'notice');
  } finally {
    if (interim) clearTimeout(interim);
  }
}

// -- the real deps (lazy, so importing the bridge stays cheap) ----------------

/**
 * The production IO: dispatch through the SAME orchestrator an interactive turn
 * uses (system assembly, memory/skill injection, the gate, growth observation —
 * all of it identical, §4), then wait for the run to leave the registry and read
 * its answer out.
 *
 * The engine modules are imported HERE, inside the call, on purpose: the bridge
 * is imported by every paused turn, and a static import would drag the whole
 * runtime (and its database) into contexts that only ever wanted to send a
 * message.
 */
export async function chatRuntimeDeps(
  progressIo?: ProgressIo,
): Promise<Pick<ChatDeps, 'runTurn' | 'isBusy' | 'liveProgress'>> {
  const [{ dispatchChat }, { nabySpec }, hub] = await Promise.all([
    import('../engines/orchestrator'),
    import('../engines/naby'),
    import('../sessionRunHub'),
  ]);
  return {
    isBusy: (sessionId: string) => hub.isRunActive(sessionId),
    ...(progressIo ? { liveProgress: true } : {}),
    runTurn: async ({ sessionId, cwd, text, project }) => {
      const outcome = await dispatchChat(nabySpec, {
        // Descriptive only — it is what the activity log stamps on the turn so a
        // line in the file says the phone asked, not the app.
        source: 'telegram',
        // Stored VERBATIM. The transcript is the record of what the user said,
        // and a "[telegram]" prefix baked into the prompt would be a change to
        // the message itself — the origin belongs in the log line above, not in
        // the user's words.
        prompt: text,
        sessionId,
        ...(cwd ? { cwd } : {}),
        engine: 'naby',
      });
      if (!outcome.ok) {
        return { ok: false, error: `${outcome.error} (${outcome.status})` };
      }
      const key = outcome.runKey;

      // LIVE PROGRESS (§4.1). The wait below is a poll — it only asks whether the
      // run is still alive — so the reporter rides the event STREAM instead:
      // `addRunListener` is the same fan-out an attached browser tab consumes.
      //
      // Subscribed BEFORE the snapshot is read, then fed whatever the snapshot
      // already held, deduped by object identity (the hub hands back the very
      // same event objects). Doing it the other way round would drop anything the
      // run emitted in the gap between the two calls.
      const reporter = progressIo
        ? startProgressReporter(progressIo, { project: project ?? '' })
        : undefined;
      let unsubscribe: (() => void) | undefined;
      if (reporter) {
        const seen = new Set<unknown>();
        unsubscribe = hub.addRunListener(key, (ev) => {
          if (seen.has(ev.message)) return;
          seen.add(ev.message);
          reporter.onEvent(ev.message);
        });
        for (const message of hub.getRunSnapshot(key)?.events ?? []) {
          if (seen.has(message)) continue;
          seen.add(message);
          reporter.onEvent(message);
        }
      }

      try {
        const deadline = Date.now() + TELEGRAM_TURN_DEADLINE_MS;
        while (hub.isRunActive(key) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 500));
        }
        if (hub.isRunActive(key)) {
          hub.requestStop(key);
          return { ok: false, error: 'turn timed out after 30m' };
        }
        const snap = hub.getRunSnapshot(key);
        if (!snap) return { ok: false, error: 'the run left no result' };
        return extractRunAnswer(snap.events);
      } finally {
        // Both, on every path including the timeout: an orphaned listener would
        // keep feeding a reporter whose turn is over, and a progress message
        // left saying "작업 중" under a finished answer is worse than none.
        unsubscribe?.();
        await reporter?.finish();
      }
    },
  };
}

/** Re-exported so the bridge registers the menu without importing the strings. */
export { BOT_COMMANDS };
