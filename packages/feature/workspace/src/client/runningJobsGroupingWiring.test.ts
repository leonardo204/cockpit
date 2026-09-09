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

  it('shows only the open project’s jobs, and hides other projects entirely', () => {
    // A project open → the rows are filtered to it BEFORE grouping, so another
    // project's work is not merely under a divider but absent. The home view
    // (no cwd) keeps everything.
    const src = read('RunningJobsIndicator.tsx');
    expect(src).toContain('cwd ? kept.filter((job) => isJobInProject(job, cwd)) : kept');
    // Headers only make sense in the home view — one open project needs none.
    expect(src).toContain('const showHeaders = !cwd');
    expect(src).toMatch(/showHeaders && \(/);
  });

  it('drops a succeeded job at once and lets a failed one linger, then clear', () => {
    const src = read('RunningJobsIndicator.tsx');
    // Succeeded → gone immediately; anything else → kept until its TTL passes.
    expect(src).toContain("if (job.status === 'succeeded') return false");
    expect(src).toContain('now - ended < FAILED_JOB_TTL_MS');
    // A single self-cancelling timer clears an expired row while the list is open.
    expect(src).toMatch(/setTimeout\(\(\) => setNow\(Date\.now\(\)\)/);
  });

  it('the badge stays a total, and says so when part of it is elsewhere', () => {
    const src = read('RunningJobsIndicator.tsx');
    // The number itself is untouched: it is the app's only "work is happening
    // somewhere" signal.
    expect(src).toContain('{runningCount}</span>');
    expect(src).toMatch(/cwd && runningHere < runningCount/);
    expect(src).toContain("t('jobs.runningElsewhere'");
  });

  it('when a project is open, the empty line is scoped to THIS project', () => {
    // The list now shows only the open project's jobs (field request 2026-09-09),
    // so its empty state names that scope — "no background jobs in this project"
    // — rather than the whole-list "nothing running". The wording is about
    // background JOBS specifically: an SDK-owned wait (a Monitor) lives in the
    // transcript and the running badge, not in this list, so this line does not
    // claim nothing is happening.
    const src = read('RunningJobsIndicator.tsx');
    expect(src).toContain('rows.length === 0');
    expect(src).toContain("t('jobs.noneHere'");
    for (const dict of [en, ko]) {
      const jobs = (dict as { jobs: Record<string, string> }).jobs;
      expect(jobs.noneHere).toBeTruthy();
      // Still scoped to jobs, never an absolute "nothing is happening".
      expect(jobs.none).toBeTruthy();
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
