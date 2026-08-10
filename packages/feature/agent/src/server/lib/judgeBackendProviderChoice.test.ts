import { describe, it, expect, afterAll, afterEach, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveJudgeBackend, selectedJudgeProviderId } from './reflection';
import {
  clearCredentialBridge,
  installCredentialBridge,
  isClaudeAgentSdkAvailable,
  SETTING_KEYS,
  type ProviderProfile,
} from '../../../../../../../dist/naby-runtime.mjs';

/**
 * THE PROVIDER THE USER PICKED IS THE PROVIDER THE BACKGROUND CALLS BILL.
 *
 * The sibling of `engines/nabyProviderChoice.test.ts`, for the other half of the
 * same defect. That one pinned the TURN path (`resolveMeteredProvider`). This one
 * pins everything that calls a model BESIDE the turn — the reflection judge, the
 * handoff summariser and the naby voice layer, which run through one function:
 * `resolveJudgeBackend`.
 *
 * The defect: `resolveJudgeBackend` called `resolveProviderCredential({})` with no
 * providerId at all, and unforced that returns the FIRST profile holding a key. A
 * user who picked Google had their reflection sweeps, their handoffs and — via the
 * voice layer, which runs on EVERY turn — their rewrites billed to Azure, while
 * every label in the app said Google. Nothing failed; the wrong account paid.
 *
 * THE FAILURE RULE IS THE OTHER HALF, and it is what the middle case is about.
 * When the chosen provider cannot be resolved, the answer is NOT "try the next
 * key". Falling through to another metered key IS the bug — an unrelated account
 * is charged for a call the user never aimed there. The only fallback allowed is
 * the Claude subscription, which costs nothing per message and so cannot surprise
 * anyone with a bill.
 *
 * NO NETWORK AND NO REAL VAULT: the credential bridge is a fake, exactly as the
 * Electron main process would install one, so what runs here is the production
 * resolution path with a stub at the far end. Nothing in this file drives an
 * engine — `resolveJudgeBackend` only CONSTRUCTS one.
 */

const AZURE: ProviderProfile = {
  id: 'azure-openai',
  label: 'Azure OpenAI',
  kind: 'azure-openai',
  config: {
    kind: 'azure-openai',
    deployment: 'gpt-4o',
    baseURL: 'https://example.services.ai.azure.com/openai/v1',
  },
  model: 'gpt-4o',
  credentialRef: 'vault:azure-openai',
};

const GOOGLE: ProviderProfile = {
  id: 'google',
  label: 'Google Gemini',
  kind: 'google',
  config: { kind: 'google' },
  model: 'gemini-2.5-pro',
  credentialRef: 'vault:google',
};

/** Azure FIRST, deliberately: the defect was "whichever sorts first wins", so a
 *  list whose head is not the chosen provider is the only list that can catch it. */
const PROFILES: ProviderProfile[] = [AZURE, GOOGLE];

function installBridge(keyed: readonly string[] = ['azure-openai', 'google']) {
  installCredentialBridge({
    listProfiles: () => PROFILES,
    getKey: (providerId: string) => (keyed.includes(providerId) ? `key-for-${providerId}` : null),
    security: () => ({ backend: 'test', secure: true, warning: null }),
  });
}

/** The env fallbacks sit BELOW the vault but above "nothing", and a developer's
 *  shell may well have them set — which would answer the "no key" cases with a
 *  real profile and quietly pass the test for the wrong reason. */
const ENV_KEYS = [
  'NABY_PROVIDER',
  'NABY_MODEL',
  'NABY_ANTHROPIC_API_KEY',
  'NABY_BEDROCK_API_KEY',
  'NABY_AZURE_OPENAI_API_KEY',
  'NABY_GOOGLE_API_KEY',
  'NABY_OPENAI_API_KEY',
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

afterEach(() => {
  clearCredentialBridge();
});

/** The one label the metered branch produces, for the provider named. Written
 *  here rather than asserted loosely so a rename of the label is a test failure
 *  and not a silently weakened check. */
const aiSdkLabel = (providerId: string) => `ai-sdk (${providerId})`;
const SUBSCRIPTION_LABEL = 'claude-agent-sdk (subscription)';

describe('resolveJudgeBackend — the stored choice reaches the background call', () => {
  it('resolves the SELECTED provider even when another profile sorts first', async () => {
    installBridge();

    const backend = await resolveJudgeBackend({ providerId: 'google' });

    expect(backend?.label).toBe(aiSdkLabel('google'));
    // The label is for the log line; `model` is what the engine actually runs on,
    // and the two must name the same provider or the log is a lie.
    expect(backend?.model.providerId).toBe('google');
    expect(backend?.model.model).toBe('gemini-2.5-pro');
  });

  it('does NOT fall through to another metered key when the chosen provider has none', async () => {
    // Only Azure is keyed; the user picked Google. Answering on Azure here is
    // precisely the silent substitution — and the surprise bill — this whole file
    // exists to forbid.
    installBridge(['azure-openai']);

    const backend = await resolveJudgeBackend({ providerId: 'google' });

    // Machine-independent, because the ALLOWED fallback depends on whether this
    // computer has a Claude sign-in. Both spellings of the rule are asserted: the
    // forbidden outcome directly, and the permitted set exhaustively.
    expect(backend?.label).not.toBe(aiSdkLabel('azure-openai'));
    expect(backend?.model.providerId).not.toBe('azure-openai');
    if (isClaudeAgentSdkAvailable()) {
      expect(backend?.label).toBe(SUBSCRIPTION_LABEL);
    } else {
      expect(backend).toBeUndefined();
    }
  });

  it('keeps the old fallback when the user has chosen nothing ("automatic")', async () => {
    installBridge();

    const backend = await resolveJudgeBackend();

    expect(backend?.label).toBe(aiSdkLabel('azure-openai'));
    expect(backend?.model.providerId).toBe('azure-openai');
  });

  it('treats an empty choice as automatic rather than as a provider named ""', async () => {
    installBridge();

    const backend = await resolveJudgeBackend({ providerId: '' });

    expect(backend?.label).toBe(aiSdkLabel('azure-openai'));
  });
});

describe('selectedJudgeProviderId — one spelling of "which provider did the user pick"', () => {
  /** The narrow slice, exactly what the callers hand it: a settings reader. */
  const storeWith = (settings: Record<string, string>) => ({
    getSetting: (key: string) => settings[key],
  });

  it('reads the same settings row the turn path reads', () => {
    // The key comes from the runtime's own map, so this test cannot pass while
    // naming a row the turn path does not use.
    expect(selectedJudgeProviderId(storeWith({ [SETTING_KEYS.selectedProvider]: 'google' }))).toBe(
      'google',
    );
  });

  it('reads "automatic" as no choice at all', () => {
    expect(selectedJudgeProviderId(storeWith({}))).toBeUndefined();
    expect(selectedJudgeProviderId(storeWith({ [SETTING_KEYS.selectedProvider]: '   ' }))).toBeUndefined();
  });
});

/**
 * THE WIRING, ASSERTED AT THE SOURCE.
 *
 * Four callers reach `resolveJudgeBackend`, and a fix that widened the signature
 * without threading the choice through all four would leave the bug alive on the
 * paths it was reported from. None of the four can be checked behaviourally
 * without driving a real model call — the failure mode is "the wrong provider
 * ANSWERS", which requires an answer — so the check is a source assertion, the
 * same honest compromise `messageBubbleStretch.test.ts` makes for a defect jsdom
 * cannot see.
 */
describe('the four callers actually pass the choice', () => {
  const read = (...parts: string[]) => readFileSync(join(__dirname, ...parts), 'utf8');

  it('voice.ts resolves the backend with the store\'s stored choice', () => {
    const src = read('voice.ts');
    expect(src).toContain('selectedJudgeProviderId(deps.store)');
    // And it is the SHARED resolver, not a copy — §8's rule.
    expect(src).toContain('resolveJudgeBackend(');
  });

  it('kickReflectionSweep builds its default judge from the store it was handed', () => {
    const src = read('reflection.ts');
    expect(src).toContain('judge: ReflectionJudge = modelReflectionJudge(store)');
  });

  it('handoffSummary.ts resolves the backend with the store it was handed', () => {
    const src = read('handoffSummary.ts');
    expect(src).toContain('selectedJudgeProviderId(store)');
  });

  it('the api actions hand their store to both background callers', () => {
    const src = readFileSync(join(__dirname, '..', 'api', 'naby.ts'), 'utf8');
    expect(src).toContain('modelHandoffSummarizer(store)');
    expect(src).toContain('modelReflectionJudge(store)');
  });

  it('the engine hands its store to both paths it starts', () => {
    const src = readFileSync(join(__dirname, '..', 'engines', 'naby.ts'), 'utf8');
    // The sweep: the store IS the wiring, because the default judge is built from
    // it. The voice port: the same store the turn resolved its own provider from.
    expect(src).toContain('kickReflectionSweep(store,');
    // `[^}]` already spans newlines, so no dotAll flag (and no es2018 target
    // requirement) is needed to reach across the comment above the property.
    expect(/createVoicePort\(\{[^}]*\bstore,/.test(src)).toBe(true);
  });
});
