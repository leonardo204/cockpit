// The standalone server must raise Node's Happy Eyeballs attempt timeout.
//
// WHAT BROKE. Node enables `autoSelectFamily` by default: it races the A and
// AAAA addresses of a host and moves on to the next address as soon as the
// current attempt has not connected within `autoSelectFamilyAttemptTimeout` —
// DEFAULT 250ms. On the reporting network the IPv4 handshake to
// api.telegram.org measured ~250-280ms and IPv6 was EHOSTUNREACH, so the
// address list was exhausted while the v4 attempt was still pending and about
// to succeed. Every outbound `fetch` to a >250ms-RTT endpoint therefore failed
// INTERMITTENTLY with `TypeError: fetch failed` (cause ETIMEDOUT) — which reads
// like a broken app, not like a network tuning default. `curl` on the same box
// worked, because it uses a head start rather than a deadline.
//
// WHY A SOURCE ASSERTION. The property under test is "this call happens before
// the process makes any outbound connection", which is a statement about MODULE
// LOAD ORDER in an entry file. Importing `server.mjs` to check it would boot a
// real Next server and bind a port; spawning it would make a unit test own a
// process lifecycle. Neither buys signal over reading the entry, because the
// only way to break this is to move or delete the lines — exactly what the read
// detects. (The runtime half is covered where a runtime can be had: spike-04
// reads `net.getDefaultAutoSelectFamilyAttemptTimeout()` from inside the real
// Electron main process after boot.)
//
// The naby-side twin of this file is `src/spikes/spike-net-timeout.ts`, which
// makes the same assertion about `electron/boot.ts`. Both entries must carry
// the call: they are two separate server PROCESSES, and a setting in one is not
// a setting in the other.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// This file lives at <shellRoot>/src/happyEyeballsTimeout.test.ts
const shellRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_ENTRY = resolve(shellRoot, 'server.mjs');

/** The floor. 250ms is the broken default; anything below a second would leave
 *  the same class of border-RTT network failing. */
const MIN_ATTEMPT_TIMEOUT_MS = 5000;

const CALL = /setDefaultAutoSelectFamilyAttemptTimeout\(\s*([A-Za-z0-9_]+)\s*\)/;

describe('server.mjs — Happy Eyeballs attempt timeout is raised at boot', () => {
  const src = readFileSync(SERVER_ENTRY, 'utf8');

  it('calls net.setDefaultAutoSelectFamilyAttemptTimeout', () => {
    expect(src).toMatch(CALL);
    // Imported as a namespace so the guarded `typeof` check below can be made.
    expect(src).toMatch(/import \* as net from 'net'|from 'node:net'/);
  });

  it('passes at least 5000ms', () => {
    const arg = src.match(CALL)?.[1];
    expect(arg).toBeTruthy();
    // The argument is a named constant, so resolve it in the source rather than
    // asserting on a magic number that could drift away from its definition.
    const value = Number(
      src.match(new RegExp(`(?:const|let|var)\\s+${arg}\\s*=\\s*([0-9_]+)`))?.[1]?.replace(/_/g, ''),
    );
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(MIN_ATTEMPT_TIMEOUT_MS);
  });

  it('guards the call, so an older Node cannot make the server unstartable', () => {
    expect(src).toMatch(
      /typeof net\.setDefaultAutoSelectFamilyAttemptTimeout === 'function'/,
    );
  });

  it('runs BEFORE Next is constructed — i.e. before anything can fetch', () => {
    const callAt = src.search(CALL);
    // `next({ dev })` is the earliest point at which framework code — and
    // therefore user code that can call fetch — comes alive in this entry.
    const nextAt = src.indexOf('next({');
    const listenAt = src.indexOf('server.listen(');
    expect(callAt).toBeGreaterThan(-1);
    expect(nextAt).toBeGreaterThan(-1);
    expect(callAt).toBeLessThan(nextAt);
    expect(callAt).toBeLessThan(listenAt);
  });

  it('sits at module scope, not inside a function or a conditional branch', () => {
    // Everything before the call must have balanced braces: an unbalanced count
    // means the call is nested inside some block that may never run. The one
    // brace that IS allowed to be open is the `typeof` guard itself, so the
    // check is made against the line the guard opens.
    const guardAt = src.indexOf("typeof net.setDefaultAutoSelectFamilyAttemptTimeout === 'function'");
    const before = src.slice(0, guardAt);
    const opens = (before.match(/\{/g) ?? []).length;
    const closes = (before.match(/\}/g) ?? []).length;
    expect(opens).toBe(closes);
  });
});
