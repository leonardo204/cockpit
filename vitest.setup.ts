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
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// One directory per worker process. Vitest may run several, and two workers
// sharing one SQLite file would produce lock contention that reads as a flaky
// test rather than as the setup problem it is.
const home = mkdtempSync(join(tmpdir(), 'naby-vitest-'));

// Set unconditionally. An inherited NABY_DB_PATH from the developer's shell is
// exactly the thing this is protecting against, so `??=` would be a hole.
process.env.NABY_HOME = home;
process.env.NABY_DB_PATH = join(home, 'app.db');

// And say so out loud rather than trusting the two lines above. `mkdtempSync`
// under `tmpdir()` cannot land in the real home — but this file's whole reason
// for existing is that "cannot" was wrong once, and a throw here names the
// problem at setup time instead of after the suite has written somewhere.
const realHome = join(homedir(), '.naby');
if (home === realHome || home.startsWith(realHome + '/')) {
  throw new Error(`vitest setup resolved a naby home inside the real one: ${home}`);
}

/**
 * PIN A FAKE `claude`, so no test can spawn the developer's real CLI.
 *
 * The temp home above stops a test WRITING into `~/.naby`. It does not stop one
 * from spawning something that writes there on its own: `claude-account.add`
 * runs `claude auth status` and then `claude auth login`, and a real
 * `claude auth login` opens a BROWSER and fills a config directory in. The only
 * thing between this suite and that today is that each account test remembers to
 * set `NABY_CLAUDE_BIN` itself (nabyClaudeAccounts.test.ts). A test added later
 * that forgets would not read as a failing test — it would read as a browser
 * window opening for no reason, which is the least debuggable symptom there is.
 *
 * So the fake is the DEFAULT for every worker, and a test that wants a different
 * one still overrides the variable. It partitions the way the real CLI does — it
 * answers out of `CLAUDE_CONFIG_DIR` and nowhere else — so the behaviour a test
 * gets by default is the honest one rather than a stub that says yes to
 * everything.
 *
 * POSIX only: on Windows executability lives in the file extension, and an
 * extension-less shell script would resolve as "found" and then fail to spawn —
 * worse than leaving the variable alone, because the real CLI is not what runs
 * the suite there anyway.
 */
if (process.platform !== 'win32') {
  const fakeClaude = join(home, 'claude');
  writeFileSync(
    fakeClaude,
    '#!/bin/sh\n' +
      'DIR="${CLAUDE_CONFIG_DIR:-UNSET}"\n' +
      'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then\n' +
      '  if [ -f "$DIR/signed-in" ]; then\n' +
      '    printf \'{"loggedIn":true,"email":"in-folder@example.com"}\\n\'\n' +
      '  else\n' +
      '    printf \'{"loggedIn":false}\\n\'\n' +
      '  fi\n' +
      '  exit 0\n' +
      'fi\n' +
      'exit 0\n',
  );
  chmodSync(fakeClaude, 0o755);
  process.env.NABY_CLAUDE_BIN = fakeClaude;
  // Named so a test's own cleanup can put the default back instead of deleting
  // the variable and dropping the whole suite onto the real CLI.
  process.env.NABY_TEST_FAKE_CLAUDE_BIN = fakeClaude;
}
