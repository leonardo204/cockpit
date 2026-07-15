/**
 * /api/deepseek/credentials
 *
 * Read/write the DeepSeek API key, stored in its own credential file rather
 * than settings.json. GET never returns the raw key — only { hasKey, maskedKey }
 * — so the plaintext key stays server-side. PUT { apiKey } persists it (empty
 * string clears it).
 */
import { Effect } from 'effect';
import { DEEPSEEK_CREDENTIALS_FILE } from '@cockpit/shared-utils';
import { handler, ok, parseJsonRaw } from '@cockpit/effect-runtime/server';
import { FSError } from '@cockpit/effect-core';
import {
  readDeepseekApiKey,
  writeDeepseekApiKey,
  maskDeepseekKey,
} from '../../engines/deepseekCredentials';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CredentialsInfo {
  hasKey: boolean;
  maskedKey: string;
}

const toInfo = (key: string): CredentialsInfo => ({
  hasKey: !!key,
  maskedKey: maskDeepseekKey(key),
});

export const GET = handler(() =>
  Effect.gen(function* () {
    const key = yield* Effect.tryPromise({
      try: () => readDeepseekApiKey(),
      catch: (cause) =>
        new FSError({ path: DEEPSEEK_CREDENTIALS_FILE, op: 'read', cause }),
    });
    return ok(toInfo(key));
  })
);

export const PUT = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as { apiKey?: unknown };
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    yield* Effect.tryPromise({
      try: () => writeDeepseekApiKey(apiKey),
      catch: (cause) =>
        new FSError({ path: DEEPSEEK_CREDENTIALS_FILE, op: 'write', cause }),
    });
    return ok(toInfo(apiKey));
  })
);
