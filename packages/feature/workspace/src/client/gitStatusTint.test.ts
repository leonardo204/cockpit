import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import en from '../../../../shared/i18n/locales/en.json';
import ko from '../../../../shared/i18n/locales/ko.json';
import { gitTintClass, gitTintTitleKey } from './gitStatusTint';
import type { FileChangeState } from './gitStatusTypes';

/**
 * A CHANGED FILE LOOKS CHANGED, AND SAYS WHY ON HOVER.
 *
 * jsdom has no computed styles, so what is assertable is the mapping itself —
 * which is where the rule would rot anyway: one more state, one more inline
 * ternary, until the tree has five colours and nobody can say what the fourth
 * one means.
 */

const STATES: readonly FileChangeState[] = [
  'conflicted',
  'added',
  'modified',
  'deleted',
  'untracked',
  'touched',
];

const chat = (d: unknown) => (d as { fileBrowser: Record<string, string> }).fileBrowser;

describe('every state is distinguishable', () => {
  it('gives each one its own appearance', () => {
    const classes = STATES.map(gitTintClass);
    expect(new Set(classes).size).toBe(STATES.length);
  });

  it('leaves an unchanged file exactly as it was', () => {
    // The baseline the tree already used. A file with nothing to say must look
    // like it always did, or every row reads as meaningful.
    expect(gitTintClass(null)).toBe('text-foreground/90');
    expect(gitTintClass(undefined)).toBe('text-foreground/90');
  });

  it('follows what an editor tree has trained people to expect', () => {
    // Disagreeing with this costs more than it could buy: a reader already
    // believes green means new and red means gone.
    expect(gitTintClass('added')).toContain('green');
    expect(gitTintClass('untracked')).toContain('green');
    expect(gitTintClass('deleted')).toContain('red');
    expect(gitTintClass('conflicted')).toContain('red');
  });

  it('uses the app’s own tokens rather than inventing a palette', () => {
    // A file browser is not the place to introduce colours the rest of the app
    // does not have.
    for (const s of STATES) {
      expect(gitTintClass(s)).toMatch(/text-(red-11|green-11|brand|amber-11)/);
    }
  });
});

describe('the states that need more than a colour', () => {
  it('strikes through a deletion', () => {
    // The row is still listed while the deletion is unstaged, and "on its way
    // out" is not something a colour alone says.
    expect(gitTintClass('deleted')).toContain('line-through');
  });

  it('gives a conflict weight as well as colour', () => {
    // The only state that is a problem rather than a fact.
    expect(gitTintClass('conflicted')).toContain('font-semibold');
  });

  it('keeps the most common state quiet', () => {
    // Most changed rows are `modified`. A tree where most rows shout is a tree
    // where none of them do — so it gets the accent, not an alarm.
    expect(gitTintClass('modified')).not.toContain('font-semibold');
    expect(gitTintClass('modified')).not.toContain('line-through');
  });

  it('makes untracked the weaker claim of the two greens', () => {
    expect(gitTintClass('untracked')).not.toBe(gitTintClass('added'));
    expect(gitTintClass('untracked')).toContain('/70');
  });
});

describe('a colour explains itself', () => {
  it('names a hint key for every state and none for a clean file', () => {
    // Not all of them are git states any more — `touched` is what a project
    // without a repository gets — so the shared prefix is the panel's, not git's.
    for (const s of STATES) expect(gitTintTitleKey(s)).toMatch(/^fileBrowser\./);
    expect(gitTintTitleKey(null)).toBeNull();
  });

  it('is translated in BOTH locales', () => {
    // A key present in en.json and missing in ko.json reaches a Korean reader as
    // a raw key path in a tooltip.
    for (const s of STATES) {
      const key = gitTintTitleKey(s)!.replace('fileBrowser.', '');
      expect(chat(en)[key], `en: ${key}`).toBeTruthy();
      expect(chat(ko)[key], `ko: ${key}`).toBeTruthy();
      expect(chat(ko)[key]).not.toBe(chat(en)[key]);
    }
  });
});

describe('the row goes through the helper', () => {
  it('does not re-implement the colour in JSX', () => {
    // Source assertion, like the rest of this panel's guards: the tree row is
    // the one place a hard-coded class would silently win.
    const panel = readFileSync(join(__dirname, 'FileBrowserPanel.tsx'), 'utf8');
    expect(panel).toContain('gitTintClass(');
    // The old unconditional class must not still be pinned onto the row beside
    // it, or the tint would be overridden by whichever tailwind rule wins.
    expect(panel).not.toContain('cursor-pointer select-none rounded text-foreground/90');
  });
});

describe('a project with no git repository', () => {
  it('does not wear the same colour as "modified"', () => {
    // They are not the same claim. `modified` means "differs from the commit you
    // made"; `touched` means only "written since you opened this". Sharing a
    // colour would let a project with no baseline look like one with a clean one.
    expect(gitTintClass('touched')).not.toBe(gitTintClass('modified'));
  });

  it('says what the baseline is, because the reader did not choose it', () => {
    // Every git state describes a comparison the user set up. This one describes
    // one the app picked, so the tooltip has to name it rather than assume it.
    for (const dict of [en, ko]) {
      expect(chat(dict).touchedSinceOpen).toBeTruthy();
    }
    expect(chat(en).touchedSinceOpen).toContain('opened');
    expect(chat(en).touchedSinceOpen).toContain('git');
    expect(chat(ko).touchedSinceOpen).toContain('연 뒤');
    expect(chat(ko).touchedSinceOpen).toContain('git');
  });
});

describe('the panel falls back rather than going blank', () => {
  it('asks the other route when there is no repository', () => {
    // Otherwise a project without git shows a whole tree of work as untouched,
    // which is the gap this closes.
    const panel = readFileSync(join(__dirname, 'FileBrowserPanel.tsx'), 'utf8');
    expect(panel).toContain('/api/changed-since?cwd=');
    expect(panel).toContain('since=${openedAtRef.current}');
  });

  it('pins the baseline once, so the tree can ever light up', () => {
    // Recomputing it per refresh would make the answer permanently "nothing
    // changed since a moment ago".
    const panel = readFileSync(join(__dirname, 'FileBrowserPanel.tsx'), 'utf8');
    expect(panel).toContain('if (openedAtRef.current === 0) openedAtRef.current = Date.now();');
  });
});
