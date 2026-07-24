import { describe, it, expect } from 'vitest';
import { deriveEngineName, accountChipForEngine, GENERIC_ENGINE_NAME } from './engineName';

describe('deriveEngineName', () => {
  it('maps the dev engine (Claude Agent SDK) to Claude', () => {
    expect(deriveEngineName({ engineId: 'dev-claude' })).toBe('Claude');
    // dev engine wins even if a stray model string points elsewhere.
    expect(deriveEngineName({ engineId: 'dev-claude', liveModel: 'gpt-4o' })).toBe('Claude');
  });

  it('maps provider kinds to short brand names', () => {
    expect(deriveEngineName({ providerKind: 'anthropic' })).toBe('Claude');
    expect(deriveEngineName({ providerKind: 'bedrock' })).toBe('Claude');
    expect(deriveEngineName({ providerKind: 'azure-openai' })).toBe('GPT');
    expect(deriveEngineName({ providerKind: 'openai' })).toBe('GPT');
    expect(deriveEngineName({ providerKind: 'google' })).toBe('Gemini');
    expect(deriveEngineName({ providerKind: 'openai-chatgpt-oauth' })).toBe('ChatGPT');
  });

  it('prefers the provider kind over the model string', () => {
    // A ChatGPT-oauth turn resolves a 'gpt-*' model, but the kind is precise.
    expect(
      deriveEngineName({ providerKind: 'openai-chatgpt-oauth', liveModel: 'gpt-4o' }),
    ).toBe('ChatGPT');
  });

  it('falls back to sniffing the live model when no engine/provider is known', () => {
    expect(deriveEngineName({ liveModel: 'claude-3-5-sonnet-20241022' })).toBe('Claude');
    expect(deriveEngineName({ liveModel: 'gpt-4o-mini' })).toBe('GPT');
    expect(deriveEngineName({ liveModel: 'gemini-2.0-flash' })).toBe('Gemini');
    expect(deriveEngineName({ liveModel: 'ChatGPT-4o-latest' })).toBe('ChatGPT');
  });

  it('checks chatgpt before gpt so a chatgpt model is not mislabeled', () => {
    expect(deriveEngineName({ liveModel: 'chatgpt-4o' })).toBe('ChatGPT');
  });

  it('returns the generic name when nothing identifies the engine', () => {
    expect(deriveEngineName({})).toBe(GENERIC_ENGINE_NAME);
    expect(deriveEngineName({ liveModel: '' })).toBe(GENERIC_ENGINE_NAME);
    expect(deriveEngineName({ providerKind: 'unknown-kind' })).toBe(GENERIC_ENGINE_NAME);
    expect(deriveEngineName({ engineId: 'ai-sdk', liveModel: 'llama-3' })).toBe(GENERIC_ENGINE_NAME);
  });

  it('ignores an unknown provider kind and still uses the model fallback', () => {
    expect(deriveEngineName({ providerKind: 'mystery', liveModel: 'gemini-pro' })).toBe('Gemini');
  });
});

describe('accountChipForEngine', () => {
  it('shows the ChatGPT chip for the ChatGPT subscription provider', () => {
    expect(
      accountChipForEngine({ engineId: 'ai-sdk', selectedProvider: 'openai-chatgpt-oauth' }),
    ).toBe('chatgpt');
  });

  it('shows no chip for a plain API-key provider (a key is not an account)', () => {
    expect(accountChipForEngine({ engineId: 'ai-sdk', selectedProvider: 'azure-openai' })).toBe('none');
    expect(accountChipForEngine({ engineId: 'ai-sdk', selectedProvider: 'openai' })).toBe('none');
    // ai-sdk with no explicit provider is still an API-key path → no account chip.
    expect(accountChipForEngine({ engineId: 'ai-sdk', selectedProvider: null })).toBe('none');
  });

  it('shows the Claude chip for the dev-claude subscription engine', () => {
    expect(accountChipForEngine({ engineId: 'dev-claude', selectedProvider: null })).toBe('claude');
    // A stray selectedProvider does not matter when the engine is dev-claude.
    expect(accountChipForEngine({ engineId: 'dev-claude', selectedProvider: 'azure-openai' })).toBe(
      'claude',
    );
  });

  it('defaults to the Claude chip while the engine is unknown/loading', () => {
    // Null engine id (before the first /api/naby read) → Claude chip, which
    // self-hides when the dev engine is not part of this build.
    expect(accountChipForEngine({ engineId: null, selectedProvider: null })).toBe('claude');
  });
});
