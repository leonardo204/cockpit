/**
 * /api/ollama/config
 *
 * Read/write the Ollama connection config (baseUrl + apiKey), stored in its own
 * file rather than settings.json. GET returns the EFFECTIVE config for display —
 * resolved values (config file > env > default) with the key masked, plus a
 * source hint per field. PUT { baseUrl?, apiKey? } merges into the stored file;
 * a field set to '' clears it (falls back to env/default); an omitted field is
 * untouched. The raw key never leaves the server.
 */
import { Effect } from 'effect';
import {
  OLLAMA_CONFIG_FILE,
  getOllamaEffectiveConfig,
  writeOllamaStoredConfig,
} from '@cockpit/shared-utils';
import { handler, ok, parseJsonRaw } from '@cockpit/effect-runtime/server';
import { FSError } from '@cockpit/effect-core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(() =>
  Effect.gen(function* () {
    const cfg = yield* Effect.tryPromise({
      try: () => getOllamaEffectiveConfig(),
      catch: (cause) =>
        new FSError({ path: OLLAMA_CONFIG_FILE, op: 'read', cause }),
    });
    return ok(cfg);
  })
);

export const PUT = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as {
      baseUrl?: unknown;
      apiKey?: unknown;
    };
    const patch: { baseUrl?: string; apiKey?: string } = {};
    if (typeof body.baseUrl === 'string') patch.baseUrl = body.baseUrl;
    if (typeof body.apiKey === 'string') patch.apiKey = body.apiKey;

    yield* Effect.tryPromise({
      try: () => writeOllamaStoredConfig(patch),
      catch: (cause) =>
        new FSError({ path: OLLAMA_CONFIG_FILE, op: 'write', cause }),
    });
    const cfg = yield* Effect.tryPromise({
      try: () => getOllamaEffectiveConfig(),
      catch: (cause) =>
        new FSError({ path: OLLAMA_CONFIG_FILE, op: 'read', cause }),
    });
    return ok(cfg);
  })
);
