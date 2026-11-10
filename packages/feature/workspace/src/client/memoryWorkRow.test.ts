import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  memoryWorkJobLabel,
  memoryWorkKindLabel,
  memoryWorkQueuedLine,
  memoryWorkReasonLabel,
  memoryWorkResultLine,
} from './MemoryWorkRow';

/**
 * "기억 작업" — the settings row's wording (specs/memory-worker.md §2).
 *
 * The copy is pure and driven here through the real dictionaries, so the lines
 * the spec names ("새 기억 3개 검수 중", "2개 적용 · 1개 정리", "모델을 부를 수
 * 없음") are pinned as they will read, in both locales.
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

describe('the memory-work row reads as the spec says', () => {
  it('names the job with its size', () => {
    expect(memoryWorkJobLabel({ kind: 'review', size: 3 }, ko)).toBe('새 기억 3개 검수 중');
    expect(memoryWorkJobLabel({ kind: 'summary', size: 20 }, ko)).toBe('기억 20개 요약 중');
    expect(memoryWorkJobLabel({ kind: 'reflection' }, ko)).toBe('지난 대화 회고 중');
    expect(memoryWorkJobLabel({ kind: 'mystery' }, ko)).toBe('기억 작업 중');
    // memory-tiers: the two tier passes have their own words.
    expect(memoryWorkJobLabel({ kind: 'promote' }, ko)).toBe('기억 단계 정리 중');
    expect(memoryWorkJobLabel({ kind: 'archive' }, ko)).toBe('오래 안 쓴 기억 보관 중');
    expect(memoryWorkResultLine('archive', { archived: 3, purged: 1 }, ko)).toBe('3개 보관 · 1개 삭제');
    expect(memoryWorkResultLine('promote', { long: 2, anchored: 1, full: 0 }, ko)).toBe('2개 장기로 · 1개 고정');
  });

  it('a result is its non-zero counts, joined', () => {
    expect(memoryWorkResultLine('review', { reviewed: 3, applied: 2, merged: 0, held: 1 }, ko)).toBe('2개 적용 · 1개 보류');
    expect(memoryWorkResultLine('tidy', { reviewed: 5, equivalent: 1, refines: 0, contradicts: 0 }, ko)).toBe(
      '5개 살펴봄 · 1개 정리',
    );
    expect(memoryWorkResultLine('summary', { written: 0 }, ko)).toBe('바뀐 것 없음');
  });

  it('a failure is its reason code in words, never a provider message', () => {
    expect(memoryWorkReasonLabel('no-model', ko)).toBe('모델을 부를 수 없음');
    expect(memoryWorkReasonLabel('rate-limited', ko)).toBe('사용량 한도에 걸림');
    expect(memoryWorkReasonLabel('something-new', ko)).toBe('작업이 실패함');
  });

  it('the queue line lists kinds with counts, or says there is nothing', () => {
    expect(memoryWorkQueuedLine({ review: 1, tidy: 1 }, ko)).toBe('대기 중인 작업: 검수 1 · 정리 1');
    expect(memoryWorkQueuedLine({}, ko)).toBe('대기 중인 작업이 없습니다.');
    expect(memoryWorkKindLabel('mystery', ko)).toBe('기타');
    expect(memoryWorkKindLabel('archive', ko)).toBe('보관');
  });

  it('every key the row uses exists in both locales', () => {
    const src = readFileSync(join(DIR, 'MemoryWorkRow.tsx'), 'utf8');
    const keys = [...new Set([...src.matchAll(/'(memoryReview\.[A-Za-z]+)'/g)].map((m) => m[1]!))];
    expect(keys.length).toBeGreaterThan(30);
    for (const locale of ['ko', 'en']) {
      const d = dict(locale);
      for (const key of keys) expect(typeof lookup(d, key), `${locale}: ${key}`).toBe('string');
    }
  });

  it('Korean sentences end in the 합니다 register', () => {
    const d = dict('ko');
    for (const key of ['workQueuedNone', 'workWaitingBackoff', 'workWaitingTurnModel', 'workModeInProcess', 'workHint']) {
      const text = lookup(d, `memoryReview.${key}`) as string;
      expect(text, key).toMatch(/니다\.$/);
    }
  });

  it('the row renders no memory text — counts, kinds and codes only', () => {
    const src = readFileSync(join(DIR, 'MemoryWorkRow.tsx'), 'utf8');
    // No memory row field is ever read by the row.
    expect(src).not.toMatch(/\.(value|evidenceQuote|summary)\b/);
  });
});
