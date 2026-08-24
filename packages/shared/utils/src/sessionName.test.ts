import { describe, expect, it } from 'vitest';
import {
  SESSION_NAME_ANIMALS,
  defaultSessionName,
  formatSessionNameStamp,
  sessionCreatedAtFromId,
  sessionNameAnimal,
} from './sessionName';

/**
 * Dates are built with the LOCAL `Date` constructor on purpose. The name is
 * formatted in the reader's timezone, so a test that hard-coded an epoch would
 * pass in Seoul and fail in CI's UTC — and would be testing the runner's
 * timezone rather than the format.
 */
const at = (y: number, m: number, d: number, h: number, min: number) =>
  new Date(y, m - 1, d, h, min, 0, 0).getTime();

describe('defaultSessionName — the shape', () => {
  it('is date, then time, then an animal, joined by one separator', () => {
    // A known clock and a known picker: the seed below hashes to a fixed word,
    // so the whole string is asserted rather than a pattern.
    const animal = sessionNameAnimal('s-known-seed');
    expect(defaultSessionName('s-known-seed', at(2026, 8, 24, 15, 30))).toBe(`0824-1530-${animal}`);
  });

  it('pads every field to a fixed width, so a column of names sorts and lines up', () => {
    const a = defaultSessionName('x', at(2026, 1, 2, 3, 4));
    expect(a.startsWith('0102-0304-')).toBe(true);
    // Chronological order IS lexicographic order within the year.
    const stamps = [
      formatSessionNameStamp(at(2026, 1, 2, 3, 4)),
      formatSessionNameStamp(at(2026, 1, 2, 12, 0)),
      formatSessionNameStamp(at(2026, 9, 30, 23, 59)),
    ];
    expect([...stamps].sort()).toEqual(stamps);
  });

  it('midnight is 0000, not 2400 or 1200', () => {
    expect(formatSessionNameStamp(at(2026, 12, 31, 0, 0))).toBe('1231-0000');
    expect(formatSessionNameStamp(at(2026, 12, 31, 12, 0))).toBe('1231-1200');
  });

  it('contains none of the separators the app joins metadata with', () => {
    // The recent list and the Telegram session line both join fields with `·`;
    // a name carrying a joiner (or a space) would read as two fields.
    for (const animal of SESSION_NAME_ANIMALS) {
      expect(animal).toMatch(/^[a-z]+$/);
    }
    const name = defaultSessionName('s-abc', at(2026, 8, 24, 15, 30));
    expect(name).toMatch(/^[0-9]{4}-[0-9]{4}-[a-z]+$/);
    for (const forbidden of ['·', ' ', '/', ':', '|', '\n']) {
      expect(name).not.toContain(forbidden);
    }
  });

  it('stays short enough to survive a narrow tab', () => {
    // 9 fixed characters of stamp + the longest animal. The tab strip caps a tab
    // at 260px and truncates hard; this is the budget that keeps the whole name
    // visible there.
    const longest = [...SESSION_NAME_ANIMALS].sort((a, b) => b.length - a.length)[0];
    expect(defaultSessionName('x', at(2026, 8, 24, 15, 30)).length).toBeLessThanOrEqual(
      10 + longest.length,
    );
    expect(longest.length).toBeLessThanOrEqual(8);
  });
});

describe('the animal', () => {
  it('always comes from the published list', () => {
    const words = new Set<string>(SESSION_NAME_ANIMALS);
    for (let i = 0; i < 500; i++) {
      expect(words.has(sessionNameAnimal(`s-${i}-${i * 7919}`))).toBe(true);
    }
  });

  it('is a hash of the seed, so every surface picks the same one', () => {
    // The tab strip, the session lists and Telegram cannot ask each other what
    // they chose. Same seed, same word — that is the whole agreement mechanism.
    expect(sessionNameAnimal('s-mt167djb-1-1jijoi7t')).toBe(
      sessionNameAnimal('s-mt167djb-1-1jijoi7t'),
    );
    expect(sessionNameAnimal('a')).not.toBe(sessionNameAnimal('b'));
  });

  it('spreads across the list rather than favouring one word', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) seen.add(sessionNameAnimal(`s-${i}`));
    expect(seen.size).toBe(SESSION_NAME_ANIMALS.length);
  });

  it('has no duplicate and no compound word', () => {
    expect(new Set<string>(SESSION_NAME_ANIMALS).size).toBe(SESSION_NAME_ANIMALS.length);
    for (const animal of SESSION_NAME_ANIMALS) {
      expect(animal).not.toContain('-');
      expect(animal).not.toContain(' ');
    }
  });
});

describe('collisions are allowed', () => {
  it('two names minted in the same millisecond do not throw and are both valid', () => {
    const now = at(2026, 8, 24, 15, 30);
    const a = defaultSessionName('tab-1', now);
    const b = defaultSessionName('tab-2', now);
    expect(a).toMatch(/^0824-1530-[a-z]+$/);
    expect(b).toMatch(/^0824-1530-[a-z]+$/);
    // Identical seeds may legitimately produce identical names. The id is the
    // identity; this is only a label, so nothing scans for a clash.
    expect(defaultSessionName('same', now)).toBe(defaultSessionName('same', now));
  });
});

describe('sessionCreatedAtFromId', () => {
  it('reads back the mint time the runtime encoded in the id', () => {
    const when = at(2026, 8, 24, 15, 30);
    // The shape `mintSessionId` produces: `s-<base36 Date.now()>-<n>-<random>`.
    const id = `s-${when.toString(36)}-1-abcdefgh`;
    expect(sessionCreatedAtFromId(id)).toBe(when);
    expect(defaultSessionName(id, sessionCreatedAtFromId(id)!)).toBe(
      `0824-1530-${sessionNameAnimal(id)}`,
    );
  });

  it('returns undefined for an id this runtime did not mint, rather than a guess', () => {
    expect(sessionCreatedAtFromId('c0ffee-1234-5678')).toBeUndefined();
    expect(sessionCreatedAtFromId('')).toBeUndefined();
    expect(sessionCreatedAtFromId('s--1-x')).toBeUndefined();
  });
});
