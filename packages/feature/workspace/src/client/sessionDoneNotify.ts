'use client';

// packages/feature/workspace/src/client/sessionDoneNotify.ts
//
// "IT FINISHED" — ON THE DESKTOP, NOT JUST IN THE SIDEBAR.
//
// THE REPORT THIS EXISTS FOR. naby can now finish work after the turn that
// started it: a background job runs on, and when it lands the shell dispatches a
// follow-up turn so naby can report (server/lib/backgroundJobReport.ts). That
// report ends the way every run ends — the session goes `unread` and a dot
// appears in a sidebar the user stopped looking at half an hour ago. The whole
// point of backgrounding the work was that they went and did something else.
//
// SO THE SIGNAL IS THE ONE THAT ALREADY EXISTS. `/ws/global-state` pushes the
// recent-session list on every status write, and the transition into `unread` is
// exactly "a run just ended". Nothing new is broadcast, no second channel is
// opened, and a scheduled task, a Telegram-started turn and a background-job
// report all reach this the same way, because they all go through
// `updateGlobalState(…, 'unread')`.
//
// WHY NOT `task-fired`. It is broadcast when a scheduled task STARTS, and the
// run it starts writes `unread` when it ends. Notifying on both would ping twice
// for one piece of work, and the first ping would be about something that has
// not happened yet.
//
// WHAT MUST NOT PRODUCE A BANNER, and this is most of the file:
//
//   1. A SNAPSHOT IS NOT A TRANSITION. The first push after connecting carries
//      every session's current status, and several are legitimately `unread`
//      from yesterday. Firing on those would greet the user with a stack of
//      banners about work they already know about. A session must have been
//      SEEN in another state first.
//   2. THE SCREEN THE USER IS LOOKING AT. If the app is focused and the session
//      that just finished is the one on screen, the answer is already in front
//      of them; a banner about it is noise.
//   3. THE SAME ENDING TWICE. `unread` is written more than once in some paths
//      (a failure teardown, then a status refresh), so only the EDGE counts.
//      Within a single push the same session may also appear twice; one session
//      finishing is one ending however many rows describe it.
//
// WHAT THIS SIDE DOES *NOT* DO IS AGGREGATE. The reported bug is a stack of
// identical banners after a Telegram conversation held away from the PC, and the
// cure is one replaceable banner in the main process carrying a running count
// (electron/notifications.ts). It is tempting to collapse a batch here and send
// "3" across the bridge — that would be wrong twice over. It would let the
// renderer author a number that ends up in an OS-drawn box with this app's name
// on it, breaking the channel's founding rule; and it would UNDERCOUNT, because
// the runs that pile up arrive in separate pushes minutes apart, not in one
// batch. So this side reports each finished run exactly once and main tallies
// them.
//
// It is pure and testable — jsdom cannot draw an OS banner, so the decision is
// the part that gets asserted, and the wiring is pinned by a source assertion.

/** The shape this module needs from a `/ws/global-state` row. Structurally a
 *  subset of `GlobalSession`/`RecentSession`, declared here so the pure rules do
 *  not drag a server type into a unit test. */
export interface SessionStatusRow {
  cwd: string;
  sessionId: string;
  status: string;
  title?: string;
  lastUserMessage?: string;
}

/** The status that means "a run just ended and nobody has looked at it". */
export const DONE_STATUS = 'unread';

/**
 * The sessions that just CROSSED into `unread`, given what we last saw.
 *
 * `previous` is read, never written — the caller owns the map, so the same
 * function serves the hook and a test. A session absent from `previous` is
 * deliberately NOT a transition (rule 1): we have no evidence it changed.
 */
export function newlyDoneSessions(
  previous: ReadonlyMap<string, string>,
  rows: readonly SessionStatusRow[],
): SessionStatusRow[] {
  const out: SessionStatusRow[] = [];
  for (const row of rows) {
    if (!row?.sessionId) continue;
    const before = previous.get(row.sessionId);
    if (before === undefined) continue; // first sighting: a snapshot, not an edge
    if (row.status === DONE_STATUS && before !== DONE_STATUS) out.push(row);
  }
  return out;
}

/** Fold a push into the remembered statuses. Returns a NEW map so a caller can
 *  keep the old one for comparison. */
export function rememberStatuses(
  previous: ReadonlyMap<string, string>,
  rows: readonly SessionStatusRow[],
): Map<string, string> {
  const next = new Map(previous);
  for (const row of rows) {
    if (row?.sessionId) next.set(row.sessionId, row.status);
  }
  return next;
}

/**
 * Whether THIS finished session is worth interrupting the user for.
 *
 * The one suppression (rule 2) is the combination, not either half: an
 * unfocused app is notified about even the session on screen (they cannot see
 * it), and a focused app is still notified about a session in another tab or
 * another project (they cannot see that either).
 */
export function shouldNotifySessionDone(input: {
  sessionId: string;
  appFocused: boolean;
  /** The session the user is actually looking at, if any. */
  visibleSessionId?: string;
}): boolean {
  if (!input.sessionId) return false;
  return !(input.appFocused && input.visibleSessionId === input.sessionId);
}

/**
 * Which of the runs that just finished are actually reported to the desktop, in
 * the order they arrived.
 *
 * The whole per-row decision, lifted out of the hook so the loop that remains
 * there holds no judgement at all — the file's own doctrine is that every
 * decision is pure and this was the last one that was not.
 *
 * TWO RULES, and the second is new:
 *   - suppress what the user is already looking at (`shouldNotifySessionDone`);
 *   - report a session AT MOST ONCE per push. `unread` is written on more than
 *     one path, so a single push can legitimately carry the same session twice;
 *     main counts calls, so a duplicate here would make the banner claim two
 *     conversations finished when one did.
 *
 * Deliberately returns the ROWS rather than a count: main owns the tally, and
 * each row still crosses the bridge as its own bounded label.
 */
export function notifiableFinishedSessions(input: {
  finished: readonly SessionStatusRow[];
  appFocused: boolean;
  /** The session the user is actually looking at, if any. */
  visibleSessionId?: string;
}): SessionStatusRow[] {
  const out: SessionStatusRow[] = [];
  const reported = new Set<string>();
  for (const row of input.finished) {
    if (!row?.sessionId || reported.has(row.sessionId)) continue;
    if (
      !shouldNotifySessionDone({
        sessionId: row.sessionId,
        appFocused: input.appFocused,
        ...(input.visibleSessionId ? { visibleSessionId: input.visibleSessionId } : {}),
      })
    ) {
      continue;
    }
    reported.add(row.sessionId);
    out.push(row);
  }
  return out;
}

/** What the banner names: the session's title, else the last thing the user
 *  asked, else the project folder. Never the full text of anything — the main
 *  process truncates again, and this is a label, not content. */
export function notificationLabel(row: SessionStatusRow): string {
  const title = row.title?.trim();
  if (title) return title;
  const asked = row.lastUserMessage?.trim();
  if (asked) return asked;
  const folder = row.cwd?.split('/').filter(Boolean).pop();
  return folder ?? '';
}

/** The two languages the app has words for. Anything else is English. */
export function notifyLocale(language: string | undefined): 'en' | 'ko' {
  return typeof language === 'string' && language.toLowerCase().startsWith('ko') ? 'ko' : 'en';
}

/**
 * The desktop bridge, when there is one.
 *
 * FEATURE-DETECTED, like `fsOps`: in a plain browser `window.naby` is absent,
 * this answers undefined, and the app falls back to the badge it always had.
 */
type NotifyBridge = {
  sessionDone(input: { locale: 'en' | 'ko'; label: string }): Promise<unknown>;
};

export function desktopNotifications(): NotifyBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  const bridge = (window as unknown as { naby?: { notifications?: NotifyBridge } }).naby;
  return bridge?.notifications;
}

/**
 * Report ONE finished run to the desktop. Swallows everything: a notification
 * that could not be shown must never surface as an error in a chat app.
 *
 * Not "show one banner" any more — main coalesces these into a single banner
 * that replaces its predecessor and counts how many runs it stands for. Calling
 * it once per run is therefore load-bearing, not incidental: the call IS the
 * tally.
 */
export function notifySessionDone(row: SessionStatusRow, language: string | undefined): void {
  const bridge = desktopNotifications();
  if (!bridge) return;
  try {
    void bridge
      .sessionDone({ locale: notifyLocale(language), label: notificationLabel(row) })
      .catch(() => {});
  } catch {
    /* no bridge, no banner, no error */
  }
}
