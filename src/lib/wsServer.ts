/**
 * WebSocket Server — dispatch only.
 *
 * The surviving WS handlers live in src/lib/effect/; this file only owns WS
 * upgrade, route dispatch, and the broadcast helper.
 *
 * F1-03 chat-first trim: /ws/terminal, /ws/bash, /ws/browser, /ws/terminal-follow
 * and /ws/jupyter belonged to @cockpit/feature-console; the old /ws/watch backed
 * the Explorer file tree and the git-branch indicators. All were deleted with
 * their features, leaving the chat channels plus one that came back:
 *
 *   /ws/global-state   — cross-project session list push (sidebar / recents)
 *   /ws/session-stream — live tail of an in-flight chat run
 *   /ws/fs-watch       — per-project filesystem changes for the file browser
 *
 * /ws/fs-watch is a NEW, narrower channel, not the deleted /ws/watch restored:
 * it carries only "these directories changed" for one project — no git status,
 * no whole-tree payload — and it is named apart so nothing can mistake the two
 * protocols for each other.
 *
 * Handler implementations: src/lib/effect/{globalStateHandler,sessionStreamHandler,fileWatchHandler}.ts
 */
import { IncomingMessage } from 'http';
import { Duplex } from 'stream';
import { WebSocketServer, WebSocket } from 'ws';
import { parse } from 'url';
import { runGlobalStateHandler } from './effect/globalStateHandler';
import { runSessionStreamHandler } from './effect/sessionStreamHandler';
import { runFileWatchHandler } from './effect/fileWatchHandler';
// globalStateClients + broadcastToGlobalState live in a side-effect-free module so API
// routes can broadcast without importing this server.
import { globalStateClients, broadcastToGlobalState } from './globalStateBroadcast';

// Re-exported for existing callers that import it from here.
export { broadcastToGlobalState };

// ─────────────────────────────────────────────────────────
// WSS + client set are pinned to globalThis so a second module realm (Next.js
// custom-server topology, dev-mode HMR, dist/wsServer.mjs vs the bundled copy
// inside .next/server) cannot create a parallel WebSocketServer or a parallel
// client Set. Two WSS instances would each register their own 'connection'
// handler on the same upgrade, causing every WS message to be dispatched
// twice; two client Sets would mean broadcastToGlobalState reaches only half
// the connected UIs.
// ─────────────────────────────────────────────────────────

const g_ws = globalThis as unknown as {
  __cockpitWss?: WebSocketServer;
};

const WS_ROUTES: readonly string[] = ['/ws/global-state', '/ws/session-stream', '/ws/fs-watch'];

const wss: WebSocketServer = g_ws.__cockpitWss ?? (() => {
  const server = new WebSocketServer({ noServer: true });
  g_ws.__cockpitWss = server;

  // Listener registered exactly once — re-registering on a second module load
  // would dispatch each connection twice (same WSS instance, two listeners).
  server.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const { pathname, query } = parse(req.url || '', true);

    if (pathname === '/ws/global-state') {
      // Keep globalStateClients populated so broadcastToGlobalState can reach this socket
      globalStateClients.add(ws);
      ws.on('close', () => globalStateClients.delete(ws));
      runGlobalStateHandler(ws);
    } else if (pathname === '/ws/session-stream') {
      runSessionStreamHandler(ws, query.sessionId as string);
    } else if (pathname === '/ws/fs-watch') {
      // `cwd` is client input and is validated by the handler, not here — see
      // resolveWatchRoot: absolute, an existing directory, and a project the
      // app actually has open.
      runFileWatchHandler(ws, (query.cwd as string) ?? '');
    }
  });

  return server;
})();

/**
 * Handle HTTP upgrade requests, only accept /ws/ paths
 * Returns true if handled, false if not a ws path
 */
export function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
  const { pathname } = parse(req.url || '', true);

  if (pathname && WS_ROUTES.includes(pathname)) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
    return true;
  }

  return false;
}
