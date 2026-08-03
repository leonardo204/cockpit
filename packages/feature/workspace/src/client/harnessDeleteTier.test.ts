import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deleteTierOf } from './NabyHarnessReview';

/**
 * The harness panel's DELETE, from the user's side.
 *
 * Two things are worth pinning here and neither needs a render:
 *
 *  1. `deleteTierOf` — which of the two deletes is about to happen, i.e. which
 *     sentence the confirmation shows. Getting this wrong is not cosmetic: one
 *     wording promises a file stays and the other promises it goes, and the user
 *     presses OK on the strength of that sentence.
 *  2. The panel's own rules about tombstones (hidden unless asked for, restore
 *     rather than enable/disable). Source assertions, for the reason
 *     `settingsLayout.test.ts` gives — this suite has no jsdom, and what is being
 *     checked is which branches exist, not what they paint.
 */

const SRC = readFileSync(join(__dirname, 'NabyHarnessReview.tsx'), 'utf8');

const HOME_BASES = ['/home/me/.naby'];

describe('deleteTierOf — which delete is this', () => {
  it('a skill under the naby home deletes the DIRECTORY, and names it', () => {
    expect(deleteTierOf('/home/me/.naby/skills/review/SKILL.md', HOME_BASES)).toEqual({
      tier: 'source',
      path: '/home/me/.naby/skills/review',
    });
  });

  it('a pack skill names the <skill> directory, not the pack', () => {
    expect(deleteTierOf('/home/me/.naby/skills/office/docx/SKILL.md', HOME_BASES)).toEqual({
      tier: 'source',
      path: '/home/me/.naby/skills/office/docx',
    });
  });

  it('a command under the naby home names the file', () => {
    expect(deleteTierOf('/home/me/.naby/commands/ship.md', HOME_BASES)).toEqual({
      tier: 'source',
      path: '/home/me/.naby/commands/ship.md',
    });
  });

  it('a `.claude` file is the VENDOR tier — it stays on disk', () => {
    expect(deleteTierOf('/home/me/.claude/skills/review/SKILL.md', HOME_BASES)).toEqual({
      tier: 'vendor',
      path: '/home/me/.claude/skills/review/SKILL.md',
    });
  });

  it('a sibling directory that merely starts with the base name is NOT ours', () => {
    expect(deleteTierOf('/home/me/.naby-backup/skills/x.md', HOME_BASES).tier).toBe('vendor');
  });

  it('no origin at all (a command typed here) touches no file', () => {
    expect(deleteTierOf(undefined, HOME_BASES)).toEqual({ tier: 'row' });
  });

  it('with no bases known (an older server) nothing is claimed as ours', () => {
    // The safe direction: promise that the file stays, then let the server
    // decide. The opposite default would promise a deletion that may not happen.
    expect(deleteTierOf('/home/me/.naby/skills/review/SKILL.md', undefined).tier).toBe('vendor');
    expect(deleteTierOf('/home/me/.naby/skills/review/SKILL.md', []).tier).toBe('vendor');
  });

  it('a project harness home works the same way', () => {
    expect(deleteTierOf('/work/app/.naby/agents/critic.md', ['/work/app/.naby'])).toEqual({
      tier: 'source',
      path: '/work/app/.naby/agents/critic.md',
    });
  });

  it('windows-style paths are matched with their own separator', () => {
    expect(deleteTierOf('C:\\Users\\me\\.naby\\skills\\review\\SKILL.md', ['C:\\Users\\me\\.naby'])).toEqual(
      { tier: 'source', path: 'C:\\Users\\me\\.naby\\skills\\review' },
    );
  });
});

describe('the panel treats tombstones as opt-in', () => {
  it('fetches them (so the filter chip needs no second round trip)', () => {
    expect(SRC).toContain("includeRemoved: '1'");
  });

  it('has a "deleted" status chip', () => {
    expect(SRC).toContain("{ value: 'removed', labelKey: 'harnessReview.statusRemoved' }");
  });

  it('hides them from every other chip, INCLUDING "all"', () => {
    // The bug being fixed is a deleted item reappearing in the list. A filter
    // that let 'all' mean "all rows in the table" would reintroduce it in the
    // default view, which is the only view most users ever change away from.
    expect(SRC).toContain("if (statusFilter === 'removed') return i.status === 'removed';");
    expect(SRC).toContain("if (i.status === 'removed') return false;");
  });

  it('offers RESTORE (not enable/disable/delete) on a tombstone', () => {
    expect(SRC).toContain("const removed = item.status === 'removed'");
    expect(SRC).toContain('onRestore(item.id)');
    // Restoring lands DISABLED: a row back from the dead has not been reviewed.
    expect(SRC).toContain("{ action: 'setEnabled', id, enabled: false }, 'harnessReview.restored'");
  });

  it('says the vendor file is still there when it is', () => {
    expect(SRC).toContain('harnessReview.removedVendorHint');
  });
});

describe('the delete confirmation states what will happen', () => {
  it('confirms before deleting anything, with the danger styling', () => {
    expect(SRC).toContain('await confirm(message');
    expect(SRC).toContain('danger: true');
  });

  it('has a distinct sentence per tier', () => {
    expect(SRC).toContain("t('harnessReview.confirmDeleteSource', { path: tier.path })");
    expect(SRC).toContain("t('harnessReview.confirmDeleteVendor', { path: tier.path })");
    expect(SRC).toContain("t('harnessReview.confirmDeleteRow')");
  });

  it('reports what the SERVER did, not what the dialog predicted', () => {
    // The server re-decides the tier and can fall back to a tombstone when the
    // unlink is refused; a toast written from the client's guess would then lie.
    expect(SRC).toContain("done?.tier === 'source'");
    expect(SRC).toContain("t('harnessReview.deletedFile'");
    expect(SRC).toContain("t('harnessReview.deletedTombstone')");
  });
});
