import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The parts of the file watcher that only the SOURCE can show.
 *
 * The decisions themselves are pure and tested directly (fsWatchScope.test.ts,
 * fileBrowserOps.test.ts). What is left is wiring, and every item below is a
 * property whose loss is silent: a leaked watcher looks like nothing until the
 * app has been open for a day, a per-event send looks fine until someone runs a
 * build, and a degradation path that closes the socket instead of parking looks
 * fine on macOS and becomes a reconnect loop on a Linux host with an old Node.
 * There is no WS/component harness here that could catch any of them, so they
 * are read off the files — the same approach as fileBrowserMenuClipping.test.ts.
 */

const HANDLER = join(__dirname, 'effect', 'fileWatchHandler.ts');
const WS_SERVER = join(__dirname, 'wsServer.ts');
const SCOPE = join(__dirname, 'fsWatchScope.ts');
const PANEL = join(
  __dirname,
  '..',
  '..',
  'packages',
  'feature',
  'workspace',
  'src',
  'client',
  'FileBrowserPanel.tsx',
);

describe('the channel is registered', () => {
  const src = readFileSync(WS_SERVER, 'utf8');

  it('accepts /ws/fs-watch on upgrade and dispatches it', () => {
    // Both are required and neither implies the other: a path missing from
    // WS_ROUTES never reaches handleUpgrade, and a path missing from the
    // dispatch upgrades into a socket nobody answers.
    expect(src).toContain("'/ws/fs-watch'");
    expect(src).toContain("pathname === '/ws/fs-watch'");
    expect(src).toContain('runFileWatchHandler(ws');
  });

  it('passes the client-supplied cwd through rather than resolving it here', () => {
    expect(src).toContain("query.cwd as string");
  });
});

describe('the watcher cannot outlive its connection', () => {
  const src = readFileSync(HANDLER, 'utf8');

  it('owns the fs.watch subscription with acquireRelease', () => {
    // This is what makes closing the panel, switching projects, or dropping the
    // socket close the watcher. Without it every project ever opened keeps a
    // recursive watcher for the life of the process.
    expect(src).toContain('Effect.acquireRelease(openWatcher(root, events), closeQuietly)');
  });

  it('interrupts the program when the socket closes', () => {
    expect(src).toContain("ws.on(\"close\"");
    expect(src).toContain('fiber.interruptAsFork(fiber.id())');
  });

  it('drives the heartbeat with Schedule, not setInterval', () => {
    // Matched as CALLS, so the prose above them may name what they replaced.
    expect(src).toContain('Schedule.spaced');
    expect(src).not.toContain('setInterval(');
    expect(src).not.toContain('setTimeout(');
  });
});

describe('cwd is treated as client input', () => {
  const src = readFileSync(HANDLER, 'utf8');

  it('requires an absolute path that is an existing directory', () => {
    expect(src).toContain('isAbsolute(raw)');
    expect(src).toContain('statSync(root).isDirectory()');
  });

  it('requires it to be a project the app actually has open', () => {
    // The strongest of the three: an absolute existing directory is still not
    // permission to watch it. `listProjects()` is the same table /api/projects
    // serves, so the watchable set is exactly the set the user opened.
    expect(src).toContain('listProjects()');
    expect(src).toContain('resolve(p.cwd) === root');
  });

  it('refuses by degrading, never by watching something else', () => {
    expect(src).toContain("parkUnavailable(conn, \"invalid-cwd\")");
  });
});

describe('bursts are coalesced, not forwarded', () => {
  const src = readFileSync(HANDLER, 'utf8');

  it('collects a window and reduces it to one entry per directory', () => {
    expect(src).toContain('Stream.groupedWithin(WATCH_BATCH_MAX, Duration.millis(WATCH_COALESCE_MS))');
    expect(src).toContain('coalesceChangedDirs');
  });

  it('sends nothing for a window that was all ignored noise', () => {
    expect(src).toContain('Stream.filter((dirs) => dirs.length > 0)');
  });

  it('keeps the ignore list in ONE place instead of a second copy here', () => {
    // A second list is a list that drifts, and the drift is only visible as a
    // flood months later.
    // A string LITERAL is the shape a second copy takes; the comment above the
    // stream is free to say which directory it means.
    expect(src).not.toMatch(/["']node_modules["']/);
    expect(readFileSync(SCOPE, 'utf8')).toContain('export const WATCH_IGNORED_DIRS');
  });
});

describe('an unwatchable host degrades instead of crashing or spinning', () => {
  const src = readFileSync(HANDLER, 'utf8');

  it('checks the platform AND guards the call', () => {
    // The predicate is a claim; the call is the fact. Linux on Node < 20.13
    // throws ERR_FEATURE_UNAVAILABLE_ON_PLATFORM, and an inotify limit can fail
    // a host the predicate approved.
    expect(src).toContain('supportsRecursiveWatch(process.platform, process.version)');
    expect(src).toContain('Effect.try({');
    expect(src).toContain('watch(root, { recursive: true }');
  });

  it('parks the connection rather than ending it', () => {
    // Ending the program closes the socket, and the client's pooled connection
    // reconnects — so "unsupported" would become an endless reconnect cycle
    // instead of a quiet fallback to manual refresh.
    expect(src).toContain('Effect.zipRight(Effect.never)');
    expect(src).toContain("parkUnavailable(conn, \"unsupported\")");
  });

  it('closes a watcher that starts erroring instead of leaving it armed', () => {
    expect(src).toContain('watcher.on("error"');
    expect(src).toContain('closeQuietly(watcher)');
  });
});

describe('the panel subscribes and refreshes only what changed', () => {
  const src = readFileSync(PANEL, 'utf8');

  it('opens one connection per project, keyed by cwd', () => {
    expect(src).toContain('/ws/fs-watch?cwd=${encodeURIComponent(cwd)}');
    expect(src).toContain('useWebSocket({');
  });

  it('routes the message through the shared parser', () => {
    expect(src).toContain('bumpMany(fsChangeDirs(data))');
  });

  it('reuses the existing per-directory nonce instead of a second refresh path', () => {
    // The whole feature is one line of state: a watcher event ends in the same
    // bump a right-click rename ends in.
    expect(src).toContain('const bump = useCallback((rel: string) => bumpMany([rel])');
    expect(src).toContain('next[rel] = (next[rel] ?? 0) + 1');
  });

  it('applies a whole window in ONE state update', () => {
    // Four directories in one window must be one render, not four.
    expect(src).toContain('const bumpMany = useCallback((rels: readonly string[]) =>');
  });

  it('keeps the manual refresh button', () => {
    // A watcher that misses an event, or a platform that has none, must not
    // leave the user stranded.
    //
    // Asserted as "the button still bumps the root" rather than as its exact
    // handler text: it has since grown a second job (re-reading git status,
    // which the watcher cannot trigger because `.git` is on its ignore list),
    // and pinning the literal made that addition look like this guard failing.
    const button = /t\('fileBrowser\.refreshTree'/.exec(src);
    expect(button, 'the refresh button is gone').not.toBeNull();
    expect(src).toContain("bump('');");
  });
});
