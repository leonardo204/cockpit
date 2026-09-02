// packages/feature/agent/src/server/lib/bootReconcileBoot.ts
//
// The boot-side wrapper for `reconcileOnBoot`. Its own module for the same
// reason `telegramChatBoot` is: `server.mjs` imports a bundled entry per
// service, and giving this one its own keeps the store lookup out of a file
// that has no other reason to know about `app.db`.

import { getStore } from '../engines/naby';
import { reconcileOnBoot } from './bootReconcile';

/** Settle what an unclean shutdown left behind. Never throws — a boot that
 *  cannot tidy is still a boot. */
export function runBootReconcile(): void {
  try {
    const { lostJobs, clearedSessions } = reconcileOnBoot(getStore());
    if (lostJobs || clearedSessions) {
      console.log(
        `[boot] settled ${lostJobs} job(s) left running and cleared ${clearedSessions} stale session status row(s)`,
      );
    }
  } catch (e) {
    console.warn(`[boot] reconcile skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
}
