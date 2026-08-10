import { describe, it, expect, afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { readNabyState, runNabyAction } from './naby';
import { getStore } from '../engines/naby';
import {
  clearCredentialBridge,
  installCredentialBridge,
  parseGoogleModelList,
  type ProviderProfile,
} from '../../../../../../../dist/naby-runtime.mjs';

/**
 * THE GEMINI MODEL CATALOGUE, END TO END, WITH NO NETWORK.
 *
 * One Google key opens a whole catalogue, so the model is a CHOICE rather than a
 * string the user has to know and type. Three things have to hold for that to be
 * safe, and all three are asserted here:
 *
 *   1. THE KEY NEVER LEAVES THE SERVER. The lookup resolves the credential in
 *      this process, sends it as a request header, and answers the client with
 *      model IDS. The test asserts the key is absent from the response and that
 *      no request goes out at all when nothing is stored.
 *   2. A FAILED LOOKUP MUST NOT BREAK THE SETTINGS SCREEN. Offline, refused,
 *      timed out, unparseable — every one of them falls back to the cache and
 *      answers `ok`.
 *   3. IT IS CACHED LIKE CLAUDE'S. Same TTL, same explicit refresh, same
 *      settings-row shape, one implementation.
 *
 * `fetch` is stubbed globally: `listGoogleModels` reads `globalThis.fetch` at
 * call time, so this drives the real production path — the action, the credential
 * resolution, the runtime's parser — with the socket removed.
 */

const GOOGLE: ProviderProfile = {
  id: 'google',
  label: 'Google Gemini',
  kind: 'google',
  config: { kind: 'google' },
  model: 'gemini-2.5-pro',
  credentialRef: 'vault:google',
};

const API_KEY = 'AIza-test-key-never-leaves-the-server';

/** A verbatim-shaped slice of the real `v1beta/models` answer: the resource NAME
 *  form, a model that only does embeddings, and a legacy one that does not do
 *  `generateContent` at all. */
const GOOGLE_PAYLOAD = {
  models: [
    {
      name: 'models/gemini-2.5-pro',
      displayName: 'Gemini 2.5 Pro',
      supportedGenerationMethods: ['generateContent', 'countTokens'],
    },
    {
      name: 'models/gemini-2.5-flash',
      displayName: 'Gemini 2.5 Flash',
      supportedGenerationMethods: ['generateContent', 'countTokens'],
    },
    {
      name: 'models/text-embedding-004',
      displayName: 'Embedding 004',
      supportedGenerationMethods: ['embedContent'],
    },
    { name: 'models/gemini-1.0-legacy', supportedGenerationMethods: ['generateMessage'] },
  ],
};

/** The env fallbacks would answer "no key stored" with a real key on a developer's
 *  machine, which would pass the security cases for the wrong reason. */
const ENV_KEYS = ['NABY_PROVIDER', 'NABY_MODEL', 'NABY_GOOGLE_API_KEY'] as const;
const savedEnv: Record<string, string | undefined> = {};

type FetchCall = { url: string; init: RequestInit | undefined };
let calls: FetchCall[] = [];

/** Stub `fetch` with a scripted answer. Returns the recorded calls. */
function stubFetch(answer: () => Promise<unknown> | never) {
  calls = [];
  vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return answer();
  });
}

const okJson = (payload: unknown) => async () =>
  ({ ok: true, status: 200, json: async () => payload }) as unknown as Response;

function installBridge(withKey: boolean) {
  installCredentialBridge({
    listProfiles: () => [GOOGLE],
    getKey: () => (withKey ? API_KEY : null),
    security: () => ({ backend: 'test', secure: true, warning: null }),
  });
}

/** The cache is a settings row; clearing it is how a case starts cold. */
function clearCache() {
  getStore().setSetting('models.google.cache', '');
}

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

beforeEach(() => {
  clearCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearCredentialBridge();
});

describe('models.list — the Gemini catalogue', () => {
  it('returns only the models that can answer a turn, without the `models/` prefix', async () => {
    installBridge(true);
    stubFetch(okJson(GOOGLE_PAYLOAD));

    const res = await runNabyAction({ action: 'models.list', provider: 'google' });

    expect(res.ok).toBe(true);
    expect(res.ok && res.models?.google).toEqual(['gemini-2.5-pro', 'gemini-2.5-flash']);
    expect(res.ok && res.models?.cached).toBe(false);
    // Claude's list is ABSENT rather than empty: it was not asked for.
    expect(res.ok && res.models?.claude).toBeUndefined();
  });

  it('sends the key as a header and never in the URL, and never returns it', async () => {
    installBridge(true);
    stubFetch(okJson(GOOGLE_PAYLOAD));

    const res = await runNabyAction({ action: 'models.list', provider: 'google' });

    expect(calls).toHaveLength(1);
    // A key in a query string ends up in exception messages and proxy logs. The
    // header is the shape that cannot leak it into a string.
    expect(calls[0]!.url).not.toContain(API_KEY);
    expect(calls[0]!.url).toContain('generativelanguage.googleapis.com/v1beta/models');
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers['x-goog-api-key']).toBe(API_KEY);
    // The invariant this whole feature is built around.
    expect(JSON.stringify(res)).not.toContain(API_KEY);
  });

  it('never asks Google anything when no key is stored', async () => {
    installBridge(false);
    stubFetch(okJson(GOOGLE_PAYLOAD));

    const res = await runNabyAction({ action: 'models.list', provider: 'google' });

    expect(calls).toHaveLength(0);
    expect(res.ok).toBe(true);
    expect(res.ok && res.models?.google).toEqual([]);
    expect(res.ok && res.models?.cached).toBe(false);
  });

  it('serves the cache within the day, and probes again on an explicit refresh', async () => {
    installBridge(true);
    stubFetch(okJson(GOOGLE_PAYLOAD));
    await runNabyAction({ action: 'models.list', provider: 'google' });
    expect(calls).toHaveLength(1);

    const second = await runNabyAction({ action: 'models.list', provider: 'google' });
    expect(calls).toHaveLength(1); // still one — the cache answered
    expect(second.ok && second.models?.cached).toBe(true);
    expect(second.ok && second.models?.google).toEqual(['gemini-2.5-pro', 'gemini-2.5-flash']);

    // The refresh button: this is how a model released today shows up today.
    const refreshed = await runNabyAction({
      action: 'models.list',
      provider: 'google',
      refresh: true,
    });
    expect(calls).toHaveLength(2);
    expect(refreshed.ok && refreshed.models?.cached).toBe(false);
  });

  it('falls back to the cache when the probe fails, and stays ok', async () => {
    installBridge(true);
    stubFetch(okJson(GOOGLE_PAYLOAD));
    await runNabyAction({ action: 'models.list', provider: 'google' });

    // Now the network is gone. A settings screen must not break because of it.
    stubFetch(() => {
      throw new Error('getaddrinfo ENOTFOUND');
    });
    const res = await runNabyAction({ action: 'models.list', provider: 'google', refresh: true });

    expect(res.ok).toBe(true);
    expect(res.ok && res.models?.google).toEqual(['gemini-2.5-pro', 'gemini-2.5-flash']);
    expect(res.ok && res.models?.cached).toBe(true);
  });

  it('treats a refusal (bad key) as "could not ask", not as an empty catalogue', async () => {
    installBridge(true);
    stubFetch(okJson(GOOGLE_PAYLOAD));
    await runNabyAction({ action: 'models.list', provider: 'google' });

    stubFetch(async () => ({ ok: false, status: 403, json: async () => ({}) }) as unknown as Response);
    const res = await runNabyAction({ action: 'models.list', provider: 'google', refresh: true });

    expect(res.ok && res.models?.google).toEqual(['gemini-2.5-pro', 'gemini-2.5-flash']);
  });

  it('survives a body that is not the shape Google documents', async () => {
    installBridge(true);
    stubFetch(okJson({ error: { code: 400, message: 'API key not valid' } }));

    const res = await runNabyAction({ action: 'models.list', provider: 'google' });

    expect(res.ok).toBe(true);
    expect(res.ok && res.models?.google).toEqual([]);
  });

  it('leaves the Claude catalogue alone (default provider, separate cache row)', async () => {
    // Written straight into the settings row so no probe is needed: the point is
    // that generalising the cache did not move or reshape Claude's.
    getStore().setSetting(
      'models.claude.cache',
      JSON.stringify({
        fetchedAt: Date.now(),
        claude: [{ value: 'opus', displayName: 'Opus' }],
      }),
    );
    const res = await runNabyAction({ action: 'models.list' });
    expect(res.ok && res.models?.claude).toEqual([{ value: 'opus', displayName: 'Opus' }]);
    expect(res.ok && res.models?.cached).toBe(true);
    expect(res.ok && res.models?.google).toBeUndefined();
  });
});

describe('parseGoogleModelList', () => {
  it('keeps order, drops duplicates and anything that cannot generate content', () => {
    expect(
      parseGoogleModelList({
        models: [
          { name: 'models/b', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/a', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/b', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/c', supportedGenerationMethods: ['embedContent'] },
          { name: 'models/d' },
          { supportedGenerationMethods: ['generateContent'] },
          null,
        ],
      }),
    ).toEqual(['b', 'a']);
  });

  it('reads a broken document as "no models" rather than throwing', () => {
    // It parses a REMOTE document: a shape change at Google must not become an
    // exception inside a settings screen.
    expect(parseGoogleModelList(null)).toEqual([]);
    expect(parseGoogleModelList('nope')).toEqual([]);
    expect(parseGoogleModelList({})).toEqual([]);
    expect(parseGoogleModelList({ models: 'not-an-array' })).toEqual([]);
  });

  it('leaves an id that is already bare alone', () => {
    expect(
      parseGoogleModelList({
        models: [{ name: 'gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] }],
      }),
    ).toEqual(['gemini-2.5-pro']);
  });
});

describe('model.set — which engines expose a per-turn model pick', () => {
  /**
   * `model.set` IS APP-WIDE PER SCOPE, NOT PER SESSION — the key it writes is
   * `model.selected:<scope>` in the settings table and carries no session id
   * (see the block above MODEL_SCOPES). Adding Google keeps that meaning: it adds
   * a scope, it does not change what a scope is.
   */
  afterEach(async () => {
    await runNabyAction({ action: 'model.set', providerId: 'google', model: '' });
  });

  it('accepts the Google scope and reports the pick back on the GET', async () => {
    const set = await runNabyAction({
      action: 'model.set',
      providerId: 'google',
      model: 'gemini-2.5-flash',
    });
    expect(set.ok).toBe(true);

    const state = await readNabyState(null);
    expect(state.selectedModels.google).toBe('gemini-2.5-flash');
  });

  it('clears the pick with an empty string (back to the profile default)', async () => {
    await runNabyAction({ action: 'model.set', providerId: 'google', model: 'gemini-2.5-flash' });
    await runNabyAction({ action: 'model.set', providerId: 'google', model: '' });

    const state = await readNabyState(null);
    expect(state.selectedModels.google).toBeUndefined();
  });

  it('still refuses a scope that has no per-turn model choice', async () => {
    // Azure addresses one deployment; there is nothing to pick between.
    const res = await runNabyAction({
      action: 'model.set',
      providerId: 'azure-openai',
      model: 'whatever',
    });
    expect(res.ok).toBe(false);
  });
});
