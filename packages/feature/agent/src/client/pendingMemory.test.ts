import { describe, it, expect } from 'vitest';
import { REMEMBER_TOOL, pendingMemoryOf } from './pendingMemory';

/**
 * THE CONFIRM IS OFFERED WHERE THE MEMORY WAS PROPOSED.
 *
 * A memory captured from conversation is `proposed` and `artifact`-tier until a
 * PERSON agrees to it — `naby_remember` cannot tell an instruction the user gave
 * from a fact naby inferred, and promoting on the model's say-so would let it
 * choose which tier judges its own writes. So the agreement has to be a real
 * user action, and this decides where one is worth offering.
 */

const proposed = (over: Record<string, unknown> = {}) => ({
  id: 'mem-1',
  key: 'answer-tone',
  scope: 'user',
  status: 'proposed',
  ...over,
});

describe('when there is something to confirm', () => {
  it('offers the row a capture just proposed', () => {
    expect(pendingMemoryOf(REMEMBER_TOOL, proposed())).toEqual({
      id: 'mem-1',
      key: 'answer-tone',
    });
  });

  it('falls back to the id when the slug is missing, rather than an empty label', () => {
    expect(pendingMemoryOf(REMEMBER_TOOL, proposed({ key: '' }))?.key).toBe('mem-1');
  });
});

describe('when there is nothing to confirm', () => {
  it('offers nothing for a memory that is ALREADY confirmed', () => {
    // The write gate confirms on the spot when a claim is corroborated across
    // sessions. A button asking for agreement already given does nothing.
    expect(pendingMemoryOf(REMEMBER_TOOL, proposed({ status: 'confirmed' }))).toBeNull();
  });

  it('offers nothing for any other tool', () => {
    expect(pendingMemoryOf('run_command', proposed())).toBeNull();
    expect(pendingMemoryOf('naby_checkin', proposed())).toBeNull();
  });

  it('offers nothing while the turn is still live', () => {
    // The stream carries only the prose the model saw; the structured half
    // arrives when the transcript reconciles. Absent is ordinary, not an error.
    expect(pendingMemoryOf(REMEMBER_TOOL, undefined)).toBeNull();
  });

  it('offers nothing for a failed capture', () => {
    // The error branch returns no `data` at all.
    expect(pendingMemoryOf(REMEMBER_TOOL, null)).toBeNull();
  });
});

describe('it cannot be made to throw inside a render', () => {
  it('survives every shape that is not the one it wants', () => {
    for (const bad of ['a string', 42, true, [], {}, { id: 5 }, { status: 'proposed' }]) {
      expect(() => pendingMemoryOf(REMEMBER_TOOL, bad)).not.toThrow();
      expect(pendingMemoryOf(REMEMBER_TOOL, bad)).toBeNull();
    }
  });
});
