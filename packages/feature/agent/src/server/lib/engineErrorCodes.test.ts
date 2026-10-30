// A thrown provider / Claude SDK error is classified into a code the chat can
// turn into actionable copy (src/engines/error-codes.ts).
import { describe, expect, it } from 'vitest';
import { claudeSdkFailureCode, providerErrorCode } from '../../../../../../../dist/naby-runtime.mjs';

describe('providerErrorCode', () => {
  it('reads statusCode off the error (or its cause)', () => {
    expect(providerErrorCode(Object.assign(new Error('Unauthorized'), { statusCode: 401 }))).toBe('PROVIDER_AUTH_FAILED');
    expect(providerErrorCode(Object.assign(new Error('Forbidden'), { statusCode: 403 }))).toBe('PROVIDER_AUTH_FAILED');
    expect(providerErrorCode(new Error('wrapped', { cause: { statusCode: 429 } }))).toBe('PROVIDER_RATE_LIMITED');
  });
  it('falls back to the text of a wrapped error', () => {
    expect(providerErrorCode(new Error('Failed after 3 attempts. Last error: status code 429'))).toBe('PROVIDER_RATE_LIMITED');
    expect(providerErrorCode(new Error('401 Unauthorized'))).toBe('PROVIDER_AUTH_FAILED');
  });
  it('anything else stays ENGINE_THREW — a bare number is not a status', () => {
    expect(providerErrorCode(new Error('socket hang up'))).toBe('ENGINE_THREW');
    expect(providerErrorCode(new Error('context of 4290 tokens exceeded'))).toBe('ENGINE_THREW');
  });
});

describe('claudeSdkFailureCode', () => {
  it('sign-in and usage-limit failures get the SDK codes', () => {
    expect(claudeSdkFailureCode('Invalid API key · Please run /login')).toBe('authentication_failed');
    expect(claudeSdkFailureCode('API Error: 429 Too Many Requests')).toBe('rate_limit');
    expect(claudeSdkFailureCode('Claude Code process exited with code 1')).toBe('ENGINE_THREW');
  });
});
