// A thrown provider / Claude SDK error is classified into a code the chat can
// turn into actionable copy (src/engines/error-codes.ts).
import { describe, expect, it } from 'vitest';
import {
  claudeSdkFailureCode,
  isSyntheticClaudeSignInFailure,
  providerErrorCode,
} from '../../../../../../../dist/naby-runtime.mjs';

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

// specs/claude-relogin-guide.md R1 — the wording the CLI used when a refresh
// failed (reported 2026-11-03) matched none of the original phrases.
const REPORTED =
  'Claude Code returned an error result: Failed to authenticate: OAuth session expired and could not be refreshed';

describe('claudeSdkFailureCode — every sign-in wording (R1)', () => {
  it('the reported refresh failure is a sign-in failure', () => {
    expect(claudeSdkFailureCode(REPORTED)).toBe('authentication_failed');
  });

  it.each([
    'Failed to authenticate',
    'OAuth session expired',
    'oauth token could not be refreshed',
    'The token could not be refreshed',
    'could not be refreshed: OAuth',
    'OAuth token has expired',
    'oauth token expired',
    'Token expired',
    'FAILED TO AUTHENTICATE',
  ])('%s → authentication_failed', (text) => {
    expect(claudeSdkFailureCode(text)).toBe('authentication_failed');
  });

  it('unrelated text stays ENGINE_THREW — "could not be refreshed" alone is not a sign-in', () => {
    expect(claudeSdkFailureCode('The file list could not be refreshed')).toBe('ENGINE_THREW');
    expect(claudeSdkFailureCode('max tokens exceeded')).toBe('ENGINE_THREW');
    expect(claudeSdkFailureCode('socket hang up')).toBe('ENGINE_THREW');
  });
});

describe('isSyntheticClaudeSignInFailure — the CLI error dressed as a reply (R2)', () => {
  // Mock SDK assistant-message fields; no model is ever called.
  it('a <synthetic> message with the sign-in text is the error, not an answer', () => {
    expect(isSyntheticClaudeSignInFailure('<synthetic>', 'Failed to authenticate: OAuth session expired and could not be refreshed')).toBe(true);
  });

  it('a real model saying the same words is still an answer', () => {
    expect(isSyntheticClaudeSignInFailure('claude-opus-5', 'Failed to authenticate: OAuth session expired')).toBe(false);
    expect(isSyntheticClaudeSignInFailure(undefined, 'OAuth session expired')).toBe(false);
  });

  it('a <synthetic> message about something else is left alone', () => {
    expect(isSyntheticClaudeSignInFailure('<synthetic>', 'No response requested.')).toBe(false);
    expect(isSyntheticClaudeSignInFailure('<synthetic>', '')).toBe(false);
  });
});
