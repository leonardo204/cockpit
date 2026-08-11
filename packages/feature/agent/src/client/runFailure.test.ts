import { describe, it, expect } from 'vitest';
import {
  runFailureReducer,
  runFailureHeadline,
  runFailureOrigin,
  type RunFailure,
  type RunFailureEvent,
} from './runFailure';

/**
 * The reported bug, as a test: a Gemini turn fails, the error flashes on screen
 * and is gone a second later, and the user reads it as "the answer disappeared".
 * The mechanism is the post-run disk reconcile — so the regression test is a
 * reconcile that must NOT clear the notice.
 */

/** The real thing, quoted from the activity log of a failed free-tier run. */
const QUOTA_ERROR = [
  'Failed after 3 attempts. Last error: AI_APICallError: You exceeded your current quota, please check your plan and billing details.',
  '* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-2.5-pro',
  'Please retry in 53.456557145s.',
].join('\n');

const failed = (over: Partial<Extract<RunFailureEvent, { type: 'run-failed' }>> = {}): RunFailureEvent => ({
  type: 'run-failed',
  message: QUOTA_ERROR,
  engine: 'Gemini',
  model: 'gemini-2.5-pro',
  sessionId: 's-1',
  at: 1_700_000_000_000,
  ...over,
});

/** Fold a sequence, the way the component does over its lifetime. */
const run = (events: readonly RunFailureEvent[], from: RunFailure | null = null): RunFailure | null =>
  events.reduce<RunFailure | null>(runFailureReducer, from);

describe('runFailureReducer — a failed run is remembered', () => {
  it('records the provider message verbatim, with who was asked', () => {
    const state = run([failed()]);
    expect(state).toEqual({
      message: QUOTA_ERROR,
      engine: 'Gemini',
      model: 'gemini-2.5-pro',
      sessionId: 's-1',
      at: 1_700_000_000_000,
    });
    // The actionable part is not swallowed: `limit: 0` is what tells the user
    // this model can never answer on this plan, retrying included.
    expect(state?.message).toContain('limit: 0, model: gemini-2.5-pro');
    expect(state?.message).toContain('Please retry in 53.456557145s.');
  });

  it('trims, but does not otherwise touch the text', () => {
    expect(run([failed({ message: `  ${QUOTA_ERROR}\n\n` })])?.message).toBe(QUOTA_ERROR);
  });

  it('keeps the previous report rather than blanking it for an empty one', () => {
    const first = run([failed()]);
    expect(run([failed({ message: '   \n ' })], first)).toBe(first);
    expect(run([failed({ message: '' })], null)).toBeNull();
  });

  it('a second failure replaces the first', () => {
    const state = run([failed(), failed({ message: 'overloaded_error: the model is overloaded', at: 2 })]);
    expect(state?.message).toBe('overloaded_error: the model is overloaded');
    expect(state?.at).toBe(2);
  });

  it('omits engine/model instead of carrying empty strings', () => {
    const state = run([failed({ engine: undefined, model: undefined })]);
    expect(state).not.toHaveProperty('engine');
    expect(state).not.toHaveProperty('model');
  });
});

describe('THE REGRESSION — a disk reconcile does not erase it', () => {
  it('survives the post-run reconcile that wipes everything not on disk', () => {
    // The exact order the app produces: error event → run ends → reconcile.
    const state = run([failed(), { type: 'history-reconciled' }]);
    expect(state?.message).toBe(QUOTA_ERROR);
  });

  it('survives any number of reconciles, by identity (no re-render churn)', () => {
    const after = run([failed()]);
    const reconciled = run(
      [{ type: 'history-reconciled' }, { type: 'history-reconciled' }, { type: 'history-reconciled' }],
      after,
    );
    expect(reconciled).toBe(after);
  });

  it('survives a re-report of the SAME session id (the reconcile also re-reads it)', () => {
    const after = run([failed()]);
    expect(run([{ type: 'session', sessionId: 's-1' }], after)).toBe(after);
  });
});

describe('what does end it', () => {
  it('the next send clears it — a new question supersedes the failed one', () => {
    expect(run([failed(), { type: 'history-reconciled' }, { type: 'send' }])).toBeNull();
  });

  it('and it stays cleared through the next reconcile', () => {
    expect(run([failed(), { type: 'send' }, { type: 'history-reconciled' }])).toBeNull();
  });

  it('switching to another session clears it', () => {
    expect(run([failed(), { type: 'session', sessionId: 's-2' }])).toBeNull();
    expect(run([failed(), { type: 'session', sessionId: null }])).toBeNull();
  });

  it('but a session FIRST GETTING an id does not — that is the same conversation', () => {
    // The first turn of a new session can fail before any `system/init`, so the
    // record is tagged with a null id and the real one arrives afterwards.
    // Reading that as a switch would clear the notice exactly when a
    // misconfigured provider needs to be reported.
    const state = run([failed({ sessionId: null }), { type: 'session', sessionId: 's-1' }]);
    expect(state?.message).toBe(QUOTA_ERROR);
    expect(state?.sessionId).toBe('s-1');
    // …and it is then anchored: moving on really does clear it.
    expect(run([{ type: 'session', sessionId: 's-2' }], state)).toBeNull();
  });

  it('dismissing clears it', () => {
    expect(run([failed(), { type: 'dismiss' }])).toBeNull();
  });

  it('every clearing event is a no-op on an empty state, by identity', () => {
    for (const ev of [
      { type: 'send' },
      { type: 'dismiss' },
      { type: 'session', sessionId: 's-9' },
      { type: 'history-reconciled' },
    ] as const) {
      expect(runFailureReducer(null, ev)).toBeNull();
    }
  });
});

describe('runFailureHeadline — the one line the collapsed notice shows', () => {
  it('takes the first non-empty line', () => {
    expect(runFailureHeadline(QUOTA_ERROR)).toBe(
      'Failed after 3 attempts. Last error: AI_APICallError: You exceeded your current quota, please check your plan and billing details.',
    );
    // The quota/limit lines are NOT in the headline — they are the detail the
    // notice shows underneath, verbatim.
    expect(runFailureHeadline(QUOTA_ERROR)).not.toContain('limit: 0');
  });

  it('skips leading blank lines and collapses runs of whitespace', () => {
    expect(runFailureHeadline('\n\n   \n  rate   limited \t now  \nmore')).toBe('rate limited now');
  });

  it('truncates at the cap with an ellipsis, and leaves shorter text alone', () => {
    expect(runFailureHeadline('x'.repeat(10), 10)).toBe('x'.repeat(10));
    expect(runFailureHeadline('x'.repeat(11), 10)).toBe(`${'x'.repeat(9)}…`);
    // No dangling space before the ellipsis.
    expect(runFailureHeadline('abcdefgh ijkl', 10)).toBe('abcdefgh…');
  });

  it('is empty for an empty message', () => {
    expect(runFailureHeadline('')).toBe('');
    expect(runFailureHeadline('   \n  ')).toBe('');
  });
});

describe('runFailureOrigin — which provider and model was asked', () => {
  it('joins the two when both are known', () => {
    expect(runFailureOrigin({ engine: 'ChatGPT', model: 'gpt-5.6-sol' })).toBe('ChatGPT · gpt-5.6-sol');
  });

  it('does not repeat the brand the model name already carries', () => {
    // Both the resolved label and the raw slug start with the brand; "Gemini ·
    // Gemini 2.5 Pro" reads like a rendering bug rather than like detail.
    expect(runFailureOrigin({ engine: 'Gemini', model: 'Gemini 2.5 Pro' })).toBe('Gemini 2.5 Pro');
    expect(runFailureOrigin({ engine: 'Gemini', model: 'gemini-2.5-pro' })).toBe('gemini-2.5-pro');
  });

  it('degrades to whichever part is known, and claims nothing when neither is', () => {
    expect(runFailureOrigin({ engine: 'Claude' })).toBe('Claude');
    expect(runFailureOrigin({ model: 'gpt-5.6-sol' })).toBe('gpt-5.6-sol');
    expect(runFailureOrigin({})).toBe('');
    expect(runFailureOrigin({ engine: '  ', model: '' })).toBe('');
  });
});
