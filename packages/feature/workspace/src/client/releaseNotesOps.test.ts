import { describe, it, expect } from 'vitest';
import {
  allNotesUpTo,
  bodyFor,
  compareVersions,
  parseReleaseNotes,
  parseVersion,
  planWhatsNew,
  selectReleaseNotes,
  UNKNOWN_VERSION,
} from './releaseNotesOps';
import { RELEASE_NOTES_MARKDOWN } from './releaseNotes';

/**
 * The "what changed" popup's rules.
 *
 * DOM-FREE ON PURPOSE — this suite runs in vitest's default node environment,
 * like the rest of the ops tests, because every fact here is arithmetic on
 * version strings and text. The parts that need a browser (the portal, the
 * z-index, where the gate is mounted) are asserted against the source in
 * whatsNewWiring.test.ts.
 *
 * The cases below are the ones that break real implementations of this feature:
 * string comparison instead of numeric, announcing to a brand-new user, showing
 * only the newest entry to someone who skipped four versions, and throwing at
 * startup on a changelog with a typo in it.
 */

const note = (version: string, en = `notes for ${version}`) => ({
  version,
  date: '2026-01-01',
  bodies: { en },
});

describe('parseVersion', () => {
  it('reads the ordinary shape', () => {
    expect(parseVersion('1.25.0')).toEqual({ major: 1, minor: 25, patch: 0, prerelease: [] });
  });

  it('tolerates a leading v and a missing component', () => {
    expect(parseVersion('v1.25.0')).toEqual({ major: 1, minor: 25, patch: 0, prerelease: [] });
    expect(parseVersion('1.25')).toEqual({ major: 1, minor: 25, patch: 0, prerelease: [] });
  });

  it('keeps pre-release identifiers and drops build metadata', () => {
    expect(parseVersion('1.25.0-beta.2')?.prerelease).toEqual(['beta', '2']);
    // Semver §10: build metadata takes no part in precedence.
    expect(parseVersion('1.25.0+build.7')).toEqual({
      major: 1,
      minor: 25,
      patch: 0,
      prerelease: [],
    });
  });

  it('answers null for anything it cannot read, and never throws', () => {
    for (const bad of ['', '   ', 'next', '1.2.3.4', 'v', 'x.y.z', '1.-2.0', null, undefined, 42]) {
      expect(parseVersion(bad as string)).toBeNull();
    }
  });
});

describe('compareVersions', () => {
  it('compares NUMERICALLY — the case string equality gets wrong', () => {
    // Lexicographically '1.10.0' < '1.9.0'. This is the whole reason the
    // comparison is not `a > b`.
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
    expect(compareVersions('1.9.0', '1.10.0')).toBe(-1);
  });

  it('sees a patch bump as an upgrade', () => {
    expect(compareVersions('1.25.0', '1.24.1')).toBe(1);
    expect(compareVersions('1.24.1', '1.24.0')).toBe(1);
  });

  it('treats equal versions as equal, however they are written', () => {
    expect(compareVersions('1.25.0', 'v1.25.0')).toBe(0);
    expect(compareVersions('1.25', '1.25.0')).toBe(0);
    expect(compareVersions('1.25.0+a', '1.25.0+b')).toBe(0);
  });

  it('orders a pre-release below its release (semver §11.3/§11.4)', () => {
    expect(compareVersions('1.25.0-beta.1', '1.25.0')).toBe(-1);
    // Numeric identifiers compare numerically here too: beta.2 < beta.10.
    expect(compareVersions('1.25.0-beta.2', '1.25.0-beta.10')).toBe(-1);
    expect(compareVersions('1.25.0-beta', '1.25.0-beta.1')).toBe(-1);
    expect(compareVersions('1.25.0-alpha', '1.25.0-beta')).toBe(-1);
  });

  it('answers null rather than a misleading 0 when a side is unreadable', () => {
    expect(compareVersions('nightly', '1.25.0')).toBeNull();
    expect(compareVersions('1.25.0', '')).toBeNull();
  });
});

describe('parseReleaseNotes', () => {
  const SAMPLE = `
Anything above the first heading is preamble and is ignored.

## 1.2.0 — 2026-02-02

### en

Two things changed.

- one
- two

### ko

두 가지가 바뀌었다.

## 1.1.0 — 2026-01-01

### en

One thing changed.
`;

  it('reads every block, newest first', () => {
    const notes = parseReleaseNotes(SAMPLE);
    expect(notes.map((n) => n.version)).toEqual(['1.2.0', '1.1.0']);
    expect(notes[0]?.date).toBe('2026-02-02');
    expect(notes[0]?.bodies.en).toContain('- two');
    expect(notes[0]?.bodies.ko).toContain('두 가지');
  });

  it('sorts numerically even when the file is out of order', () => {
    const out = parseReleaseNotes(
      ['## 1.9.0', '### en', 'nine', '## 1.10.0', '### en', 'ten'].join('\n'),
    );
    expect(out.map((n) => n.version)).toEqual(['1.10.0', '1.9.0']);
  });

  it('DEGRADES rather than throwing on a malformed changelog', () => {
    // Each of these is a plausible hand-editing mistake, and every one of them
    // is on the app's startup path.
    expect(parseReleaseNotes('')).toEqual([]);
    expect(parseReleaseNotes('   \n\n')).toEqual([]);
    expect(parseReleaseNotes(null)).toEqual([]);
    expect(parseReleaseNotes(undefined)).toEqual([]);
    expect(parseReleaseNotes(123 as unknown as string)).toEqual([]);
    // No headings at all — just prose.
    expect(parseReleaseNotes('we changed some things')).toEqual([]);
    // A heading with no body.
    expect(parseReleaseNotes('## 1.2.0 — 2026-02-02')).toEqual([]);
    // A language section with no text under it.
    expect(parseReleaseNotes('## 1.2.0\n### en\n\n')).toEqual([]);
  });

  it('drops a block whose version is unreadable, WITH its body', () => {
    const notes = parseReleaseNotes(
      ['## next', '### en', 'unreleased', '## 1.1.0', '### en', 'real'].join('\n'),
    );
    expect(notes.map((n) => n.version)).toEqual(['1.1.0']);
    // The orphaned body did not attach itself to the surviving release.
    expect(notes[0]?.bodies.en).toBe('real');
  });
});

describe('bodyFor', () => {
  const entry = { version: '1.0.0', date: '', bodies: { en: 'english', ko: '한국어' } };

  it('picks the language, including a regional tag', () => {
    expect(bodyFor(entry, 'ko')).toBe('한국어');
    expect(bodyFor(entry, 'ko-KR')).toBe('한국어');
    expect(bodyFor(entry, 'en-US')).toBe('english');
  });

  it('falls back rather than rendering an empty entry', () => {
    expect(bodyFor(entry, 'fr')).toBe('english');
    expect(bodyFor({ version: '1.0.0', date: '', bodies: { ko: '한국어' } }, 'en')).toBe('한국어');
    expect(bodyFor({ version: '1.0.0', date: '', bodies: {} }, 'en')).toBe('');
  });
});

describe('selectReleaseNotes — a skipped range loses nothing', () => {
  const notes = [note('1.25.0'), note('1.24.1'), note('1.24.0'), note('1.23.0'), note('1.22.0')];

  it('returns EVERY entry in the gap, newest first', () => {
    expect(selectReleaseNotes(notes, '1.22.0', '1.25.0').map((n) => n.version)).toEqual([
      '1.25.0',
      '1.24.1',
      '1.24.0',
      '1.23.0',
    ]);
  });

  it('excludes the version already seen and includes the one now running', () => {
    expect(selectReleaseNotes(notes, '1.24.0', '1.24.1').map((n) => n.version)).toEqual(['1.24.1']);
  });

  it('never announces a version the user does not have', () => {
    // The changelog is written before the release; a build sitting on 1.23.0
    // must not read out 1.24 and 1.25.
    expect(selectReleaseNotes(notes, '1.22.0', '1.23.0').map((n) => n.version)).toEqual(['1.23.0']);
  });

  it('skips entries it cannot compare instead of failing the whole range', () => {
    const withJunk = [...notes, note('nightly')];
    expect(selectReleaseNotes(withJunk, '1.24.0', '1.25.0').map((n) => n.version)).toEqual([
      '1.25.0',
      '1.24.1',
    ]);
  });
});

describe('planWhatsNew', () => {
  const notes = [note('1.25.0'), note('1.24.1'), note('1.24.0'), note('1.23.0'), note('1.22.0')];

  it('RULE 2 — a fresh install is recorded silently and shown nothing', () => {
    const plan = planWhatsNew({ currentVersion: '1.25.0', lastSeenVersion: null, notes });
    expect(plan.entries).toEqual([]);
    expect(plan.recordSilently).toBe('1.25.0');
  });

  it('treats an unreadable watermark as a fresh install', () => {
    for (const bad of ['', 'garbage', '   ']) {
      const plan = planWhatsNew({ currentVersion: '1.25.0', lastSeenVersion: bad, notes });
      expect(plan.entries).toEqual([]);
      expect(plan.recordSilently).toBe('1.25.0');
    }
  });

  it('RULE 1 — shows the range on an upgrade, and records NOTHING yet', () => {
    const plan = planWhatsNew({ currentVersion: '1.25.0', lastSeenVersion: '1.22.0', notes });
    expect(plan.entries.map((n) => n.version)).toEqual(['1.25.0', '1.24.1', '1.24.0', '1.23.0']);
    // Recording happens on dismissal. Recording here as well would lose the
    // notes for anyone who quits before reading them.
    expect(plan.recordSilently).toBeNull();
  });

  it('gets 1.9.0 → 1.10.0 right', () => {
    const nine = [note('1.10.0'), note('1.9.0')];
    const plan = planWhatsNew({ currentVersion: '1.10.0', lastSeenVersion: '1.9.0', notes: nine });
    expect(plan.entries.map((n) => n.version)).toEqual(['1.10.0']);
  });

  it('shows a patch bump', () => {
    const plan = planWhatsNew({ currentVersion: '1.24.1', lastSeenVersion: '1.24.0', notes });
    expect(plan.entries.map((n) => n.version)).toEqual(['1.24.1']);
  });

  it('shows nothing on an equal version — rule 3, across restarts', () => {
    // This is what "dismissing survives a restart" reduces to: the watermark is
    // the running version, so every later launch takes this branch.
    expect(planWhatsNew({ currentVersion: '1.25.0', lastSeenVersion: '1.25.0', notes })).toEqual({
      entries: [],
      recordSilently: null,
    });
  });

  it('shows nothing on a downgrade, and does not lower the watermark', () => {
    expect(planWhatsNew({ currentVersion: '1.24.0', lastSeenVersion: '1.25.0', notes })).toEqual({
      entries: [],
      recordSilently: null,
    });
  });

  it('records an upgrade nobody wrote notes for, so the range cannot grow forever', () => {
    const plan = planWhatsNew({ currentVersion: '2.0.0', lastSeenVersion: '1.25.0', notes: [] });
    expect(plan.entries).toEqual([]);
    expect(plan.recordSilently).toBe('2.0.0');
  });

  it('does nothing at all when the running version is unusable', () => {
    // `0.0.0` is what main answers with no Electron app context. Recorded as a
    // watermark it would make the next real launch replay the whole archive.
    expect(planWhatsNew({ currentVersion: UNKNOWN_VERSION, lastSeenVersion: null, notes })).toEqual(
      { entries: [], recordSilently: null },
    );
    for (const bad of [null, undefined, '', 'nightly']) {
      expect(planWhatsNew({ currentVersion: bad, lastSeenVersion: '1.22.0', notes })).toEqual({
        entries: [],
        recordSilently: null,
      });
    }
  });

  it('survives a changelog that failed to parse', () => {
    const plan = planWhatsNew({
      currentVersion: '1.25.0',
      lastSeenVersion: '1.22.0',
      notes: parseReleaseNotes('this file got mangled'),
    });
    expect(plan.entries).toEqual([]);
    expect(plan.recordSilently).toBe('1.25.0');
  });
});

describe('allNotesUpTo — the re-opened archive', () => {
  const notes = [note('1.25.0'), note('1.24.0'), note('1.23.0')];

  it('returns everything the running build could be describing', () => {
    expect(allNotesUpTo(notes, '1.24.0').map((n) => n.version)).toEqual(['1.24.0', '1.23.0']);
    expect(allNotesUpTo(notes, '1.25.0')).toHaveLength(3);
  });

  it('is empty rather than wrong when the version cannot be read', () => {
    expect(allNotesUpTo(notes, 'nightly')).toEqual([]);
  });
});

describe('the shipped changelog', () => {
  const notes = parseReleaseNotes(RELEASE_NOTES_MARKDOWN);

  it('parses, so the feature is demonstrable rather than empty on arrival', () => {
    expect(notes.length).toBeGreaterThanOrEqual(5);
    expect(notes.map((n) => n.version)).toEqual([
      '1.26.0',
      '1.25.0',
      '1.24.1',
      '1.24.0',
      '1.23.0',
      '1.22.0',
    ]);
  });

  it('carries BOTH languages for every entry — the app ships en and ko', () => {
    for (const entry of notes) {
      expect(entry.bodies.en?.trim(), `${entry.version} has no English body`).toBeTruthy();
      expect(entry.bodies.ko?.trim(), `${entry.version} has no Korean body`).toBeTruthy();
    }
  });

  it('dates every entry', () => {
    for (const entry of notes) {
      expect(entry.date, `${entry.version} has no date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('shows the whole gap to someone who skipped from 1.22.0 to 1.25.0', () => {
    const plan = planWhatsNew({ currentVersion: '1.25.0', lastSeenVersion: '1.22.0', notes });
    expect(plan.entries.map((n) => n.version)).toEqual(['1.25.0', '1.24.1', '1.24.0', '1.23.0']);
  });
});
