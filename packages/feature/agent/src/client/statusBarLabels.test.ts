import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import en from '../../../../shared/i18n/locales/en.json';
import ko from '../../../../shared/i18n/locales/ko.json';

/**
 * WHAT THE STATUS BAR CALLS THINGS.
 *
 * The row went out reading `창 293k · 턴 입력 293,384 · 출력 768 · Cache 7% · $2.74`
 * and three of those five were reported as unreadable:
 *
 *   * "창" named the mechanism, not the thing the reader is watching fill up. It
 *     is "컨텍스트" now — the name freed up when the OLD "컨텍스트" stat (the turn's
 *     consumption) was renamed "턴 입력".
 *   * "293k" is not an amount of anything. It is a percentage now, estimated and
 *     marked when it has to be (contextGauge.test.ts owns that rule).
 *   * "Cache: 7%" does not say 7% of what, and nothing on screen explained it.
 *
 * These are SOURCE and DICTIONARY assertions rather than rendering ones: the suite
 * has no DOM environment, and what is actually at risk here is a string — a label
 * silently reverting, or an English default shipping in place of a translation.
 */

const BAR = join(__dirname, 'TokenUsageBar.tsx');
const chat = (d: typeof en): Record<string, string> =>
  (d as unknown as { chat: Record<string, string> }).chat;

describe('status bar labels', () => {
  it('calls the window gauge "컨텍스트" / "context", not "창"', () => {
    expect(chat(en).contextWindow).toBe('context');
    expect(chat(ko).contextWindow).toBe('컨텍스트');
    // The name is only free because the other stat took its old one.
    expect(chat(ko).turnInput).toBe('턴 입력');
    expect(chat(en).turnInput).toBe('turn input');
  });

  it('renders the gauge through that key, with a percentage that is never optional', () => {
    const src = readFileSync(BAR, 'utf8');
    expect(src).toContain("t('chat.contextWindow'");
    // The percentage is formatted by the tested helper — which is what puts the
    // `~` on an estimate — rather than interpolated in JSX where the marker could
    // be dropped.
    expect(src).toContain('formatGaugePercent(gauge)');
    // The old "no window → print the bare count" branch is gone. If it comes back,
    // so does the report this fixed.
    expect(src).not.toContain('gauge.percent !== undefined');
  });

  it('explains the cache stat, in both languages', () => {
    expect(chat(en).cacheHit).toBe('Cache hit');
    expect(chat(ko).cacheHit).toBe('캐시 적중');
    // One sentence, and it has to answer "of what?" — the share of THIS turn's
    // input, and why the reader should care that it is high.
    expect(chat(ko).cacheHitHint).toContain('이번 턴 입력');
    expect(chat(ko).cacheHitHint).toContain('프롬프트 캐시');
    expect(chat(ko).cacheHitHint).toContain('높을수록');
    expect(chat(en).cacheHitHint).toContain('prompt cache');
  });

  it('attaches the explanation to the cache stat as a hint the row already uses', () => {
    const src = readFileSync(BAR, 'utf8');
    // A native `title`, like both rate-limit spans and the gauge in this same row.
    // It needs no portal and cannot be clipped by the three-panel layout.
    const cacheSpan = /data-testid="cache-hit-stat"[\s\S]{0,400}?>/.exec(src)?.[0];
    expect(cacheSpan, 'cache stat markup not found — did the row change?').toBeDefined();
    expect(cacheSpan).toContain('title=');
    // THE HINT KEY MOVED OUT OF THE TAG and into `cacheHitTitle()`, because the
    // tooltip is no longer one sentence — it now carries the turn's three input
    // counts too (statusBarTooltips.test.ts owns that content). The binding is
    // still asserted, just in two halves: the span uses that builder, and the
    // builder is the only thing in the file that reads the hint key.
    expect(cacheSpan).toContain('title={cacheHitTitle()}');
    expect(src).toContain("t('chat.cacheHitHint'");
    expect(src).toContain("t('chat.cacheHit'");
  });

  it('translates the approximate-window hint rather than shipping the English default', () => {
    expect(chat(en).contextApproxHint).toContain('Estimated');
    expect(chat(ko).contextApproxHint).toContain('근사치');
    expect(readFileSync(BAR, 'utf8')).toContain("t('chat.contextApproxHint'");
  });
});
