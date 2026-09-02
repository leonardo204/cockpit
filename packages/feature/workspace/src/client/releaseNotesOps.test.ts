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

  it('RULE 2b — an EXISTING installation with no watermark hears about the version it is RUNNING', () => {
    // THE BUG THIS EXISTS FOR. The first launch after updating into the build
    // that introduced the popup: an existing user has no watermark either, and
    // the old rule read that as a fresh install and said nothing — so the
    // feature never fired for anybody who already had the app. The caller can
    // tell the two apart (see `freshInstall`) and now says which one this is.
    const plan = planWhatsNew({
      currentVersion: '1.25.0',
      lastSeenVersion: null,
      freshInstall: false,
      onboarded: true,
      notes,
    });
    // ONLY the running version, not the archive: we do not know what they have
    // already seen, so four entries would be four guesses.
    expect(plan.entries.map((n) => n.version)).toEqual(['1.25.0']);
    // Recording still happens on dismissal, like every other shown popup.
    expect(plan.recordSilently).toBeNull();
  });

  it('RULE 2b — records silently when the running version has no entry, rather than retrying forever', () => {
    const plan = planWhatsNew({
      currentVersion: '9.9.9',
      lastSeenVersion: null,
      freshInstall: false,
      onboarded: true,
      notes,
    });
    expect(plan.entries).toEqual([]);
    expect(plan.recordSilently).toBe('9.9.9');
  });

  it('RULE 2b — the sentinel is still excluded by NAME, even for an existing installation', () => {
    expect(
      planWhatsNew({
        currentVersion: UNKNOWN_VERSION,
        lastSeenVersion: null,
        freshInstall: false,
        onboarded: true,
        notes,
      }),
    ).toEqual({ entries: [], recordSilently: null });
  });

  it('a fresh install is STAMPED while the wizard is still up, so its second launch is silent too', () => {
    // Without this the fix would leak: a brand-new user finishes setup, and on
    // their SECOND launch the installation has state, no watermark, and would
    // read as an existing one. The stamp closes that window.
    const plan = planWhatsNew({
      currentVersion: '1.25.0',
      lastSeenVersion: null,
      freshInstall: true,
      onboarded: false,
      notes,
    });
    expect(plan.entries).toEqual([]);
    expect(plan.recordSilently).toBe('1.25.0');
  });

  it('NEVER shows during onboarding — not even a real upgrade, and it records nothing then', () => {
    // An existing user who skipped the wizard without a key still has it up.
    // Showing nothing AND recording nothing means the notes survive to the
    // first launch after they finish setting up.
    expect(
      planWhatsNew({
        currentVersion: '1.25.0',
        lastSeenVersion: '1.22.0',
        freshInstall: false,
        onboarded: false,
        notes,
      }),
    ).toEqual({ entries: [], recordSilently: null });
    expect(
      planWhatsNew({
        currentVersion: '1.25.0',
        lastSeenVersion: null,
        freshInstall: false,
        onboarded: false,
        notes,
      }),
    ).toEqual({ entries: [], recordSilently: null });
  });

  it('treats an ABSENT freshness signal as a fresh install — the silent answer', () => {
    // A caller that cannot say (an older bridge, a browser tab) must not be
    // able to turn a brand-new user's first launch into a changelog.
    const plan = planWhatsNew({ currentVersion: '1.25.0', lastSeenVersion: null, notes });
    expect(plan.entries).toEqual([]);
    expect(plan.recordSilently).toBe('1.25.0');
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
      '1.35.0',
      '1.34.1',
      '1.34.0',
      '1.33.0',
      '1.32.0',
      '1.31.2',
      '1.31.1',
      '1.31.0',
      '1.30.0',
      '1.29.0',
      '1.28.0',
      '1.27.0',
      '1.26.1',
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

  // The groups, in the ONE order every entry uses. Bold lines rather than
  // `###` headings, because `###` is how the parser finds a language section —
  // `### New` would be read as a language called "new" and swallow the block.
  const GROUPS = {
    en: ['**New**', '**Improved**', '**Fixed**'],
    ko: ['**새로 생긴 것**', '**나아진 것**', '**고친 것**'],
  } as const;

  const groupsIn = (body: string, lang: 'en' | 'ko'): number[] =>
    GROUPS[lang].map((label, i) => (body.includes(label) ? i : -1)).filter((i) => i >= 0);

  it('opens every entry with a lead line, then groups the items', () => {
    for (const entry of notes) {
      for (const lang of ['en', 'ko'] as const) {
        const body = entry.bodies[lang] ?? '';
        const first = body.split('\n').find((line) => line.trim())?.trim() ?? '';
        // A reader who reads one line should still learn what the release is
        // about, so the entry cannot open with a bullet or a group label.
        expect(first.startsWith('-'), `${entry.version}/${lang} opens with a bullet`).toBe(false);
        expect(first.startsWith('**'), `${entry.version}/${lang} opens with a group`).toBe(false);

        const groups = groupsIn(body, lang);
        expect(groups.length, `${entry.version}/${lang} has no group at all`).toBeGreaterThan(0);
        // New → Improved → Fixed, always, so the shape does not have to be
        // relearned per entry.
        expect(groups, `${entry.version}/${lang} groups are out of order`).toEqual(
          [...groups].sort((a, b) => a - b),
        );
        // Every bullet belongs to a group: nothing may sit between the lead
        // line and the first label.
        const beforeFirstGroup = body.slice(0, body.indexOf(GROUPS[lang][groups[0] as 0]));
        expect(
          /^\s*[-*]\s/m.test(beforeFirstGroup),
          `${entry.version}/${lang} has an ungrouped bullet`,
        ).toBe(false);
      }
    }
  });

  it('groups the SAME way in both languages — one translation, not two edits', () => {
    for (const entry of notes) {
      expect(groupsIn(entry.bodies.ko ?? '', 'ko'), `${entry.version} groups differ`).toEqual(
        groupsIn(entry.bodies.en ?? '', 'en'),
      );
    }
  });

  it('speaks Korean in the app\'s "~해요" voice rather than the specs\' "~한다"', () => {
    // The register was wrong on arrival: these bodies were written in the plain
    // declarative the project mandates for SPEC DOCUMENTS. This is UI copy in a
    // popup, and a spec talking at the reader is the wrong voice for it.
    for (const entry of notes) {
      const ko = entry.bodies.ko ?? '';
      const plainDeclarative = ko.match(/\S*다(?=[.!?]|$)/gm) ?? [];
      expect(plainDeclarative, `${entry.version} still speaks in ~한다`).toEqual([]);
      expect(/요[.!?]/.test(ko), `${entry.version} has no ~해요 sentence at all`).toBe(true);
    }
  });

  it('avoids the two markdown shapes that would eat the entry they are in', () => {
    for (const entry of notes) {
      for (const [lang, body] of Object.entries(entry.bodies)) {
        // `### anything` is a LANGUAGE heading to the parser.
        expect(/^###\s/m.test(body), `${entry.version}/${lang} has a ### heading`).toBe(false);
        // A fence opened inside a bullet swallows the rest of the block.
        expect(body.includes('```'), `${entry.version}/${lang} opens a code fence`).toBe(false);
      }
    }
  });

  it('shows the whole gap to someone who skipped from 1.22.0 to 1.25.0', () => {
    const plan = planWhatsNew({ currentVersion: '1.25.0', lastSeenVersion: '1.22.0', notes });
    expect(plan.entries.map((n) => n.version)).toEqual(['1.25.0', '1.24.1', '1.24.0', '1.23.0']);
  });
});

describe('a watermark this app could never have written', () => {
  const notes = [note('1.31.0'), note('1.25.0'), note('1.24.1'), note('1.24.0')];

  // The bug this repairs: `app.getVersion()` returns the version of the
  // EXECUTABLE when Electron cannot find the app's package.json, and the dev
  // launcher hands it a file rather than a directory. So a development run
  // stamped Electron's own `43.1.1` into the userData directory the packaged app
  // SHARES, and no real release could ever be newer than it again. Every upgrade
  // after that was silent, on an installation that had done nothing wrong.

  it('does not believe a version that never shipped', () => {
    const plan = planWhatsNew({
      currentVersion: '1.31.0',
      lastSeenVersion: '43.1.1',
      freshInstall: false,
      notes,
    });
    // Treated as "no record", which for an existing installation means the
    // version they are actually running — the same answer rule 2b gives.
    expect(plan.entries.map((n) => n.version)).toEqual(['1.31.0']);
  });

  it('does not silently re-stamp it on a fresh install either', () => {
    const plan = planWhatsNew({
      currentVersion: '1.31.0',
      lastSeenVersion: '43.1.1',
      freshInstall: true,
      notes,
    });
    expect(plan.recordSilently).toBe('1.31.0');
  });

  it('STILL keeps a real downgrade’s watermark', () => {
    // The distinction that matters. `1.25.0` is ahead of `1.24.0` too, but it is
    // a release that exists — and lowering the watermark would show its notes
    // all over again when the user goes back up.
    expect(planWhatsNew({ currentVersion: '1.24.0', lastSeenVersion: '1.25.0', notes })).toEqual({
      entries: [],
      recordSilently: null,
    });
  });

  it('leaves an ordinary watermark alone', () => {
    // Behind the current version, so there is nothing to doubt — and the whole
    // gap is shown, not just the newest entry.
    const plan = planWhatsNew({
      currentVersion: '1.25.0',
      lastSeenVersion: '1.24.0',
      freshInstall: false,
      notes,
    });
    expect(plan.entries.map((n) => n.version)).toEqual(['1.25.0', '1.24.1']);
  });
});

describe('the shipped changelog rejects the poisoned watermark', () => {
  it('has no entry that could be mistaken for an Electron version', () => {
    // The discriminator is "does the changelog contain it". If a naby release
    // ever took a number like 43.1.1 this repair would stop working, so the
    // assumption is pinned rather than left implicit.
    for (const n of parseReleaseNotes(RELEASE_NOTES_MARKDOWN)) {
      expect(Number(n.version.split('.')[0])).toBeLessThan(40);
    }
  });
});
