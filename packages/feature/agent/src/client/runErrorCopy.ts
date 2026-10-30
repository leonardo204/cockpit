/**
 * WHAT A FAILED RUN SAYS TO THE USER — localized and actionable, keyed on the
 * stable `code` the server attaches.
 *
 * Run errors used to reach the chat as the engine's raw English text ("assistant
 * error: rate_limit", "iteration cap reached: …", "Run stopped by user.") in a
 * Korean UI, or — for a POST that never started a run — as a bare "Request
 * failed" that threw the server's reason away. The server now sends a `code`
 * beside the text: the runtime engines' own (`ENGINE_THREW`,
 * `MAX_STEPS_EXCEEDED`, the Claude Agent SDK's `authentication_failed`, …; see
 * src/engines/error-codes.ts), the preflight's (`NO_ENGINE_AVAILABLE`, …) and
 * the shell's (`session_busy`, `run_stopped`, `run_no_result`).
 *
 * The rules:
 *   • a known code → the copy for it, which names what to do;
 *   • where the raw text carries detail the copy cannot (a provider's own
 *     reason for rejecting a key), it is kept underneath — the failure notice
 *     shows the first line as its headline and the rest under "Details";
 *   • an unknown code, or none → the raw text, unchanged. Never a bare
 *     "Request failed".
 *
 * Pure apart from the default `t`, so the mapping is tested without a DOM
 * (runErrorCopy.test.ts).
 */
import i18n from '@cockpit/shared-i18n';

type Translate = (key: string, opts?: Record<string, unknown>) => string;

const defaultT: Translate = (key, opts) => i18n.t(key, opts ?? {}) as string;

/** Copy followed by the raw text as detail, unless the raw text adds nothing. */
function withDetail(copy: string, raw: string): string {
  const detail = raw.trim();
  return detail && detail !== copy ? `${copy}\n\n${detail}` : copy;
}

/**
 * The user-facing text for a run error. Returns `raw` itself when the code is
 * absent or unknown.
 */
export function runErrorCopy(code: string | undefined, raw: string, t: Translate = defaultT): string {
  const k = (key: string, defaultValue: string, extra: Record<string, unknown> = {}) =>
    t(`chat.runError.${key}`, { defaultValue, ...extra });
  switch (code) {
    case 'session_busy':
      return k('sessionBusy', 'naby is still answering in this tab. Send again when it finishes, or press Stop first.');
    case 'NO_ENGINE_AVAILABLE':
      return k(
        'noEngine',
        'naby has no AI to answer with yet. Open Settings → AI provider, pick a provider, paste its API key and press Save. To use your Claude subscription instead, install Claude Code and sign in to it on this computer.',
      );
    case 'DEV_ENGINE_UNAVAILABLE':
      return k(
        'devEngineUnavailable',
        'The Claude subscription option could not be loaded on this computer. Pick a provider you have an API key for in Settings → AI provider, or reinstall naby to restore it.',
      );
    case 'CREDENTIAL_UNAVAILABLE':
      return k('credentialUnavailable', 'The AI provider key could not be used. Check the key in Settings → AI provider and press Save.');
    case 'authentication_failed':
      return k('claudeSignIn', 'Your Claude sign-in has expired. Click the Claude chip above the chat, choose Log in, then send again.');
    case 'rate_limit':
      return k(
        'claudeRateLimit',
        'Your Claude plan’s usage limit is reached. It resets later; to keep going now, choose another provider in Settings → AI provider.',
      );
    case 'billing_error':
      return k(
        'billing',
        'The AI provider refused the request because of a billing problem on the account. Check the account’s plan or payment, then send again.',
      );
    case 'PROVIDER_AUTH_FAILED':
      return withDetail(
        k('apiKeyRejected', 'The AI provider rejected the API key. Paste a valid key in Settings → AI provider and press Save.'),
        raw,
      );
    case 'PROVIDER_RATE_LIMITED':
      return withDetail(
        k(
          'providerRateLimit',
          'The AI provider is limiting requests right now. Wait a little and send again, or choose another provider in Settings → AI provider.',
        ),
        raw,
      );
    case 'ENGINE_THREW':
      return k('engineThrew', 'Error while the AI was answering: {{raw}}', { raw: raw.trim() });
    case 'MAX_STEPS_EXCEEDED': {
      // The engine's message carries the cap it actually applied
      // ("… for 16 consecutive steps …"); 16 is ai-sdk-engine's default.
      const count = Number(raw.match(/(\d+) consecutive/)?.[1] ?? 16);
      return k('maxSteps', 'Stopped after using tools {{count}} times in a row. To carry on, send “continue”.', { count });
    }
    case 'GATE_BYPASSED':
    case 'NO_EXECUTOR':
      return k('internal', 'naby did not run this tool because of an internal error. Please send again.');
    case 'run_stopped':
      return k('runStopped', 'You stopped this turn.');
    case 'run_no_result':
      return k('runNoResult', 'The answer stopped before it finished. Please send again.');
    default:
      return raw;
  }
}

/**
 * The same event with its user-facing text localized: `error` on an error
 * event, and on a result event the status line the server appended as the
 * LAST paragraph of `result` (naby.ts puts any partial answer before it). An
 * event with no `code` is returned as is — the same object, so callers that
 * compare identity see no change.
 */
export function localizeRunEvent<E extends { type?: unknown; code?: unknown; error?: unknown; result?: unknown }>(
  ev: E,
  t: Translate = defaultT,
): E {
  const code = typeof ev.code === 'string' ? ev.code : undefined;
  if (!code) return ev;
  if (ev.type === 'error' && typeof ev.error === 'string') {
    const error = runErrorCopy(code, ev.error, t);
    return error === ev.error ? ev : { ...ev, error };
  }
  if (ev.type === 'result' && typeof ev.result === 'string') {
    const parts = ev.result.split('\n\n');
    const last = parts[parts.length - 1] ?? '';
    const copy = runErrorCopy(code, last, t);
    if (copy === last) return ev;
    parts[parts.length - 1] = copy;
    return { ...ev, result: parts.join('\n\n') };
  }
  return ev;
}
