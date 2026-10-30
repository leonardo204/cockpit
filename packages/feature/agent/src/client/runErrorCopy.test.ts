// A run error's `code` becomes localized, actionable copy; an unknown code or
// none keeps the server's raw text (never a bare "Request failed").
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { localizeRunEvent, runErrorCopy } from './runErrorCopy';

const locale = (lang: 'en' | 'ko') =>
  JSON.parse(readFileSync(join(__dirname, `../../../../shared/i18n/locales/${lang}.json`), 'utf8')) as Record<
    string,
    unknown
  >;

/** A `t` over one locale file: resolves the dotted key and interpolates, and
 *  FAILS on a missing key rather than falling back to the default value. */
const tFor = (lang: 'en' | 'ko') => {
  const d = locale(lang);
  return (key: string, opts: Record<string, unknown> = {}) => {
    const v = key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], d);
    if (typeof v !== 'string') throw new Error(`missing ${lang} key ${key}`);
    return v.replace(/\{\{(\w+)\}\}/g, (_, n: string) => String(opts[n] ?? ''));
  };
};
const ko = tFor('ko');
const en = tFor('en');

const CODES = [
  'session_busy',
  'NO_ENGINE_AVAILABLE',
  'DEV_ENGINE_UNAVAILABLE',
  'CREDENTIAL_UNAVAILABLE',
  'authentication_failed',
  'rate_limit',
  'billing_error',
  'PROVIDER_AUTH_FAILED',
  'PROVIDER_RATE_LIMITED',
  'ENGINE_THREW',
  'MAX_STEPS_EXCEEDED',
  'GATE_BYPASSED',
  'NO_EXECUTOR',
  'run_stopped',
  'run_no_result',
];

describe('runErrorCopy', () => {
  it.each(CODES)('%s has copy in both locales', (code) => {
    expect(runErrorCopy(code, 'raw text', ko)).not.toBe('raw text');
    expect(runErrorCopy(code, 'raw text', en)).not.toBe('raw text');
  });

  it('no setting keys or env vars reach the user', () => {
    for (const code of CODES) {
      for (const t of [ko, en]) expect(runErrorCopy(code, 'x', t)).not.toMatch(/NABY_|gate\.|Phase [12]/);
    }
  });

  it('names the real control', () => {
    expect(runErrorCopy('NO_ENGINE_AVAILABLE', 'x', ko)).toContain('설정 → AI 프로바이더');
    expect(runErrorCopy('authentication_failed', 'assistant error: authentication_failed', ko)).toContain('Claude 칩');
    expect(runErrorCopy('session_busy', 'session is already running', ko)).toContain("'중단'");
    expect(runErrorCopy('session_busy', 'session is already running', en)).toContain('Stop');
  });

  it('the tool-loop cap quotes the cap the engine applied', () => {
    const raw = 'iteration cap reached: the model requested tools for 16 consecutive steps without finishing';
    expect(runErrorCopy('MAX_STEPS_EXCEEDED', raw, ko)).toBe("도구를 16번 연달아 쓰고 멈췄습니다. 이어서 하려면 '계속'이라고 보내 주세요.");
  });

  it('keeps the provider detail where it adds something', () => {
    expect(runErrorCopy('ENGINE_THREW', 'socket hang up', ko)).toBe('AI 응답 중 오류: socket hang up');
    const key = runErrorCopy('PROVIDER_AUTH_FAILED', 'Incorrect API key provided', ko);
    expect(key.split('\n')[0]).toContain('API 키를 거부');
    expect(key).toContain('Incorrect API key provided');
  });

  it('unknown or missing code → the raw text, unchanged', () => {
    expect(runErrorCopy('something_new', 'The server said why', ko)).toBe('The server said why');
    expect(runErrorCopy(undefined, 'The server said why', ko)).toBe('The server said why');
  });
});

describe('localizeRunEvent', () => {
  it('rewrites a coded error event', () => {
    const ev = { type: 'error', error: 'Run stopped by user.', code: 'run_stopped' };
    expect(localizeRunEvent(ev, ko).error).toBe('중단했습니다.');
  });

  it("rewrites only the result's trailing status line, keeping a partial answer", () => {
    const ev = { type: 'result', result: 'Half an answer.\n\nRun ended without a result.', code: 'run_no_result' };
    expect(localizeRunEvent(ev, ko).result).toBe('Half an answer.\n\n응답이 끝나지 않고 멈췄습니다. 다시 보내 주세요.');
  });

  it('leaves an uncoded event as the same object', () => {
    const ev = { type: 'error', error: 'boom' };
    expect(localizeRunEvent(ev, ko)).toBe(ev);
  });
});
