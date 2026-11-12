import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server, type Socket } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  connectMcpServer,
  loadMcpToolset,
  McpConnectTimeoutError,
  MCP_CONNECT_TIMEOUT_MS,
} from '../../../../../../../dist/naby-runtime.mjs';

/**
 * A SERVER THAT ACCEPTS AND THEN SAYS NOTHING must not hold a turn forever
 * (field case 2026-11-12: a stalled Atlassian tools/list kept a chat "thinking"
 * for minutes, before the model was ever asked). Connecting now has a deadline,
 * servers connect in parallel, and what a timed-out connect opened is closed.
 */

type Stalled = { server: Server; url: string; sockets: Set<Socket>; closed: () => number };

async function stalledServer(): Promise<Stalled> {
  const sockets = new Set<Socket>();
  let closedCount = 0;
  const server = createServer(() => {
    /* never answers */
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => {
      closedCount += 1;
      sockets.delete(s);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}/mcp`, sockets, closed: () => closedCount };
}

const open: Stalled[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) {
    for (const sock of s.sockets) sock.destroy();
    await new Promise((r) => s.server.close(r));
  }
});

describe('MCP connect deadline', () => {
  it('fails a server that never answers, instead of waiting forever', async () => {
    const s = await stalledServer();
    open.push(s);
    const started = Date.now();
    await expect(
      connectMcpServer({ name: 'quiet', transport: 'http', url: s.url, timeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(McpConnectTimeoutError);
    expect(Date.now() - started).toBeLessThan(5000);
    // The request it had in flight is cancelled, not left hanging.
    await new Promise((r) => setTimeout(r, 200));
    expect(s.closed()).toBeGreaterThan(0);
  });

  it('connects servers in parallel, so one stall does not add up behind another', async () => {
    const a = await stalledServer();
    const b = await stalledServer();
    open.push(a, b);
    const started = Date.now();
    const result = await loadMcpToolset([
      { name: 'quiet-a', transport: 'http', url: a.url, timeoutMs: 1000 },
      { name: 'quiet-b', transport: 'http', url: b.url, timeoutMs: 1000 },
    ]);
    const took = Date.now() - started;
    expect(result.failures.map((f) => f.name)).toEqual(['quiet-a', 'quiet-b']);
    expect(result.failures[0]!.message).toContain('did not finish connecting');
    // Sequential would be >= 2s; parallel is about one deadline.
    expect(took).toBeLessThan(1900);
  });

  it('caps the connect wait for a remote server', () => {
    expect(MCP_CONNECT_TIMEOUT_MS).toBe(20_000);
  });
});
