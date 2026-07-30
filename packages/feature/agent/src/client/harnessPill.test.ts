import { describe, it, expect, beforeEach } from 'vitest';
import i18n from '@cockpit/shared-i18n';
import { renderHarnessPill } from './harnessPill';
import { applyStreamEvent } from './applyStreamEvent';
import type { ChatMessage } from './types';

/**
 * THE ROUTING-GATE PILL (P3-M9, G2).
 *
 * The engine runs in the Next server, which has no locale, so a pill that speaks
 * to the USER is emitted as a CODE and turned into a sentence here — the same
 * split `growthReport.change` already uses. Two things are worth holding down:
 * that both languages actually exist (a missing key would silently render the
 * English default and nobody would notice in an English test run), and that
 * every OTHER pill still renders exactly as it did before.
 */
describe('harnessPill — codes become sentences, in the user’s language', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('names the agent and says the turn ran unrouted', async () => {
    const { label, detail } = renderHarnessPill('routing-gate', 'not-butterfly:scout');
    expect(label).toBe('not delegated');
    expect(detail).toContain('@scout');
    expect(detail).toMatch(/butterfly/i);
    expect(detail).toMatch(/normal turn/i);
  });

  it('has real Korean copy, not the English fallback', async () => {
    await i18n.changeLanguage('ko');
    const { label, detail } = renderHarnessPill('routing-gate', 'not-butterfly:scout');
    expect(label).toBe('위임하지 않음');
    expect(detail).toContain('@scout');
    expect(detail).toContain('나비');
    // Guards against a missing ko key falling through to the en defaultValue.
    expect(detail).not.toMatch(/butterfly/i);
  });

  it('passes every other harness pill through untouched', () => {
    // The autonomy step bar is already language-neutral bookkeeping and is built
    // server-side; translating it would be a regression, not an improvement.
    expect(renderHarnessPill('autonomy', 'step 2/4 — continuing')).toEqual({
      label: 'autonomy',
      detail: 'step 2/4 — continuing',
    });
    expect(renderHarnessPill('compaction', undefined)).toEqual({ label: 'compaction' });
    expect(renderHarnessPill(undefined, undefined)).toEqual({ label: 'harness event' });
  });

  it('leaves an unrecognised routing-gate detail alone rather than guessing', () => {
    expect(renderHarnessPill('routing-gate', 'some-future-code')).toEqual({
      label: 'routing-gate',
      detail: 'some-future-code',
    });
  });
});

describe('applyStreamEvent — the gate pill reaches the transcript as a muted row', () => {
  const opts = { assistantId: 'a1' };
  const bubble: ChatMessage[] = [{ id: 'a1', role: 'assistant', content: '' } as ChatMessage];

  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('renders one system/meta row, above the assistant bubble', () => {
    const out = applyStreamEvent(bubble, {
      type: 'system',
      subtype: 'harness',
      harness_subtype: 'routing-gate',
      harness_detail: 'not-butterfly:scout',
    }, opts);
    expect(out).toHaveLength(2);
    expect(out[0]!.role).toBe('system');
    expect(out[0]!.content).toContain('not delegated');
    expect(out[0]!.content).toContain('@scout');
    // Above the bubble: these happen around the START of a turn, so appending
    // would read as "the harness spoke after the answer".
    expect(out[1]!.id).toBe('a1');
  });

  it('is idempotent on a replayed event, and keyed on the CODE not the language', async () => {
    const ev = {
      type: 'system',
      subtype: 'harness',
      harness_subtype: 'routing-gate',
      harness_detail: 'not-butterfly:scout',
    };
    const once = applyStreamEvent(bubble, ev, opts);
    // A reconnect snapshot re-runs the reducer; the row must not stack up.
    expect(applyStreamEvent(once, ev, opts)).toBe(once);
    // …and switching locale mid-stream must not make it look like a new row.
    await i18n.changeLanguage('ko');
    expect(applyStreamEvent(once, ev, opts)).toBe(once);
  });
});
