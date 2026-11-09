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

// ─────────────────────────────────────────────────────────────────────────────
// memory-auto-apply §3 — what the chip draws
// ─────────────────────────────────────────────────────────────────────────────

import { memoryChipView, memoryWriteOf } from './pendingMemory';

describe('memoryWriteOf', () => {
  it('reads the three kinds of write, and an older proposal as held', () => {
    expect(memoryWriteOf(REMEMBER_TOOL, { id: 'm', key: 'k', value: 'v', review: 'pending', status: 'proposed' })).toEqual({
      id: 'm',
      key: 'k',
      value: 'v',
      review: 'pending',
    });
    expect(memoryWriteOf(REMEMBER_TOOL, { id: 'm', key: 'k', review: 'held', holdReason: 'external', status: 'proposed' })).toEqual({
      id: 'm',
      key: 'k',
      review: 'held',
      holdReason: 'external',
    });
    expect(memoryWriteOf(REMEMBER_TOOL, { id: 'm', key: 'k', review: 'known', status: 'confirmed' })?.review).toBe('known');
    expect(memoryWriteOf(REMEMBER_TOOL, proposed())?.review).toBe('held');
  });

  it('reads the Claude engine’s namespaced tool name too', () => {
    expect(memoryWriteOf('mcp__nabytools__naby_remember', proposed())?.id).toBe('mem-1');
  });

  it('offers no confirm button for a write waiting for its review (R11)', () => {
    expect(pendingMemoryOf(REMEMBER_TOOL, proposed({ review: 'pending' }))).toBeNull();
  });
});

describe('memoryChipView (R10/R11)', () => {
  const pending = { id: 'm', key: 'k', value: 'v', review: 'pending' as const };
  it('says "remembering" until the server answers', () => {
    expect(memoryChipView(pending, undefined)).toEqual({ kind: 'pending', canCancel: true });
  });
  it('then what became of it', () => {
    expect(memoryChipView(pending, { state: 'applied', value: 'v' })).toMatchObject({ kind: 'applied', canCancel: true });
    expect(memoryChipView(pending, { state: 'known', value: 'old' })).toEqual({ kind: 'known', value: 'old' });
    expect(memoryChipView(pending, { state: 'changed', value: 'B', oldValue: 'A' })).toEqual({
      kind: 'changed',
      value: 'B',
      oldValue: 'A',
      canCancel: true,
    });
    expect(memoryChipView(pending, { state: 'held', reason: 'unsupported' })).toEqual({
      kind: 'held',
      reason: 'unsupported',
      canConfirm: true,
    });
    expect(memoryChipView(pending, { state: 'question' })).toEqual({ kind: 'question' });
  });
  it('an undone change reads as undone, and a deleted memory draws nothing', () => {
    expect(memoryChipView(pending, { state: 'applied', value: 'v', undone: true })).toEqual({ kind: 'undone' });
    expect(memoryChipView(pending, { state: 'gone' })).toEqual({ kind: 'none' });
  });
  it('a held write shows the confirm offer with its reason before any answer', () => {
    expect(memoryChipView({ id: 'm', key: 'k', review: 'held', holdReason: 'external' }, undefined)).toEqual({
      kind: 'held',
      reason: 'external',
      canConfirm: true,
    });
  });
});
