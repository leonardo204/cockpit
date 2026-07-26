import { describe, it, expect } from 'vitest';
import { CLAUDE_MODELS, claudeOptionsFrom, type LiveModel } from './modelCatalog';

/**
 * The Claude model list is now LIVE — asked of the local sign-in rather than
 * hardcoded, so a newly released model needs no rebuild. These pin the two things
 * that make that safe: an empty or failed answer must not empty the picker, and the
 * live rows must not be reshaped into something less accurate than the SDK said.
 */

// Shape taken verbatim from a real probe of a signed-in machine.
const LIVE: LiveModel[] = [
  {
    value: 'default',
    displayName: 'Default (recommended)',
    description: 'Opus 4.8 with 1M context · Best for everyday, complex work',
    resolvedModel: 'claude-opus-4-8[1m]',
  },
  { value: 'opus[1m]', displayName: 'Opus', description: 'Opus 4.8 with 1M context', resolvedModel: 'claude-opus-4-8[1m]' },
  { value: 'sonnet', displayName: 'Sonnet', description: 'Sonnet 5 · Efficient for routine tasks', resolvedModel: 'claude-sonnet-5' },
];

describe('claudeOptionsFrom', () => {
  it('uses the live list when there is one, values and labels verbatim', () => {
    const opts = claudeOptionsFrom(LIVE);
    expect(opts.map((o) => o.value)).toEqual(['default', 'opus[1m]', 'sonnet']);
    expect(opts[0]!.label).toBe('Default (recommended)');
    // The value is what gets SENT as the turn's model, so it must survive exactly —
    // `opus[1m]` is not `opus`.
    expect(opts[1]!.value).toBe('opus[1m]');
    expect(opts[2]!.hint).toContain('Efficient for routine tasks');
  });

  it('does NOT add an empty "default" row on top of the SDK\'s own', () => {
    // Two rows both meaning "let Claude pick" is what makes a picker look broken.
    expect(claudeOptionsFrom(LIVE).filter((o) => o.value === '')).toHaveLength(0);
  });

  it('falls back to the curated list when the probe gave nothing', () => {
    // Not signed in, SDK missing, CLI timed out — none of them may empty the picker.
    expect(claudeOptionsFrom(null)).toEqual(CLAUDE_MODELS);
    expect(claudeOptionsFrom(undefined)).toEqual(CLAUDE_MODELS);
    expect(claudeOptionsFrom([])).toEqual(CLAUDE_MODELS);
  });

  it('the fallback offers ALIASES, never pinned version ids', () => {
    // An alias resolves to whatever the plan grants, so the fallback cannot
    // advertise a model the user does not have — and cannot claim a version number
    // that has since moved on.
    for (const o of CLAUDE_MODELS) {
      expect(o.value).not.toMatch(/\d/);
      expect(o.label).not.toMatch(/\d/);
    }
  });

  it('survives a row with no description', () => {
    const opts = claudeOptionsFrom([{ value: 'x', displayName: 'X' }]);
    expect(opts).toEqual([{ value: 'x', label: 'X' }]);
  });
});
