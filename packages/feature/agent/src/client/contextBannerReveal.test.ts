import { describe, it, expect } from 'vitest';
import {
  contextBannerVisible,
  initialContextBannerState,
  reduceContextBanner,
} from './contextBannerReveal';
import { contextGauge } from './contextGauge';

/**
 * The threshold banner's life (specs/session-context-management.md §2.1).
 *
 * The banner is an OFFER, and the spec's one durability claim about it is small
 * and exact: closing it stops it coming back IN THAT SESSION. These cases pin that
 * claim — including the two ways to overstate it (a boolean that follows the user
 * into the next conversation, or a dismissal that survives a new session).
 */
describe('context banner reveal rules', () => {
  const S1 = 'session-1';
  const S2 = 'session-2';

  it('shows only when the gauge is at the threshold', () => {
    const state = initialContextBannerState;
    expect(contextBannerVisible(state, { atThreshold: false, sessionId: S1 })).toBe(false);
    expect(contextBannerVisible(state, { atThreshold: true, sessionId: S1 })).toBe(true);
  });

  it('shows nothing on a tab that has no session yet', () => {
    // A blank tab has no conversation to be long and nothing to continue.
    expect(
      contextBannerVisible(initialContextBannerState, { atThreshold: true, sessionId: undefined }),
    ).toBe(false);
  });

  it('stays hidden for the rest of the session once dismissed', () => {
    const dismissed = reduceContextBanner(initialContextBannerState, {
      kind: 'dismiss',
      sessionId: S1,
    });
    expect(contextBannerVisible(dismissed, { atThreshold: true, sessionId: S1 })).toBe(false);
    // Still true after the gauge dips and climbs again — the user answered.
    expect(contextBannerVisible(dismissed, { atThreshold: false, sessionId: S1 })).toBe(false);
    expect(contextBannerVisible(dismissed, { atThreshold: true, sessionId: S1 })).toBe(false);
  });

  it('does not carry one conversation dismissal onto another', () => {
    const dismissed = reduceContextBanner(initialContextBannerState, {
      kind: 'dismiss',
      sessionId: S1,
    });
    expect(contextBannerVisible(dismissed, { atThreshold: true, sessionId: S2 })).toBe(true);
  });

  it('taking the offer also retires the banner for the session it came from', () => {
    const continued = reduceContextBanner(initialContextBannerState, {
      kind: 'continued',
      sessionId: S1,
    });
    expect(contextBannerVisible(continued, { atThreshold: true, sessionId: S1 })).toBe(false);
    // …and the NEW session it opened starts honest.
    expect(contextBannerVisible(continued, { atThreshold: true, sessionId: S2 })).toBe(true);
  });

  it('is driven by the same measurement the status bar shows', () => {
    // The bar and the banner must never disagree about "nearly full", which is why
    // both read `contextGauge`. 84% offers nothing; 85% offers the new tab.
    const under = contextGauge(168_000, 200_000);
    const over = contextGauge(170_000, 200_000);
    expect(
      contextBannerVisible(initialContextBannerState, {
        atThreshold: under.show && under.atThreshold,
        sessionId: S1,
      }),
    ).toBe(false);
    expect(
      contextBannerVisible(initialContextBannerState, {
        atThreshold: over.show && over.atThreshold,
        sessionId: S1,
      }),
    ).toBe(true);
  });
});
