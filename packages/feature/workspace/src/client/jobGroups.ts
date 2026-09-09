import type { JobRow } from '@cockpit/feature-agent';

/**
 * jobGroups — which project a background job belongs to.
 *
 * A job records the cwd of the session that started it, and the job list is
 * global (one registry for the whole app). Drawn flat, a job from another
 * project's session sits in the same list as this project's, under this
 * project's window, and reads as if it were happening here. Grouping is what
 * keeps the list honest about whose work each line is.
 *
 * Both paths come from the same machine, so the only normalisation needed is
 * trimming trailing separators — no separator conversion.
 */

export interface JobGroup {
  /** The group's directory, with trailing separators trimmed. */
  cwd: string;
  /** Last path segment, or the whole path when there is no segment (root). */
  label: string;
  /** True for the group that is the currently open project. */
  isCurrent: boolean;
  jobs: JobRow[];
}

/** Trailing `/` or `\` carry no meaning here, but they do break `===`. Never
 *  reduce a path to the empty string — `/` normalises to `/`. */
function normalise(path: string): string {
  return path.replace(/[\\/]+$/, '') || path;
}

/** The name a reader recognises. Falls back to the full path for a root dir. */
function basename(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

/** A job belongs to the project when it ran in it or anywhere beneath it. */
function isUnder(jobCwd: string, projectCwd: string): boolean {
  if (jobCwd === projectCwd) return true;
  return jobCwd.startsWith(`${projectCwd}/`) || jobCwd.startsWith(`${projectCwd}\\`);
}

/**
 * Group jobs by the project they ran in.
 *
 * The current project comes first — and only when it has jobs at all, because
 * an empty "this project" section would be an affirmative claim that nothing is
 * running here, which the store cannot make: waits the SDK owns itself
 * (`Monitor`, a backgrounded Bash) never reach this registry.
 *
 * Every job under the current project is collected into ONE group keyed by the
 * project directory, so a job started in a sub-directory does not split off
 * under its own heading. The remaining groups keep the order they first appear
 * in `rows`, which arrives running-first and then most recent.
 */
export function groupJobsByProject(rows: JobRow[], currentCwd?: string): JobGroup[] {
  const project = currentCwd ? normalise(currentCwd) : undefined;
  const current: JobRow[] = [];
  const others = new Map<string, JobRow[]>();

  for (const job of rows) {
    const jobCwd = normalise(job.cwd ?? '');
    if (project !== undefined && isUnder(jobCwd, project)) {
      current.push(job);
      continue;
    }
    const bucket = others.get(jobCwd);
    if (bucket) bucket.push(job);
    else others.set(jobCwd, [job]);
  }

  const groups: JobGroup[] = [];
  if (project !== undefined && current.length > 0) {
    groups.push({ cwd: project, label: basename(project), isCurrent: true, jobs: current });
  }
  for (const [cwd, jobs] of others) {
    groups.push({ cwd, label: basename(cwd), isCurrent: false, jobs });
  }
  return groups;
}

/** Does this job belong to the open project? Shared with the badge, so the
 *  count in the tooltip and the sections below it cannot disagree. */
export function isJobInProject(job: JobRow, currentCwd?: string): boolean {
  if (!currentCwd) return false;
  return isUnder(normalise(job.cwd ?? ''), normalise(currentCwd));
}
