import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyTitleUpdate } from './titleLock';

describe('applyTitleUpdate — a rename sticks, an empty one lets go', () => {
  it('lets the derived title through while unlocked', () => {
    const out = applyTitleUpdate({ title: 'Old' }, { title: 'Derived' });
    expect(out.title).toBe('Derived');
    expect(out.titleLocked).toBeUndefined();
  });

  it('locks on an explicit rename', () => {
    const out = applyTitleUpdate({ title: 'Old' }, { title: 'My name', lockTitle: true });
    expect(out).toMatchObject({ title: 'My name', titleLocked: true });
  });

  it('IGNORES the derived title once locked — the whole point', () => {
    const locked = { title: 'My name', titleLocked: true };
    // This is what arrives after every turn.
    expect(applyTitleUpdate(locked, { title: 'What is the weather?' }).title).toBe('My name');
  });

  it('still applies a further explicit rename', () => {
    const locked = { title: 'My name', titleLocked: true };
    expect(applyTitleUpdate(locked, { title: 'Better name', lockTitle: true }).title).toBe(
      'Better name',
    );
  });

  it('releases the lock so the automatic title resumes', () => {
    const locked = { title: 'My name', titleLocked: true };
    const released = applyTitleUpdate(locked, { titleLocked: false });
    expect(released.titleLocked).toBe(false);
    expect(applyTitleUpdate(released, { title: 'Derived again' }).title).toBe('Derived again');
  });

  it('leaves other fields alone', () => {
    const out = applyTitleUpdate({ title: 'A', titleLocked: true, isLoading: true } as never, {
      title: 'B',
    });
    expect(out).toMatchObject({ title: 'A', isLoading: true });
  });
});

describe('the caller must pass the PREVIOUS tab', () => {
  it('useTabState does not pre-merge the updates', () => {
    // This shipped: `applyTitleUpdate({ ...tab, ...updates }, updates)`. The
    // function restores `tab.title` when locked, so on a pre-merged object it
    // restored the value that had just been written — the lock became a no-op
    // and a renamed tab reverted on the next turn. Nothing above catches it:
    // the unit is correct, only the call was wrong.
    const src = readFileSync(join(__dirname, 'useTabState.ts'), 'utf8');
    const call = /applyTitleUpdate\(([^,]+),/.exec(src);
    expect(call, 'useTabState no longer calls applyTitleUpdate').not.toBeNull();
    expect(call![1].trim(), 'the previous tab must go in unmerged').toBe('tab');
  });
});
