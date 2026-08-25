import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SESSION_NAME_ANIMALS, defaultSessionName } from '@cockpit/shared-utils';
import { untitledTabTitle } from './untitledTabTitle';
import { applyTitleUpdate } from './titleLock';

/**
 * The tab strip's half of "a session nobody has named is still readable".
 *
 * The server derives a name for every session it lists; a TAB may hold nothing
 * but an id, or not even that. These pin that it produces the same string
 * anyway — and, just as importantly, that it is only a DEFAULT: the derived
 * title still takes the tab over on the first turn, and a rename still cannot
 * be taken from the user.
 */

const CLIENT = __dirname;
const read = (name: string) => readFileSync(join(CLIENT, name), 'utf8');
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const code = (name: string) => stripComments(read(name));

const NOW = new Date(2026, 7, 24, 15, 30).getTime();
/** The shape `mintSessionId` produces: `s-<base36 Date.now()>-<n>-<random>`. */
const idMintedAt = (t: number) => `s-${t.toString(36)}-1-1jijoi7t`;

describe('untitledTabTitle — a tab with no session yet', () => {
  it('is named date, time, animal from the injected clock', () => {
    expect(untitledTabTitle('tab-1', undefined, NOW)).toMatch(/^0824-1530-[a-z]+$/);
  });

  it('picks its animal from the published list', () => {
    const animal = untitledTabTitle('tab-1', undefined, NOW).split('-')[2];
    expect(SESSION_NAME_ANIMALS as readonly string[]).toContain(animal);
  });

  it('gives two tabs opened in the same millisecond distinguishable names', () => {
    // The old label was `New Chat` for all of them at once, which is the case
    // this feature exists for. A collision is still legal — the tab id is the
    // identity — but different tab ids normally hash to different animals.
    const a = untitledTabTitle('tab-1', undefined, NOW);
    const b = untitledTabTitle('tab-2', undefined, NOW);
    expect(a).toMatch(/^0824-1530-[a-z]+$/);
    expect(b).toMatch(/^0824-1530-[a-z]+$/);
    expect(a).not.toBe(b);
  });
});

describe('untitledTabTitle — a tab holding a session id', () => {
  it('names it after when the SESSION was made, not when the tab opened', () => {
    const madeLastWeek = new Date(2026, 7, 17, 9, 5).getTime();
    expect(untitledTabTitle('tab-1', idMintedAt(madeLastWeek), NOW)).toMatch(/^0817-0905-[a-z]+$/);
  });

  it('produces exactly what the server derives for the same session', () => {
    // This is the whole point: a name that differs between the tab and the list
    // is worse than the id it replaced.
    const sessionId = idMintedAt(NOW);
    expect(untitledTabTitle('tab-1', sessionId, Date.now())).toBe(
      defaultSessionName(sessionId, NOW),
    );
  });

  it('falls back to the injected clock for an id this runtime did not mint', () => {
    expect(untitledTabTitle('tab-1', 'c0ffee-1234-5678', NOW)).toBe(
      defaultSessionName('c0ffee-1234-5678', NOW),
    );
  });

  it('never puts a piece of the id in the label', () => {
    const sessionId = 's-mt167djb-1-1jijoi7t';
    const title = untitledTabTitle('tab-1', sessionId, NOW);
    expect(title).not.toContain('mt167djb');
    expect(title).not.toContain('Session ');
  });
});

describe('it is a default, and defaults lose', () => {
  it('stage 2 — the conversation-derived title replaces it', () => {
    const tab = { title: untitledTabTitle('tab-1', undefined, NOW) };
    const next = applyTitleUpdate(tab, { title: '리팩터링 좀 도와줘' });
    expect(next.title).toBe('리팩터링 좀 도와줘');
  });

  it('stage 3 — a renamed tab is NOT replaced by the derived title', () => {
    const renamed = applyTitleUpdate(
      { title: untitledTabTitle('tab-1', undefined, NOW) },
      { title: '내가 붙인 이름', lockTitle: true },
    );
    expect(renamed).toMatchObject({ title: '내가 붙인 이름', titleLocked: true });
    const afterTurn = applyTitleUpdate(renamed, { title: '리팩터링 좀 도와줘' });
    expect(afterTurn.title).toBe('내가 붙인 이름');
  });
});

describe('the tab strip source', () => {
  it('no longer labels a tab with a slice of its session id', () => {
    expect(code('useTabState.ts')).not.toContain('sessionId.slice(0, 6)');
    expect(code('useTabState.ts')).not.toContain('`Session ${');
  });

  it('routes every untitled tab through the one namer', () => {
    const src = code('useTabState.ts');
    expect(src).toContain("import { untitledTabTitle } from './untitledTabTitle'");
    // The seeded tab, the "+" tab, the blank tab left behind by closing the
    // last one, the one `reconcileTabs` seeds when every tab you held was
    // closed from another window, and the RESUMED tab — a project that has
    // sessions opens on the last one, and the seed tab is renamed after the
    // session it just adopted rather than after the blank it was named as
    // (projectOpenPlan.ts). `Date.now()` is read at these call sites and
    // passed IN, never inside the namer.
    expect(src.match(/untitledTabTitle\(/g)?.length).toBe(5);
    // No blank-tab path may reintroduce a literal — that was the last one.
    expect(src).not.toContain("title: 'New Chat'");
  });

  it('keeps the rename lock exactly where it was', () => {
    // Nothing here may touch stage 3. If this ever fails, the default name has
    // grown into the title pipeline and needs taking back out.
    const src = code('useTabState.ts');
    expect(src).toContain('applyTitleUpdate(tab, updates)');
    expect(code('titleLock.ts')).not.toContain('untitledTabTitle');
    expect(code('titleLock.ts')).not.toContain('defaultSessionName');
  });
});
