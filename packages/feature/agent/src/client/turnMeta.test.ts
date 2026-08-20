import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import i18n from '@cockpit/shared-i18n';
import { formatTurnMeta } from './elapsed';

/**
 * THE CLOSING LINE OF A FINISHED TURN — `12.3초 · 오후 2:15`.
 *
 * Two halves, and they fail differently. What the line SAYS is decided by a
 * pure function and is tested as one. WHERE it is drawn and whether the user
 * has to hover to see it are CSS and JSX facts that no assertion in this suite
 * can observe — there is no jsdom here, and even with one, jsdom has no layout
 * and would report a hidden element as present. So the second half is a source
 * assertion, the same instrument `messageBubbleStretch` and
 * `sidebarPopoverClipping` use for the same reason.
 */

const SRC = join(__dirname, 'MessageBubble.tsx');

describe('turn meta — what the line says', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('ko');
  });

  it('reads as duration then arrival time, in that order', () => {
    const endedAt = new Date(2026, 7, 19, 14, 15, 0).toISOString();
    expect(formatTurnMeta(12_340, endedAt)).toBe('12.3초 · 오후 2:15');
  });

  it('draws NOTHING for a turn that recorded no measurement', () => {
    // Every turn from before this existed. `null` is what stops an element from
    // being rendered at all — an empty string would still leave a box with
    // margins in the layout.
    expect(formatTurnMeta(undefined, undefined)).toBeNull();
    expect(formatTurnMeta(undefined, new Date().toISOString())).toBeNull();
  });

  it('never prints "undefined초" or a dangling separator', () => {
    // The two ways a half-recorded turn used to leak: an undefined duration
    // interpolated into the unit, and a `· ` with nothing after it because the
    // end time was missing.
    const line = formatTurnMeta(4_000, undefined);
    expect(line).toBe('4.0초');
    expect(line).not.toContain('undefined');
    expect(line).not.toContain('·');
    expect(line!.trimEnd()).toBe(line);
  });

  it('ignores a measurement that is not a finite number', () => {
    expect(formatTurnMeta(NaN, undefined)).toBeNull();
    expect(formatTurnMeta(Infinity, undefined)).toBeNull();
  });

  it('an unparseable end time costs the clock, not the whole line', () => {
    expect(formatTurnMeta(12_340, 'not a date')).toBe('12.3초');
  });

  it('follows the UI language, both halves of it', async () => {
    const endedAt = new Date(2026, 7, 19, 14, 15, 0).toISOString();
    await i18n.changeLanguage('en');
    expect(formatTurnMeta(12_340, endedAt)).toBe('12.3s · 2:15 PM');
  });
});

describe('turn meta — where MessageBubble draws it', () => {
  const src = () => readFileSync(SRC, 'utf8');

  /** The rendered element, matched by its test id and read to its closing tag. */
  function metaElement(source: string): string {
    const start = source.indexOf('data-testid="turn-meta"');
    expect(start, 'the turn-meta element moved or was renamed').toBeGreaterThan(-1);
    const open = source.lastIndexOf('<', start);
    const close = source.indexOf('</span>', start);
    return source.slice(open, close);
  }

  it('is visible without hovering', () => {
    // The creation timestamp beside it is `opacity-0 group-hover:opacity-100`.
    // This line is the thing the user came back to read, so it must not inherit
    // that treatment; nothing here can see it but the class list.
    const el = metaElement(src());
    expect(el).not.toContain('opacity-0');
    expect(el).not.toContain('group-hover');
  });

  it('is gated on a finished ASSISTANT turn', () => {
    // A user message has no turn to measure, and a running turn's number would
    // tick and then settle — which reads as instability, not as information.
    const source = src();
    const guard = /const turnMeta = useMemo\(\(\) => \{([\s\S]*?)\n  \}, \[/.exec(source);
    expect(guard, 'the turnMeta memo moved or was renamed').not.toBeNull();
    expect(guard![1]).toContain('if (isUser || message.isStreaming) return null;');
  });

  it('is memoised, and does not format a clock on every render', () => {
    // MessageBubble is `memo`'d and every open tab stays mounted
    // (shell/CLAUDE.md, React Performance Conventions), so a bare
    // `toLocaleTimeString` in the body would run once per bubble per render of
    // the whole list.
    const source = src();
    expect(source).toMatch(/const turnMeta = useMemo\(/);
    // Both formatters are reached only through the memo.
    const body = source.slice(source.indexOf('export const MessageBubble'));
    const calls = [...body.matchAll(/formatTurn(?:Meta|EndTime|Duration)\(/g)];
    const memoStart = body.indexOf('const turnMeta = useMemo(');
    const memoEnd = body.indexOf('}, [isUser, message.isStreaming');
    expect(memoStart).toBeGreaterThan(-1);
    expect(memoEnd).toBeGreaterThan(memoStart);
    for (const call of calls) {
      expect(call.index, `${call[0]} is called outside the memo`).toBeGreaterThan(memoStart);
      expect(call.index, `${call[0]} is called outside the memo`).toBeLessThan(memoEnd);
    }
  });

  it('re-formats when the language changes', () => {
    // Both halves are localised, and `t` alone does not change identity on a
    // language switch reliably enough to be the only dep.
    const source = src();
    const deps = /\}, \[isUser, message\.isStreaming[^\]]*\]/.exec(source);
    expect(deps, 'the turnMeta dep list moved').not.toBeNull();
    expect(deps![0]).toContain('i18n.language');
    expect(deps![0]).toContain('message.durationMs');
    expect(deps![0]).toContain('message.completedAt');
  });
});
