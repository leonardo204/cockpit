/**
 * DeepSeek API key storage.
 *
 * The key lives in its own credential file (~/.cockpit/deepseek/credentials.json),
 * deliberately separate from settings.json so it is never bundled into the
 * GET /api/settings payload that ships to the browser. Read/written only here
 * (engine preflight/runner) and via the /api/deepseek/credentials route.
 */
import {
  DEEPSEEK_CREDENTIALS_FILE,
  readJsonFile,
  writeJsonFile,
} from '@cockpit/shared-utils';

interface DeepseekCredentials {
  apiKey?: string;
}

/** Read the raw DeepSeek API key. Returns '' when unset. */
export async function readDeepseekApiKey(): Promise<string> {
  const creds = await readJsonFile<DeepseekCredentials>(DEEPSEEK_CREDENTIALS_FILE, {});
  return creds.apiKey?.trim() ?? '';
}

/** Persist the DeepSeek API key. An empty string clears it. */
export async function writeDeepseekApiKey(apiKey: string): Promise<void> {
  await writeJsonFile<DeepseekCredentials>(DEEPSEEK_CREDENTIALS_FILE, { apiKey });
}

/** Mask all but the last 4 chars, e.g. sk-1234abcd → sk-•••••bcd */
export function maskDeepseekKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return key.replace(/./g, '•');
  return `${key.slice(0, 3)}${'•'.repeat(Math.max(4, key.length - 7))}${key.slice(-4)}`;
}
