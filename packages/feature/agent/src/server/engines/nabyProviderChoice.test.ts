import { describe, it, expect, afterAll, afterEach, beforeAll } from 'vitest';
import { getStore, resolveMeteredProvider } from './naby';
import {
  clearCredentialBridge,
  installCredentialBridge,
  readSettings,
  writeSettings,
  type ProviderProfile,
} from '../../../../../../../dist/naby-runtime.mjs';

/**
 * THE PROVIDER THE USER PICKED IS THE PROVIDER THAT ANSWERS.
 *
 * The bug these pin: `preflight` and `selectEngine` were both handed the stored
 * choice (`toSelectOptions(readSettings(store))`), but the branch that actually
 * BUILDS the model resolved a credential with no providerId at all. Unforced,
 * `resolveProviderCredential` returns the FIRST profile holding a key — so a
 * user who picked Google got Azure, while the chat header, the preflight log and
 * the engine summary all said Google. Nothing failed; the wrong provider simply
 * answered, and the app's own explanation of itself was wrong.
 *
 * NO NETWORK AND NO REAL VAULT: the credential bridge is a fake, exactly as the
 * Electron main process would install one, so what runs here is the production
 * resolution path with a stub at the far end.
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

/** Azure FIRST, deliberately: the original defect was "whichever sorts first
 *  wins", so a list whose head is not the chosen provider is the only list that
 *  can catch it. */
const PROFILES: ProviderProfile[] = [AZURE, GOOGLE];

/** Install a fake vault. `keyed` decides which profiles have a stored key. */
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
  // Back to "automatic" so no case can inherit the previous one's choice.
  writeSettings(getStore(), { selectedProvider: '', enginePreference: '' });
});

describe('resolveMeteredProvider — the stored choice reaches the credential', () => {
  it('resolves the SELECTED provider even when another profile sorts first', async () => {
    installBridge();
    const store = getStore();
    writeSettings(store, { enginePreference: 'ai-sdk', selectedProvider: 'google' });

    const resolved = await resolveMeteredProvider(readSettings(store));

    expect(resolved?.profile.id).toBe('google');
    expect(resolved?.profile.model).toBe('gemini-2.5-pro');
    // The key that travels is the SELECTED provider's key, not the first one
    // found — the same defect seen from the credential side.
    expect(resolved?.apiKey).toBe('key-for-google');
  });

  it('keeps the old fallback when the user has chosen nothing ("automatic")', async () => {
    installBridge();
    const store = getStore();
    // No selectedProvider written at all — the automatic path.
    const resolved = await resolveMeteredProvider(readSettings(store));

    expect(resolved?.profile.id).toBe('azure-openai');
    expect(resolved?.apiKey).toBe('key-for-azure-openai');
  });

  it('does not fall through to another provider when the chosen one has no key', async () => {
    // Only Azure is keyed; the user picked Google. Answering on Azure here is
    // precisely the silent substitution this whole file exists to forbid.
    installBridge(['azure-openai']);
    const store = getStore();
    writeSettings(store, { enginePreference: 'ai-sdk', selectedProvider: 'google' });

    expect(await resolveMeteredProvider(readSettings(store))).toBeNull();
  });

  it('carries the turn\'s requested model onto the chosen provider', async () => {
    // The session model picker's end of the wire (task 4): the picked slug rides
    // in as `requestedModel` and must replace the profile's model WITHOUT
    // changing which provider answers.
    installBridge();
    const store = getStore();
    writeSettings(store, { enginePreference: 'ai-sdk', selectedProvider: 'google' });

    const resolved = await resolveMeteredProvider(readSettings(store), 'gemini-2.5-flash');

    expect(resolved?.profile.id).toBe('google');
    expect(resolved?.profile.model).toBe('gemini-2.5-flash');
  });

  it('honours NABY_PROVIDER when the user has chosen nothing', async () => {
    // The developer/CI path still works, and still sits BELOW an explicit UI
    // choice (runtime/settings.ts precedence).
    installBridge();
    process.env.NABY_PROVIDER = 'google';
    try {
      const resolved = await resolveMeteredProvider(readSettings(getStore()));
      expect(resolved?.profile.id).toBe('google');
    } finally {
      delete process.env.NABY_PROVIDER;
    }
  });
});
