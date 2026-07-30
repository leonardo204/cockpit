import { describe, it, expect } from 'vitest';
import {
  PERSONA_ESCALATION_KEY,
  PERSONA_MAX_STEPS_KEY,
  parseEscalation,
  parseMaxSteps,
  readPersonaAutonomy,
  writePersonaAutonomy,
} from './personaAutonomy';
import { AUTONOMY_STEP_CAP } from './autonomy';

/**
 * THE PERSONA'S DELEGATION SETTINGS (P3-M9, G1).
 *
 * The persona row is read-only, so "how much do I hand this agent" cannot live on
 * it — it lives in settings, and this is the module that owns those two keys.
 * What is worth asserting is not that a string round-trips but the three
 * properties the feature rests on: a safe default when nothing was chosen, a
 * clamp that runs on the WRITE (so Settings never shows a number the engine will
 * not honour), and per-field writes that do not disturb each other.
 */

/** A settings table, as a map. */
function fakeStore(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getSetting(key: string): string | undefined {
      return map.get(key);
    },
    setSetting(key: string, value: string): void {
      map.set(key, value);
    },
  };
}

function brokenStore() {
  return {
    getSetting(): string | undefined {
      throw new Error('database is locked');
    },
    setSetting(): void {
      throw new Error('database is locked');
    },
  };
}

describe('personaAutonomy — defaults', () => {
  it('an install that has never chosen reads as inline, one turn', () => {
    // The conservative end on purpose: a delegation setting that arrives switched
    // on is not a delegation the user made.
    expect(readPersonaAutonomy(fakeStore())).toEqual({ escalation: 'inline', maxSteps: 1 });
  });

  it('an unreadable settings table reads as the defaults, not as a failure', () => {
    expect(readPersonaAutonomy(brokenStore())).toEqual({ escalation: 'inline', maxSteps: 1 });
  });

  it('a garbage stored value reads as the default rather than throwing a turn', () => {
    expect(parseEscalation('telegramm')).toBe('inline');
    expect(parseEscalation(undefined)).toBe('inline');
    expect(parseMaxSteps('not a number')).toBe(1);
    expect(parseMaxSteps('')).toBe(1);
    expect(parseMaxSteps(undefined)).toBe(1);
  });
});

describe('personaAutonomy — the read', () => {
  it('returns what the user chose, off the documented keys', () => {
    const store = fakeStore({
      [PERSONA_ESCALATION_KEY]: 'both',
      [PERSONA_MAX_STEPS_KEY]: '6',
    });
    expect(readPersonaAutonomy(store)).toEqual({ escalation: 'both', maxSteps: 6 });
  });

  it('clamps on the way out too — a row written by an older build cannot exceed the cap', () => {
    const store = fakeStore({ [PERSONA_MAX_STEPS_KEY]: '9999' });
    expect(readPersonaAutonomy(store).maxSteps).toBe(AUTONOMY_STEP_CAP);
  });

  it('collapses a sub-2 value to 1 — the same "autonomy off" rule the row has', () => {
    expect(readPersonaAutonomy(fakeStore({ [PERSONA_MAX_STEPS_KEY]: '0' })).maxSteps).toBe(1);
    expect(readPersonaAutonomy(fakeStore({ [PERSONA_MAX_STEPS_KEY]: '-4' })).maxSteps).toBe(1);
    expect(readPersonaAutonomy(fakeStore({ [PERSONA_MAX_STEPS_KEY]: '2.9' })).maxSteps).toBe(2);
  });
});

describe('personaAutonomy — the write', () => {
  it('clamps BEFORE storing, so the stored value is the effective value', () => {
    // The point of clamping on the write: otherwise Settings would show 50 while
    // the engine ran 20, and the number on screen would be one the product does
    // not honour.
    const store = fakeStore();
    expect(writePersonaAutonomy(store, { maxSteps: 50 }).maxSteps).toBe(AUTONOMY_STEP_CAP);
    expect(store.map.get(PERSONA_MAX_STEPS_KEY)).toBe(String(AUTONOMY_STEP_CAP));
  });

  it('stores a non-finite request as autonomy off rather than as itself', () => {
    const store = fakeStore();
    expect(writePersonaAutonomy(store, { maxSteps: Number.NaN }).maxSteps).toBe(1);
    expect(store.map.get(PERSONA_MAX_STEPS_KEY)).toBe('1');
  });

  it('writes only the fields it was given — one control cannot reset the other', () => {
    const store = fakeStore();
    writePersonaAutonomy(store, { escalation: 'telegram' });
    expect(store.map.has(PERSONA_MAX_STEPS_KEY)).toBe(false);
    writePersonaAutonomy(store, { maxSteps: 4 });
    expect(readPersonaAutonomy(store)).toEqual({ escalation: 'telegram', maxSteps: 4 });
  });

  it('normalises an unrecognised escalation rather than storing it', () => {
    const store = fakeStore();
    expect(writePersonaAutonomy(store, { escalation: 'carrier-pigeon' }).escalation).toBe('inline');
    expect(store.map.get(PERSONA_ESCALATION_KEY)).toBe('inline');
  });

  it('answers with the settings as they now stand, not with what it was sent', () => {
    const store = fakeStore({ [PERSONA_ESCALATION_KEY]: 'both' });
    expect(writePersonaAutonomy(store, { maxSteps: 999 })).toEqual({
      escalation: 'both',
      maxSteps: AUTONOMY_STEP_CAP,
    });
  });
});
