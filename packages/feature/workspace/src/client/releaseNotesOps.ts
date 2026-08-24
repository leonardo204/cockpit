/**
 * releaseNotesOps — every DECISION the "what changed" popup makes, as pure
 * functions.
 *
 * The component around them is a portal, a fetch of two strings over the
 * preload bridge and a markdown renderer. Everything that can be WRONG is here:
 * comparing two versions, deciding whether an upgrade even happened, and
 * picking the entries that fall in the gap. None of it touches the DOM, so it
 * runs in vitest's default node environment.
 *
 * THE FIVE RULES, and the order they are applied in:
 *
 *   1. SHOW ONLY WHEN THE VERSION WENT UP. Compared numerically, never as
 *      strings — `'1.9.0' < '1.10.0'` is false lexicographically and true in
 *      every sense that matters here.
 *   2. NEVER ON A FRESH INSTALL. A brand-new installation has nothing to be
 *      told about; the current version is recorded silently and nothing is
 *      shown. This is the rule implementations get wrong, and getting it wrong
 *      is loud: a new user's first impression is a changelog for software they
 *      have never run.
 *   2b. AN EXISTING INSTALLATION WITH NO WATERMARK HEARS ABOUT THE VERSION IT IS
 *      RUNNING. This is the OTHER way to get rule 2 wrong, and it is the way
 *      this file got it wrong first: "no watermark" was read as "brand-new
 *      user", so the very launch the feature was built for — the first one
 *      after updating into the build that introduced it — was the one launch
 *      that said nothing, for EVERY existing user at once. The two cases are
 *      distinguishable, and `freshInstall` is the caller saying which is which
 *      rather than this function guessing (see `planWhatsNew`).
 *   3. ONCE PER VERSION. Dismissal records the version that was shown, which is
 *      why `record` is part of the answer rather than something the caller
 *      invents.
 *   4. A SKIPPED RANGE LOSES NOTHING. 1.22.0 → 1.25.0 yields every entry above
 *      1.22.0 and up to 1.25.0, newest first, in one scrollable modal — not
 *      just the newest, and not a four-step wizard the user has to click
 *      through. The newest entry is what they are most likely to care about, so
 *      it is on screen first and the rest is a scroll away.
 *   5. NOTHING WHILE THE SETUP WIZARD IS UP. `onboarded` is the second signal
 *      the caller passes in, for the same reason as the first: the guard was a
 *      hand-written `return` in the gate, which no test on values could reach.
 */

/**
 * The version main reports when it has no Electron app context to ask
 * (`electron/ipc.ts` `safeAppVersion`). It is a real, parseable version string,
 * so it has to be excluded by NAME rather than by parse failure: treated as an
 * ordinary version it would be recorded as a fresh install's watermark, and the
 * next launch under a real app context would then read as an upgrade from
 * nothing and show the entire archive.
 */
export const UNKNOWN_VERSION = '0.0.0';

// ─────────────────────────────────────────────────────────
// Versions
// ─────────────────────────────────────────────────────────

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated pre-release identifiers, empty for a normal release. */
  prerelease: string[];
}

const NUMERIC = /^\d+$/;

/**
 * `1.25.0`, `v1.25.0`, `1.25`, `1.25.0-beta.2`, `1.25.0+build.7`.
 *
 * TOTAL BY DESIGN: anything it cannot read is `null`, and every caller here
 * treats `null` as "say nothing". A changelog heading someone typed as
 * `## next` must not become an exception on the startup path.
 *
 * Missing components are zero (`1.25` is `1.25.0`) because a human writing a
 * heading by hand will eventually drop one, and reading it as 1.25.0 is the
 * only interpretation that is not surprising.
 */
export function parseVersion(raw: string | null | undefined): ParsedVersion | null {
  if (typeof raw !== 'string') return null;
  // Build metadata is explicitly NOT part of precedence (semver §10), so it is
  // discarded before anything else looks at the string.
  const cleaned = raw.trim().replace(/^v/i, '').split('+')[0] ?? '';
  if (!cleaned) return null;

  const [core, ...rest] = cleaned.split('-');
  const prerelease = rest.join('-');
  const parts = (core ?? '').split('.');
  if (parts.length === 0 || parts.length > 3) return null;

  const nums: number[] = [];
  for (const part of parts) {
    if (!NUMERIC.test(part)) return null;
    const n = Number(part);
    if (!Number.isSafeInteger(n)) return null;
    nums.push(n);
  }

  return {
    major: nums[0] ?? 0,
    minor: nums[1] ?? 0,
    patch: nums[2] ?? 0,
    prerelease: prerelease ? prerelease.split('.').filter((id) => id.length > 0) : [],
  };
}

/**
 * -1 / 0 / 1, or `null` when either side is unreadable.
 *
 * `null` rather than a silent 0, because "these versions are equal" and "I
 * cannot tell" lead to different behaviour: the first is a normal no-show, the
 * second must also refuse to WRITE a watermark it cannot reason about.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;

  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }

  // Semver §11.3: a pre-release is LOWER than the release it precedes, so
  // 1.25.0-beta.1 → 1.25.0 is an upgrade and shows 1.25.0's notes.
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;

  const len = Math.max(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < len; i += 1) {
    const l = left.prerelease[i];
    const r = right.prerelease[i];
    // A shorter set of identifiers has lower precedence when all the preceding
    // ones are equal (semver §11.4.4).
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    const lNum = NUMERIC.test(l);
    const rNum = NUMERIC.test(r);
    if (lNum && rNum) return Number(l) < Number(r) ? -1 : 1;
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (lNum) return -1;
    if (rNum) return 1;
    return l < r ? -1 : 1;
  }
  return 0;
}

// ─────────────────────────────────────────────────────────
// The changelog
// ─────────────────────────────────────────────────────────

export interface ReleaseNote {
  /** As written in the heading, normalised of any leading `v`. */
  version: string;
  /** Whatever followed the version on the heading line. Usually a date. */
  date: string;
  /** Language tag (`en`, `ko`) → markdown body. */
  bodies: Record<string, string>;
}

/** Split a heading line into its version and the remainder (a date, normally). */
const HEADING = /^##\s+(\S+)\s*(?:[—–-]\s*)?(.*)$/;
const LANG_HEADING = /^###\s+([A-Za-z-]+)\s*$/;

/**
 * Parse `releaseNotes.ts`'s markdown into entries, newest first.
 *
 * TOTAL. Every failure mode degrades to "fewer entries", never to a throw:
 * a heading whose version does not parse is dropped, a language section with no
 * text is dropped, text before the first heading is ignored, and an empty or
 * non-string input yields `[]`. The popup is on the startup path — a malformed
 * changelog has to cost the user the popup and nothing else.
 *
 * The returned order is the FILE's order for equal versions, and sorted
 * descending by version otherwise, so a block appended in the wrong place still
 * reads correctly.
 */
export function parseReleaseNotes(markdown: string | null | undefined): ReleaseNote[] {
  if (typeof markdown !== 'string' || !markdown.trim()) return [];

  const notes: ReleaseNote[] = [];
  let current: { version: string; date: string; bodies: Map<string, string[]> } | null = null;
  let lang: string | null = null;

  const flush = (): void => {
    if (!current) return;
    const bodies: Record<string, string> = {};
    for (const [tag, lines] of current.bodies) {
      const body = lines.join('\n').trim();
      if (body) bodies[tag] = body;
    }
    if (Object.keys(bodies).length > 0) {
      notes.push({ version: current.version, date: current.date, bodies });
    }
    current = null;
    lang = null;
  };

  for (const line of markdown.split(/\r?\n/)) {
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      const parsed = parseVersion(heading[1]);
      // An unreadable version is skipped WITH its whole block: `current` stays
      // null, so the lines that follow are ignored rather than attaching
      // themselves to the previous release.
      if (parsed) {
        current = {
          version: (heading[1] ?? '').trim().replace(/^v/i, ''),
          date: (heading[2] ?? '').trim(),
          bodies: new Map(),
        };
      }
      continue;
    }
    if (!current) continue;

    const langHeading = LANG_HEADING.exec(line);
    if (langHeading) {
      lang = (langHeading[1] ?? '').toLowerCase();
      if (!current.bodies.has(lang)) current.bodies.set(lang, []);
      continue;
    }
    if (lang) current.bodies.get(lang)?.push(line);
  }
  flush();

  return notes.sort((a, b) => -(compareVersions(a.version, b.version) ?? 0));
}

/**
 * The body to render for a language, with a fallback.
 *
 * A release documented in one language only still appears, in the other — an
 * entry the reader cannot read is better than a version that silently vanished
 * from the list, and it is the state the file is in for the hours between
 * writing one language and the other.
 */
export function bodyFor(note: ReleaseNote, language: string, fallback = 'en'): string {
  const tag = (language || '').toLowerCase();
  const base = tag.split('-')[0] ?? '';
  return (
    note.bodies[tag] ??
    note.bodies[base] ??
    note.bodies[fallback] ??
    Object.values(note.bodies)[0] ??
    ''
  );
}

// ─────────────────────────────────────────────────────────
// The decision
// ─────────────────────────────────────────────────────────

export interface WhatsNewPlan {
  /** Entries to show, newest first. Empty means show nothing at all. */
  entries: ReleaseNote[];
  /**
   * A version to record WITHOUT showing anything — the fresh-install case
   * (including the stamp written while its setup wizard is still up), and the
   * upgrade whose range happens to contain no entries.
   *
   * `null` when there is nothing to record now: either the popup is about to be
   * shown (dismissing it records) or nothing happened at all. A launch must
   * never record on both paths, or a user who quits before dismissing loses the
   * notes they never read.
   */
  recordSilently: string | null;
}

const NOTHING: WhatsNewPlan = { entries: [], recordSilently: null };

/**
 * What this launch should do about the release notes.
 *
 * `lastSeenVersion` is `null` on a fresh install — and also on any installation
 * whose watermark file could not be read, and on every installation that
 * existed before the watermark did. Those are NOT the same situation, and
 * telling them apart is the whole of rule 2b, so the answer is not inferred
 * from the missing watermark: the caller passes `freshInstall` in.
 *
 * BOTH EXTRA SIGNALS ARE VALUES, not lookups. This function stays pure — it
 * reads no bridge, no store and no DOM — so every combination below is a table
 * row in releaseNotesOps.test.ts rather than something only a second launch of
 * a packaged build could exercise.
 */
export function planWhatsNew(input: {
  currentVersion: string | null | undefined;
  lastSeenVersion: string | null | undefined;
  notes: ReleaseNote[];
  /**
   * TRUE only when this installation has never run before — the caller's answer
   * to "is there anything here that predates this launch", not a guess made
   * from the missing watermark. In the desktop app it is latched in the main
   * process at boot, before anything this launch does can create the evidence
   * it looks at (electron/whats-new.ts `looksLikeFreshInstall`).
   *
   * DEFAULTS TO TRUE — the silent answer. A caller that cannot say (an older
   * preload bridge, a plain browser tab) must not be able to turn a brand-new
   * user's first launch into a changelog.
   */
  freshInstall?: boolean;
  /**
   * Whether setup is finished. Defaults to true, for the hosts that have no
   * wizard to ask; the gate passes the real answer.
   */
  onboarded?: boolean;
}): WhatsNewPlan {
  const { currentVersion, lastSeenVersion, notes } = input;
  const freshInstall = input.freshInstall ?? true;
  const onboarded = input.onboarded ?? true;

  // Nothing trustworthy to compare against, so nothing is written either. See
  // UNKNOWN_VERSION for why the sentinel has to be excluded by name.
  if (!currentVersion || currentVersion === UNKNOWN_VERSION) return NOTHING;
  if (!parseVersion(currentVersion)) return NOTHING;

  // An unreadable watermark is deliberately the same value as no watermark at
  // all: both are "we have no record of what this user has seen".
  const seen = lastSeenVersion && parseVersion(lastSeenVersion) ? lastSeenVersion : null;

  // RULE 5 — the setup wizard owns the screen, so nothing is SHOWN here at all.
  //
  // One thing is still written: a brand-new installation's watermark. Without
  // it the fix for rule 2b would leak straight back into a new user's face —
  // they finish setup, and on their SECOND launch the installation has state,
  // still has no watermark, and would read as an existing one. Stamping the
  // version this installation was born on closes that window and costs the user
  // nothing, because there is by definition nothing they have missed.
  //
  // An EXISTING installation stuck in the wizard (skipped it without a key)
  // records nothing, so its notes survive to the first launch after setup.
  if (!onboarded) {
    return freshInstall && !seen ? { entries: [], recordSilently: currentVersion } : NOTHING;
  }

  if (!seen) {
    // RULE 2 — genuinely fresh install. Record and say nothing.
    if (freshInstall) return { entries: [], recordSilently: currentVersion };

    // RULE 2b — an installation that predates the watermark. It is running a
    // version it was never told about, so it is told about THAT ONE and nothing
    // else: with no watermark there is no honest floor to the range, and an
    // archive would be a guess dressed up as news. The version they just
    // received is the bounded, true answer.
    const entries = notes.filter((n) => compareVersions(n.version, currentVersion) === 0);
    return entries.length > 0
      ? { entries, recordSilently: null }
      : // Nobody wrote notes for the running version. Record it, or every later
        // launch re-runs this to the same empty answer.
        { entries: [], recordSilently: currentVersion };
  }

  // RULE 1 — only upwards. A downgrade records nothing on purpose: the
  // watermark stays at the highest version the user has been told about, so
  // going back up to it later does not re-announce what they already read.
  if ((compareVersions(currentVersion, seen) ?? 0) <= 0) return NOTHING;

  const entries = selectReleaseNotes(notes, seen, currentVersion);

  // An upgrade nobody wrote notes for. Record it silently rather than leaving
  // the watermark behind, or every later launch re-runs this to the same empty
  // answer and the range only grows.
  if (entries.length === 0) return { entries: [], recordSilently: currentVersion };

  return { entries, recordSilently: null };
}

/**
 * The archive, for the RE-OPENED popup: every entry the running build could
 * possibly be describing, newest first.
 *
 * Capped at the running version for the same reason `selectReleaseNotes` is: a
 * changelog written ahead of a release must not tell a user about a version
 * they are not running. Unbounded below, because someone who opens this from
 * Settings asked for it — they are not being interrupted, so there is nothing
 * to keep short.
 */
export function allNotesUpTo(notes: ReleaseNote[], upTo: string): ReleaseNote[] {
  return notes
    .filter((note) => {
      const cmp = compareVersions(note.version, upTo);
      return cmp !== null && cmp <= 0;
    })
    .sort((a, b) => -(compareVersions(a.version, b.version) ?? 0));
}

/**
 * RULE 4 — every entry in `(after, upTo]`, newest first.
 *
 * Half-open at the bottom: the version the user last saw is excluded (they saw
 * it), and the version they are now running is included (they have not).
 * Entries ABOVE the running version are excluded too — a changelog edited ahead
 * of the release must not announce a version the user does not have.
 */
export function selectReleaseNotes(
  notes: ReleaseNote[],
  after: string,
  upTo: string,
): ReleaseNote[] {
  return notes
    .filter((note) => {
      const aboveFloor = compareVersions(note.version, after);
      const belowCeiling = compareVersions(note.version, upTo);
      if (aboveFloor === null || belowCeiling === null) return false;
      return aboveFloor > 0 && belowCeiling <= 0;
    })
    .sort((a, b) => -(compareVersions(a.version, b.version) ?? 0));
}
