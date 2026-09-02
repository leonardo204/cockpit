// packages/feature/agent/src/server/lib/bootReconcile.ts
//
// WHAT AN UNCLEAN SHUTDOWN LEAVES BEHIND, SETTLED ONCE AT BOOT.
//
// Two pieces of state in this app outlive the process that wrote them, and both
// can be left mid-sentence by a crash, a force-quit or an update. Neither is
// self-healing, and both fail in a way the user reads as the app lying:
//
//   1. A JOB RECORD STILL SAYING `running`. Its child was spawned detached, so
//      it may genuinely still be encoding — but this process no longer holds the
//      handle and can never hear it end. Left alone, the record claims to be
//      watched forever.
//
//   2. `session.status.<id>` STILL SAYING `loading`. Written when a turn starts
//      and cleared when it ends; a process that dies in between leaves it set,
//      and every session row, project row and sidebar badge then pulses "running"
//      for a turn that no longer exists. This is the INVERSE of the missing
//      indicator and reads as the same bug: the dots cannot be trusted.
//
// WHY AT BOOT AND NOT ON A TIMER. Both are wrong only across a process
// lifetime — nothing can create a stale row while this process is alive, because
// the thing that would clear it is still running. Boot is therefore the complete
// and only moment, which is also what keeps this within the repo's ban on
// standing sweeps.
//
// IT DOES NOT TOUCH THE PROCESSES. An orphaned child is not killed and not
// adopted: killing destroys work the user asked for, and adopting is not
// possible once the handle is gone. The record is stamped `lost` — "it ran, and
// how it ended was never recorded" — and its log path is left in place so the
// output can still be read.

import { markLostJobs } from '../../../../../../../dist/naby-runtime.mjs';

/** What the reconcile settled, so the caller can log one line instead of
 *  guessing whether anything happened. */
export interface BootReconcileResult {
  lostJobs: number;
  clearedSessions: number;
}

/** The subset of the store this needs. Structural so a test can pass a stub. */
export interface ReconcileStore {
  listSettings?: () => Readonly<Record<string, string>>;
  getSetting: (key: string) => string | undefined;
  setSetting: (key: string, value: string) => void;
}

/** The settings-key prefix `orchestrator` writes a session's run status under. */
const STATUS_PREFIX = 'session.status.';

/**
 * Settle the stale rows.
 *
 * `loading` becomes `normal`, NOT `unread`. `unread` is what a FINISHED turn
 * leaves, and it is what the completion toast and the badge fire on — so
 * promoting a crashed turn to `unread` would announce a result that was never
 * produced. `normal` says the only true thing: nothing is happening here.
 */
export function reconcileOnBoot(store: ReconcileStore): BootReconcileResult {
  let lostJobs = 0;
  try {
    lostJobs = markLostJobs().length;
  } catch {
    // A home this process cannot read is not a reason to fail the boot.
  }

  let clearedSessions = 0;
  try {
    const settings = store.listSettings?.() ?? {};
    for (const [key, value] of Object.entries(settings)) {
      if (!key.startsWith(STATUS_PREFIX)) continue;
      if (value !== 'loading') continue;
      store.setSetting(key, 'normal');
      clearedSessions++;
    }
  } catch {
    // Same rule: observation must not break the thing observed.
  }

  return { lostJobs, clearedSessions };
}
