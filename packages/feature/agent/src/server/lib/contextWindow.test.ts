import { describe, it, expect } from 'vitest';
import {
  CLAUDE_CONTEXT_WINDOW,
  CLAUDE_1M_CONTEXT_WINDOW,
  CONTEXT_1M_BETA,
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

  // -- the long-context tier ------------------------------------------------
  //
  // A Claude subscription run can be on a 1M window, and NOTHING IN OUR OWN
  // CONFIGURATION SAYS SO — the plan decides it. Two signals reach us from the run
  // itself, and each on its own has to be enough: a turn that reported 293k on
  // what we called a 200k window is what sent us looking.

  it('reads the 1M tier off the CONCRETE model id', () => {
    // Observed from a live subscription run: the SDK reports the tier in brackets
    // on the id it actually served.
    expect(contextWindowFor('dev-claude', 'claude-opus-5[1m]')).toBe(CLAUDE_1M_CONTEXT_WINDOW);
    expect(CLAUDE_1M_CONTEXT_WINDOW).toBe(1_000_000);
    // Other punctuations of the same marker, so a differently-formatted id is not
    // silently read as an ordinary 200k model.
    expect(contextWindowFor('dev-claude', 'claude-sonnet-5-1m')).toBe(CLAUDE_1M_CONTEXT_WINDOW);
    // The marker must STAND ALONE — a version fragment that merely contains the
    // characters is not a tier.
    expect(contextWindowFor('dev-claude', 'claude-sonnet-41m-preview')).toBe(CLAUDE_CONTEXT_WINDOW);
  });

  it('reads the 1M tier off the betas the RUN negotiated', () => {
    // The Agent SDK's init message reports what the CLI actually enabled, which is
    // the only signal when the served id carries no marker.
    expect(CONTEXT_1M_BETA).toBe('context-1m-2025-08-07');
    expect(
      contextWindowFor('dev-claude', 'claude-opus-5', { betas: [CONTEXT_1M_BETA] }),
    ).toBe(CLAUDE_1M_CONTEXT_WINDOW);
    // …including for the sign-in default, which names no model at all.
    expect(contextWindowFor('dev-claude', '', { betas: [CONTEXT_1M_BETA] })).toBe(
      CLAUDE_1M_CONTEXT_WINDOW,
    );
  });

  it('does NOT apply the 1M tier to a run that did not report it', () => {
    // The mirror-image error: reporting 1M by default would understate fullness on
    // every ordinary turn. Absence of the signal means the ordinary window.
    expect(contextWindowFor('dev-claude', 'claude-opus-5')).toBe(CLAUDE_CONTEXT_WINDOW);
    expect(contextWindowFor('dev-claude', 'claude-opus-5', { betas: [] })).toBe(
      CLAUDE_CONTEXT_WINDOW,
    );
    expect(
      contextWindowFor('dev-claude', 'claude-opus-5', { betas: ['some-other-beta'] }),
    ).toBe(CLAUDE_CONTEXT_WINDOW);
    // …and the beta says nothing about a NON-Claude model.
    expect(contextWindowFor('ai-sdk', 'gpt-4o', { betas: [CONTEXT_1M_BETA] })).toBe(128_000);
  });

  it('still answers UNDEFINED for the "default" row the Agent SDK offers', () => {
    // The row the model picker shows as "let Claude pick". It is a real, common
    // `model` value and it names no window, which is exactly why the engines now
    // report the CONCRETE id — the registry has no way to size this one and must
    // not pretend otherwise.
    expect(contextWindowFor('dev-claude', 'default')).toBeUndefined();
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
