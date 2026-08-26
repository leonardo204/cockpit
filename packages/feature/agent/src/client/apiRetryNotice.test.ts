import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import en from '../../../../shared/i18n/locales/en.json';
import ko from '../../../../shared/i18n/locales/ko.json';
import { apiRetryNotice } from './apiRetryNotice';

/**
 * A BUSY SERVER IS NOT A SPENT PLAN, AND THE NOTICE HAS TO SAY WHICH.
 *
 * The retry is the SDK's — it retries 408, 409, 429 and every 5xx on its own
 * backoff. naby only reports it, and it was reporting `Retrying API call
 * (attempt 1/3, delay 2.0s)`: English, in a Korean app, in the SDK author's
 * vocabulary.
 *
 * The 429 is the one that misleads. "Rate limited" reads as "you have used up
 * your plan", and a reader who believes that stops working for the day — while
 * the plan chip beside them says 16%.
 */

const chat = (d: unknown) => (d as { chat: Record<string, string> }).chat;
const info = (over: Partial<Parameters<typeof apiRetryNotice>[0]> = {}) =>
  apiRetryNotice({ attempt: 1, maxRetries: 3, delayMs: 2000, ...over });

describe('which sentence a status earns', () => {
  it('says a 429 is the SERVER being busy', () => {
    expect(info({ errorStatus: 429 }).key).toBe('chat.apiRetryBusy');
  });

  it('says so IN BOTH LANGUAGES, and rules out the usage limit by name', () => {
    // The whole point: without this the reader concludes the wrong thing and
    // acts on it.
    expect(chat(en).apiRetryBusy).toContain('busy');
    expect(chat(en).apiRetryBusy).toContain('not your usage limit');
    expect(chat(ko).apiRetryBusy).toContain('붐벼');
    expect(chat(ko).apiRetryBusy).toContain('사용량 한도');
  });

  it('gives everything else the plainer sentence', () => {
    // A 500 or a dropped connection is "that did not go through, trying again" —
    // true, and not alarming in the specific way a quota message is.
    for (const status of [500, 502, 408, 409, undefined]) {
      expect(info({ errorStatus: status }).key, String(status)).toBe('chat.apiRetryTransient');
    }
    expect(chat(en).apiRetryTransient).toBeTruthy();
    expect(chat(ko).apiRetryTransient).toBeTruthy();
    expect(chat(ko).apiRetryTransient).not.toBe(chat(en).apiRetryTransient);
  });
});

describe('the attempt counter', () => {
  it('reads the delay in seconds, not milliseconds', () => {
    expect(info({ delayMs: 2000 }).values.seconds).toBe('2.0');
    expect(info({ delayMs: 1500 }).values.seconds).toBe('1.5');
  });

  it('is shown when the SDK named a ceiling', () => {
    expect(info({ attempt: 2, maxRetries: 5 }).showAttempts).toBe(true);
  });

  it('is HIDDEN when it would read as a bug', () => {
    // `maxRetries` is 0 when the SDK did not say, and "attempt 1/0" reads as
    // broken. "Attempt 3" with no ceiling is no better: it cannot tell the
    // reader whether this is nearly over or has barely started.
    expect(info({ attempt: 1, maxRetries: 0 }).showAttempts).toBe(false);
    expect(info({ attempt: 0, maxRetries: 3 }).showAttempts).toBe(false);
  });

  it('is translated in both languages', () => {
    for (const dict of [en, ko]) {
      expect(chat(dict).apiRetryAttempt).toContain('{{attempt}}');
      expect(chat(dict).apiRetryAttempt).toContain('{{maxRetries}}');
      expect(chat(dict).apiRetryAttempt).toContain('{{seconds}}');
    }
  });
});

describe('the wiring', () => {
  const LIST = readFileSync(join(__dirname, 'MessageList.tsx'), 'utf8');

  it('no longer hardcodes English into the markup', () => {
    // The old line is still QUOTED, in the comment that explains why it went —
    // so the check is that it is not RENDERED, not that the string is absent.
    expect(LIST).not.toContain('<div>\n                          Retrying API call');
    expect(LIST).not.toMatch(/\{apiRetryInfo\.maxRetries > 0 \? `\//);
    expect(LIST).toContain('{t(retryNotice.key)}');
  });

  it('derives the wording once rather than deciding it in JSX', () => {
    expect(LIST).toContain('apiRetryNotice(apiRetryInfo)');
    expect(LIST).toContain('[apiRetryInfo]');
  });

  it('does not print a counter the rule said to hide', () => {
    expect(LIST).toContain('{retryNotice.showAttempts && (');
  });
});
