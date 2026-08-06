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

  /**
   * THE COMPACTION PILL (session-context-management §2.3). The AI-SDK engine folds
   * older turns out of the payload; the user is told, in their language, and the
   * two outcomes must not read alike — a fold keeps the material in compressed
   * form, a truncation does not.
   */
  it('says what happened when the conversation was folded into a summary', () => {
    const { label, detail } = renderHarnessPill('context-compaction', 'folded:42');
    expect(label).toMatch(/summary/i);
    expect(detail).toContain('42');
    expect(detail).toMatch(/folded/i);
  });

  it('distinguishes a TRUNCATION from a fold — the user needs to know material is gone', () => {
    const { detail } = renderHarnessPill('context-compaction', 'truncated:7');
    expect(detail).toContain('7');
    expect(detail).toMatch(/dropped/i);
    expect(detail).toMatch(/no summary/i);
  });

  it('has real Korean copy for the compaction pill too', async () => {
    await i18n.changeLanguage('ko');
    const folded = renderHarnessPill('context-compaction', 'folded:42');
    expect(folded.detail).toContain('요약으로 접었습니다');
    expect(folded.detail).not.toMatch(/folded/i);
    const truncated = renderHarnessPill('context-compaction', 'truncated:7');
    expect(truncated.detail).toContain('잘라냈습니다');
  });

  it('leaves a compaction pill with an unrecognised detail exactly as it arrived', () => {
    // Additive by construction: a code this table has never heard of renders as
    // it did before the table existed.
    const { label, detail } = renderHarnessPill('context-compaction', 'something-else');
    expect(label).toBe('context-compaction');
    expect(detail).toBe('something-else');
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

  // -- P3-M12a: the address is honoured, the ACTIONS are narrowed ------------

  it('says the agent answered within its stage, naming both the agent and the stage', async () => {
    const { label, detail } = renderHarnessPill('routing-gate', 'stage-limited:larva:scout');
    expect(label).toBe('acting within its stage');
    expect(detail).toContain('@scout');
    expect(detail).toMatch(/larva/i);
    // The M9 pill said the turn ran as a NORMAL one because the address was
    // refused. It no longer is, so the sentence must not still say that.
    expect(detail).not.toMatch(/normal turn/i);
  });

  it('has real Korean copy for the stage pill too, with the stage name localised', async () => {
    await i18n.changeLanguage('ko');
    const { label, detail } = renderHarnessPill('routing-gate', 'stage-limited:larva:scout');
    expect(label).toBe('단계 범위 안에서 처리함');
    expect(detail).toContain('@scout');
    expect(detail).toContain('애벌레');
    expect(detail).not.toMatch(/larva/i);
  });

  it('keeps an agent name containing a colon intact', () => {
    // Split ONCE: `stage-limited:<stage>:<name>` where the name is the rest.
    const { detail } = renderHarnessPill('routing-gate', 'stage-limited:pupa:a:b');
    expect(detail).toContain('@a:b');
  });

  it('still renders the PRE-M12 code — old transcripts are still scrollable', () => {
    // No longer emitted, but sitting in every transcript recorded before M12a.
    expect(renderHarnessPill('routing-gate', 'not-butterfly:scout').detail).toMatch(/butterfly/i);
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
