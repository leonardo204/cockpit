/**
 * Point every test at a THROWAWAY database, before a single test module loads.
 *
 * WHY THIS FILE EXISTS. The store used to be reachable only through paths the
 * tests never took: `updateGlobalState` wrote `~/.cockpit/state.json`, and the
 * orchestrator suite skipped it by omitting `cwd` — its comment still says
 * "cwd is omitted so globalState never touches disk". Unifying the two recent
 * views onto one store made that assumption false: status writes and the
 * transcript recorder now go to the Naby store, which resolves to
 * `~/.naby/app.db` when NABY_DB_PATH is unset.
 *
 * So `npm test` started writing into the developer's REAL database. It was not
 * theoretical — 51 sessions with provider `fake` landed there, one triple per
 * test run, and because the recent-sessions dropdown shows the top 15 by
 * last-used, those rows pushed the user's own conversations off the list. The
 * bug report was "a session I had is missing from Recents".
 *
 * A per-process temp home fixes it at the root rather than per suite: anything
 * that resolves NABY_HOME or NABY_DB_PATH lands here, including code paths
 * added later that nobody thought to isolate. `storeIsolation.test.ts` asserts
 * it actually took effect, because a setup file that silently fails to load
 * looks exactly like one that works.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// One directory per worker process. Vitest may run several, and two workers
// sharing one SQLite file would produce lock contention that reads as a flaky
// test rather than as the setup problem it is.
const home = mkdtempSync(join(tmpdir(), 'naby-vitest-'));

// Set unconditionally. An inherited NABY_DB_PATH from the developer's shell is
// exactly the thing this is protecting against, so `??=` would be a hole.
process.env.NABY_HOME = home;
process.env.NABY_DB_PATH = join(home, 'app.db');
