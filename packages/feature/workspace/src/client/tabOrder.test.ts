import { describe, it, expect } from 'vitest';
import { orderTabs, planDrop, pinRankOf } from './tabOrder';

const tab = (id: string, sessionId?: string) => ({ id, sessionId });

describe('orderTabs — pinned tabs park at the left, in pin order', () => {
  it('puts pinned tabs first and leaves the rest in their own order', () => {
    const tabs = [tab('t1', 's1'), tab('t2', 's2'), tab('t3', 's3'), tab('t4', 's4')];
    // s3 pinned first, then s1 — so s3 sits left of s1 inside the pinned group.
    const ordered = orderTabs(tabs, ['s3', 's1']);
    expect(ordered.map((t) => t.id)).toEqual(['t3', 't1', 't2', 't4']);
  });

  it('returns a tab to its original slot when it is unpinned', () => {
    // The tab array is never rewritten by pinning, so there is nothing to
    // remember: dropping the pin restores the position by itself.
    const tabs = [tab('t1', 's1'), tab('t2', 's2'), tab('t3', 's3')];
    expect(orderTabs(tabs, ['s2']).map((t) => t.id)).toEqual(['t2', 't1', 't3']);
    expect(orderTabs(tabs, []).map((t) => t.id)).toEqual(['t1', 't2', 't3']);
  });

  it('a tab with no session is never pinned', () => {
    // A blank tab has no session until its first turn creates one, so there is
    // nothing to pin. It must not accidentally match a pinned id of ''.
    const ordered = orderTabs([tab('blank'), tab('t1', 's1')], ['s1']);
    expect(ordered.map((t) => t.id)).toEqual(['t1', 'blank']);
    expect(pinRankOf(['s1'], undefined)).toBe(-1);
  });

  it('is stable when nothing is pinned', () => {
    const tabs = [tab('a', 's1'), tab('b', 's2')];
    expect(orderTabs(tabs, []).map((t) => t.id)).toEqual(['a', 'b']);
  });
});

describe('planDrop — a drag reorders, and never pins', () => {
  const tabs = [tab('t1', 's1'), tab('t2', 's2'), tab('t3', 's3'), tab('t4', 's4')];
  const pinned = ['s3', 's4'];
  const display = orderTabs(tabs, pinned); // t3, t4 (pinned) then t1, t2

  it('reorders within the unpinned group', () => {
    expect(planDrop(display, pinned, 3, 2)).toEqual({
      kind: 'reorder-tabs',
      fromId: 't2',
      toId: 't1',
    });
  });

  it('reorders within the pinned group by rewriting the pinned set', () => {
    // The pinned set IS the stored order — the server stamps pin order from the
    // array it receives — so a pinned reorder has to be persisted there.
    expect(planDrop(display, pinned, 1, 0)).toEqual({
      kind: 'reorder-pins',
      pinnedIds: ['s4', 's3'],
    });
  });

  it('REFUSES a cross-group drop — a move must never cost the pin', () => {
    // Tried the other way round once: dropping across the boundary pinned or
    // unpinned. With a single pinned tab that made every drag unpin it, so
    // moving the tab always undid a deliberate choice.
    expect(planDrop(display, pinned, 2, 0).kind).toBe('none'); // unpinned -> pinned
    expect(planDrop(display, pinned, 0, 2).kind).toBe('none'); // pinned -> unpinned
  });

  it('never drops a session out of the pinned set when reordering it', () => {
    const plan = planDrop(display, pinned, 1, 0);
    expect(plan.kind).toBe('reorder-pins');
    if (plan.kind !== 'reorder-pins') return;
    expect([...plan.pinnedIds].sort()).toEqual([...pinned].sort());
  });

  it('is a no-op on a drop onto itself or from nowhere', () => {
    expect(planDrop(display, pinned, 1, 1).kind).toBe('none');
    expect(planDrop(display, pinned, null, 1).kind).toBe('none');
    expect(planDrop(display, pinned, 99, 1).kind).toBe('none');
  });
});
