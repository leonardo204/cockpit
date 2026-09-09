import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import en from '../../../../shared/i18n/locales/en.json';
import ko from '../../../../shared/i18n/locales/ko.json';

/**
 * The grouping only helps if the indicator is TOLD which project is open, and
 * only stays honest if it never draws an affirmative "nothing here" line.
 *
 * Neither is visible to `jobGroups.test.ts` (a pure helper cannot know who
 * calls it) nor to jsdom (no layout, no tabs) — so both are source assertions,
 * the convention this directory's neighbours follow.
 */

const CLIENT = __dirname;
const read = (name: string) => readFileSync(join(CLIENT, name), 'utf8');

describe('background jobs — grouped by project', () => {
  it('the top bar hands the indicator the open project', () => {
    const src = read('TabManagerTopBar.tsx');
    expect(src).toContain('<RunningJobsIndicator cwd={initialCwd} />');
  });

  it('the popover draws a section per project rather than one flat list', () => {
    const src = read('RunningJobsIndicator.tsx');
    expect(src).toContain('groupJobsByProject(rows, cwd)');
    expect(src).toMatch(/groups\.map\(\(group\)/);
    expect(src, 'the full path belongs on the heading — basenames collide').toContain(
      'title={group.cwd}'
    );
    expect(src).toContain("t('jobs.thisProject'");
  });

  it('the badge stays a total, and says so when part of it is elsewhere', () => {
    const src = read('RunningJobsIndicator.tsx');
    // The number itself is untouched: it is the app's only "work is happening
    // somewhere" signal.
    expect(src).toContain('{runningCount}</span>');
    expect(src).toMatch(/cwd && runningHere < runningCount/);
    expect(src).toContain("t('jobs.runningElsewhere'");
  });

  it('never claims this project has nothing running', () => {
    // Waits the SDK owns itself (`Monitor`, a backgrounded Bash) never reach
    // this registry, so an affirmative empty line would be false in exactly the
    // moment someone is waiting on one. Only the whole-list empty state stays.
    const src = read('RunningJobsIndicator.tsx');
    expect(src).toContain('rows.length === 0');
    expect(src).not.toMatch(/noneHere|nothingHere|noJobsInProject/);
    for (const dict of [en, ko]) {
      expect(Object.keys((dict as { jobs: Record<string, string> }).jobs)).not.toContain('noneHere');
    }
  });

  it('both dictionaries carry the new keys', () => {
    for (const dict of [en, ko]) {
      const jobs = (dict as { jobs: Record<string, string> }).jobs;
      expect(jobs.thisProject).toBeTruthy();
      expect(jobs.runningElsewhere).toContain('{{count}}');
      expect(jobs.runningElsewhere).toContain('{{here}}');
    }
  });
});
