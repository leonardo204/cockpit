import { describe, it, expect } from 'vitest';
import {
  CLAUDE_CONTEXT_WINDOW,
  FALLBACK_CONTEXT_WINDOW,
  contextWindowFor,
} from '../../../../../../../dist/naby-runtime.mjs';

/**
 * The context-window registry (specs/session-context-management.md §2.1) — the
 * DENOMINATOR of the status-bar gauge and of the AI-SDK engine's fold threshold.
 *
 * It is asserted from the SHELL side because the shell is the consumer that turns
 * a wrong answer into a wrong number on screen. The one rule that matters more than
 * any individual size: an unknown model answers `undefined`, so the gauge hides its
 * ratio instead of dividing by a guess.
 *
 * The ids below are the ones this codebase actually produces — `describeProviders`
 * defaults, the client model catalog's slugs, and the Agent SDK's aliases.
 */
describe('contextWindowFor', () => {
  it('knows the Claude family, by id and by alias', () => {
    expect(contextWindowFor('ai-sdk', 'claude-sonnet-4-5')).toBe(CLAUDE_CONTEXT_WINDOW);
    // Bedrock's inference-profile ids carry the same model name.
    expect(contextWindowFor('ai-sdk', 'anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe(200_000);
    for (const alias of ['opus', 'sonnet', 'haiku', 'fable']) {
      expect(contextWindowFor('dev-claude', alias)).toBe(200_000);
    }
  });

  it('answers for the Claude sign-in even when NO model was requested', () => {
    // The Agent SDK resolves the sign-in's own default, and every model it can
    // resolve to has a 200k window — so an empty model is not an unknown one here.
    expect(contextWindowFor('dev-claude', '')).toBe(CLAUDE_CONTEXT_WINDOW);
    expect(contextWindowFor('dev-claude', undefined)).toBe(CLAUDE_CONTEXT_WINDOW);
  });

  it('treats an empty model on any OTHER engine as unknown', () => {
    // A provider's default could be anything; guessing it is exactly what the
    // undefined answer exists to prevent.
    expect(contextWindowFor('ai-sdk', '')).toBeUndefined();
    expect(contextWindowFor('ai-sdk', undefined)).toBeUndefined();
  });

  it('knows the OpenAI families, and does not let 4.1 fall through to 4o', () => {
    expect(contextWindowFor('ai-sdk', 'gpt-4o')).toBe(128_000);
    expect(contextWindowFor('ai-sdk', 'gpt-4o-mini')).toBe(128_000);
    expect(contextWindowFor('ai-sdk', 'gpt-4.1')).toBe(1_047_576);
    expect(contextWindowFor('ai-sdk', 'gpt-4.1-mini')).toBe(1_047_576);
    // GPT-5 and the ChatGPT/codex slugs: 272k INPUT (the quoted 400k is the total,
    // of which 128k is reserved for output — this gauge measures input).
    expect(contextWindowFor('ai-sdk', 'gpt-5')).toBe(272_000);
    expect(contextWindowFor('ai-sdk', 'gpt-5.6-sol')).toBe(272_000);
    expect(contextWindowFor('ai-sdk', 'gpt-5.4-mini')).toBe(272_000);
    // o-series reasoning models.
    expect(contextWindowFor('ai-sdk', 'o3')).toBe(200_000);
    expect(contextWindowFor('ai-sdk', 'o4-mini')).toBe(200_000);
  });

  it('knows Gemini', () => {
    expect(contextWindowFor('ai-sdk', 'gemini-2.5-pro')).toBe(1_048_576);
    expect(contextWindowFor('ai-sdk', 'gemini-1.5-flash')).toBe(1_048_576);
  });

  it('is case- and whitespace-insensitive, because model ids arrive as typed', () => {
    expect(contextWindowFor('ai-sdk', '  Claude-Sonnet-4-5 ')).toBe(200_000);
  });

  it('answers UNDEFINED for anything it does not know — the load-bearing case', () => {
    expect(contextWindowFor('ai-sdk', 'my-azure-deployment')).toBeUndefined();
    expect(contextWindowFor('ai-sdk', 'llama-3.1-70b')).toBeUndefined();
    expect(contextWindowFor('ai-sdk', 'mistral-large')).toBeUndefined();
  });

  it('keeps the compaction fallback separate from the gauge answer', () => {
    // The gauge hides its ratio for an unknown model; compaction cannot hide, so it
    // folds against the smallest window any supported provider ships.
    expect(FALLBACK_CONTEXT_WINDOW).toBe(128_000);
    expect(contextWindowFor('ai-sdk', 'llama-3.1-70b') ?? FALLBACK_CONTEXT_WINDOW).toBe(128_000);
  });
});
