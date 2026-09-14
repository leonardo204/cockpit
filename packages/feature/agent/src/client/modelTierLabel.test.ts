// What a subagent block prints for the model that served it. Pure — the rules
// mirror the runtime's `tierOfModelId`, so they are pinned here rather than read
// off a screenshot.
import { describe, it, expect } from 'vitest';
import { modelTierLabel, modelTierOf } from './modelTierLabel';

describe('modelTierOf — the runtime’s rule, restated on the client', () => {
  it('reads the tier out of a full Claude id', () => {
    expect(modelTierOf('claude-haiku-4-5-20251001')).toBe('haiku');
    expect(modelTierOf('claude-sonnet-4-5-20250929')).toBe('sonnet');
    expect(modelTierOf('claude-opus-5-20260301')).toBe('opus');
    expect(modelTierOf('claude-fable-5-1')).toBe('fable');
  });

  it('accepts the bare aliases, bracketed suffix and all', () => {
    expect(modelTierOf('opus')).toBe('opus');
    expect(modelTierOf('opus[1m]')).toBe('opus');
    expect(modelTierOf('claude-opus-5[1m]')).toBe('opus');
    expect(modelTierOf(' HAIKU ')).toBe('haiku');
  });

  it('names no tier for things that name no tier', () => {
    // `default` resolves to whatever the sign-in gives, so it is not a tier —
    // the same call the runtime makes.
    expect(modelTierOf('default')).toBeUndefined();
    expect(modelTierOf('gpt-5')).toBeUndefined();
    expect(modelTierOf('')).toBeUndefined();
    expect(modelTierOf(undefined)).toBeUndefined();
  });
});

describe('modelTierLabel — short when it can be, honest when it cannot', () => {
  it('prints the tier word for an id we know', () => {
    expect(modelTierLabel('claude-haiku-4-5-20251001')).toBe('haiku');
  });

  it('prints an UNKNOWN id as itself, because that is the drift worth seeing', () => {
    // A gateway alias or an unreleased build answering a run naby asked to be
    // cheap is precisely the thing this display exists to expose. Hiding it, or
    // guessing a tier for it, would put the block back to saying nothing.
    expect(modelTierLabel('anthropic.claude-x-v9')).toBe('anthropic.claude-x-v9');
    expect(modelTierLabel(' gpt-5 ')).toBe('gpt-5');
  });

  it('says nothing when there is nothing to say', () => {
    expect(modelTierLabel(undefined)).toBe('');
    expect(modelTierLabel('   ')).toBe('');
  });
});
