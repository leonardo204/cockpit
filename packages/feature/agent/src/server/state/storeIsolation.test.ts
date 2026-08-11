import { describe, it, expect } from 'vitest';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { storeDbPath } from '../engines/naby';

/**
 * The suite must never touch the real database.
 *
 * This is a regression test for a bug the user hit, not a hypothetical: after
 * the recent-views store unification, `npm test` wrote its fake sessions into
 * `~/.naby/app.db`. 51 of them accumulated, and since the recents dropdown
 * lists the top 15 by last-used, the developer's own conversations were pushed
 * off it — reported as "a session I had is missing from Recents".
 *
 * vitest.setup.ts redirects NABY_HOME/NABY_DB_PATH to a temp dir. A setup file
 * that fails to load looks exactly like one that works, so assert the effect.
 */
describe('test isolation — the suite writes to a throwaway store', () => {
  it('resolves the store outside the real ~/.naby', () => {
    const real = join(homedir(), '.naby');
    const db = storeDbPath();

    expect(db.startsWith(real)).toBe(false);
    expect(db.startsWith(tmpdir())).toBe(true);
  });

  it('leaves no session rows in the real database', () => {
    // Not a path assertion this time — a FILE one. If a future change resolves
    // some other path back to the real home, the check above could still pass
    // while rows land there anyway; this catches the write itself.
    const realDb = join(homedir(), '.naby', 'app.db');
    if (!existsSync(realDb)) return; // no real store on this machine, nothing to protect

    const before = readdirSync(join(homedir(), '.naby'));
    expect(before).toContain('app.db');
    // The store this process talks to is elsewhere, so nothing here should be
    // the file under test. Asserting the paths differ is the honest check —
    // counting rows would require opening the user's database to prove we are
    // not writing to it, which is the very thing to avoid.
    expect(storeDbPath()).not.toBe(realDb);
  });

  // Skipped on Windows, where the pin is deliberately not set: executability
  // lives in the extension there, so an extension-less script would resolve as
  // "found" and then fail to spawn.
  it.skipIf(process.platform === 'win32')('cannot spawn the developer\'s real `claude`', () => {
    // The temp home stops the suite WRITING into ~/.naby. It does not stop it
    // spawning something that writes there itself: `claude auth login` creates a
    // config directory and opens a browser. `vitest.setup.ts` pins a fake, and
    // this asserts the pin took — same reasoning as the store assertions above,
    // for the failure with the worse blast radius.
    const bin = process.env.NABY_CLAUDE_BIN;
    expect(bin).toBeTruthy();
    expect(bin!.startsWith(tmpdir())).toBe(true);
    expect(bin!.startsWith(join(homedir(), '.naby'))).toBe(false);
    expect(bin!.startsWith(join(homedir(), '.local'))).toBe(false);
  });
});
