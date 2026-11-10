import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildMemoryQuery, memoryTierLabelKey, type MemoryFilters } from './MemoryBrowserModal';
import { recentRowKey, scopeTierCopy } from './NabyMemoryReview';

/**
 * MEMORY TIERS — the memory screen's wording and wiring (specs/memory-tiers.md
 * §6, R13, R17, R22), and the chat chips' words (R6, R19). Copy is driven
 * through the real dictionaries so the lines the spec names are pinned as they
 * read; layout is asserted on source, as the other memory UI tests do.
 */

const DIR = __dirname;
const dict = (locale: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(DIR, '../../../..', 'shared/i18n/locales', `${locale}.json`), 'utf8'));
const lookup = (d: Record<string, unknown>, path: string): unknown =>
  path.split('.').reduce<unknown>((cur, part) => (cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[part] : undefined), d);
function translator(locale: 'ko' | 'en') {
  const d = dict(locale);
  return (key: string, opts: Record<string, unknown> = {}): string => {
    const raw = lookup(d, key);
    if (typeof raw !== 'string') throw new Error(`missing ${locale} key ${key}`);
    return raw.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(opts[name]));
  };
}
const ko = translator('ko');
const en = translator('en');

const BROWSER = readFileSync(join(DIR, 'MemoryBrowserModal.tsx'), 'utf8');
const TAB = readFileSync(join(DIR, 'NabyMemoryReview.tsx'), 'utf8');
const CHIP = readFileSync(join(DIR, '../../../agent/src/client/MemoryWriteChip.tsx'), 'utf8');

const BASE: MemoryFilters = {
  scope: 'user',
  status: 'all',
  type: 'all',
  stale: false,
  superseded: false,
  keyPrefix: '',
  search: '',
};

describe('the summary line and the "recently learned" line (§6, R13)', () => {
  it('reads 고정 N · 기억 N · 최근 N when the server reports tiers', () => {
    const copy = scopeTierCopy({ confirmed: 9, anchored: 1, long: 5, short: 3 });
    expect(ko(copy.key, copy.values)).toBe('고정 1 · 기억 5 · 최근 3');
    const old = scopeTierCopy({ confirmed: 9 });
    expect(ko(old.key, old.values)).toBe('확정 9건');
  });

  it('archival is one quiet line a day', () => {
    expect(ko(recentRowKey('archived'), { count: 4 })).toBe('기억 4개를 보관했어요');
    expect(en(recentRowKey('archived'), { count: 4 })).toBe('Archived 4 memories');
  });

  it('the spec\'s sentences, as they read', () => {
    expect(ko('memoryReview.tierGraceNotice')).toBe('30일 뒤부터 오래 안 쓴 기억을 보관해요');
    expect(ko('memoryReview.anchorFullTitle')).toBe('고정 기억이 가득 찼어요');
    expect(ko('chat.memoryChip.anchoredExplicit', { value: 'A' })).toBe('고정했어요: A');
    expect(ko('chat.memoryChip.anchoredAuto', { value: 'A' })).toBe('자주 말씀하신 걸 고정했어요: A');
    expect(ko('chat.memoryChip.anchoredConflict', { anchored: 'A' })).toBe('고정 기억 ‹A›과 달라서 고정 기억대로 할게요');
    expect(ko('chat.memoryChip.replaceAnchored')).toBe('새 내용으로 바꾸기');
    expect(ko('chat.memoryChip.cancel')).toBe('취소');
  });
});

describe('the browser (§6)', () => {
  it('sends the tier and archived filters to the server, and nothing when they are off', () => {
    const off = new URLSearchParams(buildMemoryQuery(BASE, { limit: 50, offset: 0 }));
    expect(off.has('tier')).toBe(false);
    expect(off.has('archived')).toBe(false);
    const on = new URLSearchParams(buildMemoryQuery({ ...BASE, tier: 'anchored', archived: true }, { limit: 50, offset: 0 }));
    expect(on.get('tier')).toBe('anchored');
    expect(on.get('archived')).toBe('1');
  });

  it('labels each tier; a proposal has none', () => {
    expect(ko(memoryTierLabelKey({ tier: 'anchored' })!)).toBe('고정 기억');
    expect(ko(memoryTierLabelKey({ tier: 'long' })!)).toBe('기억');
    expect(ko(memoryTierLabelKey({ tier: 'short' })!)).toBe('최근 기억');
    expect(memoryTierLabelKey({})).toBeUndefined();
  });

  it('offers 되살리기 with the days left on archived rows, 고정 on long rows, 고정 풀기 on anchored rows', () => {
    expect(BROWSER).toContain("t('memoryReview.archivedBadge', { count: daysLeft ?? 0 })");
    expect(BROWSER).toMatch(/isArchived \? \([^]*memoryReview\.restore/);
    expect(BROWSER).toMatch(/item\.tier === 'long' \? \([^]*memoryReview\.pin'/);
    expect(BROWSER).toMatch(/item\.tier === 'anchored' \? \([^]*memoryReview\.anchoredUnpin/);
    expect(BROWSER).toContain('data-testid="memory-archived-chip"');
    expect(ko('memoryReview.archivedBadge', { count: 12 })).toBe('보관됨 · 12일 남음');
  });
});

describe('the memory tab (§6)', () => {
  it('opens anchored memory from a button beside 전체 보기, each row with edit and unpin', () => {
    // Inline, the list grew with every pin; behind a button it is one row.
    const buttonAt = TAB.indexOf('data-testid="memory-open-anchored"');
    expect(buttonAt).toBeGreaterThan(0);
    expect(buttonAt).toBeLessThan(TAB.indexOf('data-testid="memory-open-browser"'));
    expect(TAB).toContain('testId="memory-anchored"');
    expect(TAB).not.toMatch(/anchored\.map\([^]*data-testid="memory-summary"/);
    expect(TAB).toContain("t('memoryReview.anchoredEdit')");
    expect(TAB).toContain("t('memoryReview.anchoredUnpin')");
    expect(TAB).toContain('data-testid="memory-anchor-full"');
    expect(ko('memoryReview.openAnchored', { count: 4 })).toBe('고정 기억 보기 (4)');
  });

  it('every new key exists in both locales', () => {
    const keys = new Set<string>();
    for (const src of [BROWSER, TAB, CHIP]) {
      for (const m of src.matchAll(/'((?:memoryReview|chat\.memoryChip)\.[A-Za-z]+)'/g)) keys.add(m[1]!);
    }
    for (const key of keys) {
      expect(() => ko(key, {}), key).not.toThrow();
      expect(() => en(key, {}), key).not.toThrow();
    }
  });
});
