import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, SqliteStore } from '../../../../../../../dist/naby-runtime.mjs';
import type { ExecCtx, Store, ToolOutput } from '../../../../../../../dist/naby-runtime.mjs';
import {
  CROSS_PROJECT_ENABLED_KEY,
  CROSS_PROJECT_SOURCE,
  addCrossProjectApprovalPair,
  crossProjectAccess,
  crossProjectDeclined,
  crossProjectStanding,
  listCrossProjectApprovals,
  listCrossProjects,
  makeCrossProjectGuard,
  makeCrossProjectTools,
  readCrossProjectApprovals,
  readCrossProjectEnabled,
  recordCrossProjectDecline,
  removeCrossProjectApprovalPair,
  resetCrossProjectDecisions,
  writeCrossProjectEnabled,
} from './crossProject';
import { CROSS_PROJECT_ACCESS_TOOL, approvalMayRemember, hasPendingApproval, resolveApproval } from './approvalRegistry';

/**
 * LOOKING INTO ANOTHER PROJECT (specs/cross-project-context.md §9) — the one
 * access decision, the self-raised card, and the read executors over a real
 * temporary git repository. No model, no orchestrator; the store is an
 * in-memory one and every folder lives under mkdtemp.
 */

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });

type Fixture = {
  store: Store;
  root: string;
  proposal: string;
  server: string;
  client: string;
  other: string;
  outside: string;
};

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'naby-cross-project-'));
  const mk = (name: string) => {
    const d = join(root, name);
    mkdirSync(d, { recursive: true });
    return d;
  };
  const proposal = mk('proposal');
  const server = mk('server');
  const client = mk('client');
  const other = mk('other');
  const outside = mk('secret');
  writeFileSync(join(outside, 'key.txt'), 'top secret');

  // server: a git repo with one commit and one working-tree change.
  mkdirSync(join(server, 'src'));
  writeFileSync(join(server, 'src', 'api.ts'), 'export const version = 1;\n');
  git(server, 'init', '-q');
  git(server, 'add', '.');
  git(server, 'commit', '-q', '-m', 'first api');
  writeFileSync(join(server, 'src', 'api.ts'), 'export const version = 2;\n');
  symlinkSync(join(outside, 'key.txt'), join(server, 'leak.txt'));
  writeFileSync(join(other, 'notes.md'), '# other\n');

  const store = new MemoryStore() as unknown as Store;
  for (const cwd of [proposal, server, client, other]) store.upsertProject(cwd);
  store.upsertProject(client, { title: '고객 앱' });
  store.setSetting(
    'sidebar.projectGroups',
    JSON.stringify({
      groups: [
        { id: 'g_rms', name: 'RMS', collapsed: false, cwds: [proposal, server, client] },
        { id: 'g_misc', name: 'Misc', collapsed: false, cwds: [other] },
      ],
    }),
  );
  return { store, root, proposal, server, client, other, outside };
}

let seq = 0;
const ctx = (): ExecCtx =>
  ({ toolCall: { toolCallId: `c${++seq}`, toolName: 'naby_read_project', input: {} }, signal: new AbortController().signal }) as ExecCtx;

function setup(f: Fixture, opts: { ttlMs?: number; signal?: AbortSignal; alwaysAllowed?: string[] } = {}) {
  const sessionId = f.store.createSession('', 'Plan', f.proposal).sessionId;
  for (const to of opts.alwaysAllowed ?? []) addCrossProjectApprovalPair(f.store, f.proposal, to);
  const events: Record<string, unknown>[] = [];
  const logs: { kind: string; payload: Record<string, unknown> }[] = [];
  const guard = makeCrossProjectGuard({
    store: f.store,
    sessionId,
    cwd: f.proposal,
    emit: (e) => events.push(e),
    signal: opts.signal ?? new AbortController().signal,
    ttlMs: opts.ttlMs ?? 60_000,
    log: (kind, payload) => logs.push({ kind, payload }),
  });
  const tools = makeCrossProjectTools({ store: f.store, sessionId, cwd: f.proposal, guard });
  const read = (input: Record<string, unknown>): Promise<ToolOutput> =>
    tools.executors.naby_read_project!(input, ctx());
  const cards = () => events.filter((e) => e.type === 'approval_request');
  return { sessionId, events, logs, tools, read, cards };
}

/** Answer the card that is (or is about to be) open. `allow` is "allow once",
 *  `always` is "always allow" (an allow carrying the `always` extra). */
async function answer(cards: () => Record<string, unknown>[], n: number, decision: 'allow' | 'always' | 'deny') {
  for (let i = 0; i < 50 && cards().length < n; i++) await new Promise((r) => setTimeout(r, 5));
  const card = cards()[n - 1]!;
  expect(hasPendingApproval(card.approvalId as string)).toBe(true);
  resolveApproval(
    card.approvalId as string,
    decision === 'deny' ? { behavior: 'deny', reason: 'no' } : { behavior: 'allow' },
    decision === 'always' ? { always: true } : undefined,
  );
}

beforeEach(() => resetCrossProjectDecisions());

describe('the one decision (R1–R5)', () => {
  it('same project, same group, another group, a path not listed — relation and access apart', () => {
    const f = fixture();
    const s = f.store.createSession('', 'x', f.proposal).sessionId;
    expect(crossProjectStanding(f.store, f.proposal, f.proposal, s)).toEqual({ relation: 'same-project', access: 'same-project' });
    // 0.2.0: the same group is a RELATION only — its access still needs approval.
    expect(crossProjectStanding(f.store, f.proposal, f.server, s)).toEqual({
      relation: 'same-group',
      access: 'needs-approval',
      group: 'RMS',
    });
    expect(crossProjectStanding(f.store, f.proposal, f.other, s)).toEqual({ relation: 'other-group', access: 'needs-approval' });
    expect(crossProjectStanding(f.store, f.proposal, f.outside, s)).toEqual({ relation: 'unknown-project', access: 'unknown-project' });
    recordCrossProjectDecline(s, f.server);
    expect(crossProjectAccess(f.store, f.proposal, f.server, s)).toBe('denied');
    addCrossProjectApprovalPair(f.store, f.proposal, f.other);
    expect(crossProjectAccess(f.store, f.proposal, f.other, s)).toBe('approved');
    // A permanent pair wins over an older decline.
    addCrossProjectApprovalPair(f.store, f.proposal, f.server);
    expect(crossProjectAccess(f.store, f.proposal, f.server, s)).toBe('approved');
  });

  it('a permanent approval is directed (R18)', () => {
    const f = fixture();
    const s = f.store.createSession('', 'x', f.proposal).sessionId;
    addCrossProjectApprovalPair(f.store, f.proposal, f.server);
    expect(crossProjectAccess(f.store, f.proposal, f.server, s)).toBe('approved');
    expect(crossProjectAccess(f.store, f.server, f.proposal, s)).toBe('needs-approval');
    expect(crossProjectAccess(f.store, f.proposal, f.client, s)).toBe('needs-approval');
  });

  it('with no group, every other project is outside (R4)', () => {
    const f = fixture();
    f.store.setSetting('sidebar.projectGroups', '');
    const s = f.store.createSession('', 'x', f.proposal).sessionId;
    expect(crossProjectAccess(f.store, f.proposal, f.server, s)).toBe('needs-approval');
  });

  it('a closed tab forgets its declines (R18)', () => {
    const f = fixture();
    const s = f.store.createSession('', 'x', f.proposal).sessionId;
    recordCrossProjectDecline(s, f.other);
    f.store.deleteSession(s);
    crossProjectAccess(f.store, f.proposal, f.other, 'someone-else');
    expect(crossProjectDeclined(s, f.other)).toBe(false);
  });

  it('the list names, groups and access of every other project', () => {
    const f = fixture();
    const s = f.store.createSession('', 'x', f.proposal).sessionId;
    const rows = listCrossProjects(f.store, f.proposal, s);
    expect(rows.map((r) => r.cwd).sort()).toEqual([f.server, f.client, f.other].sort());
    expect(rows.find((r) => r.cwd === f.client)).toMatchObject({
      name: '고객 앱',
      group: 'RMS',
      relation: 'same-group',
      access: 'needs-approval',
    });
    expect(rows.find((r) => r.cwd === f.other)).toMatchObject({
      name: 'other',
      group: 'Misc',
      relation: 'other-group',
      access: 'needs-approval',
    });
    addCrossProjectApprovalPair(f.store, f.proposal, f.client);
    expect(listCrossProjects(f.store, f.proposal, s).find((r) => r.cwd === f.client)?.access).toBe('approved');
  });

  it('the setting is on by default and switches off (R6)', () => {
    const store = new MemoryStore() as unknown as Store;
    expect(readCrossProjectEnabled(store)).toBe(true);
    writeCrossProjectEnabled(store, false);
    expect(store.getSetting(CROSS_PROJECT_ENABLED_KEY)).toBe('false');
    expect(readCrossProjectEnabled(store)).toBe(false);
  });
});

describe('always allowed — no card', () => {
  it('reads a file and the git diff of a permanently allowed project', async () => {
    const f = fixture();
    const { read, cards, logs } = setup(f, { alwaysAllowed: [f.server] });
    const file = await read({ project: 'server', op: 'read_file', path: 'src/api.ts' });
    expect(file.isError).toBeFalsy();
    expect(file.content.split('\n')[0]).toBe(`[from project "server" — ${f.server}, read-only]`);
    expect(file.content).toContain('<untrusted_cross_project_content>');
    expect(file.content).toContain('version = 2');
    const diff = await read({ project: f.server, op: 'git_diff' });
    expect(diff.isError).toBeFalsy();
    expect(diff.content).toMatch(/-export const version = 1;[\s\S]*\+export const version = 2;/);
    const log = await read({ project: 'server', op: 'git_log' });
    expect(log.content).toContain('first api');
    const status = await read({ project: 'server', op: 'git_status' });
    expect(status.content).toMatch(/M src\/api\.ts/);
    expect(cards()).toHaveLength(0);
    const access = logs.filter((l) => l.kind === 'cross_project_access');
    expect(
      access.every(
        (l) => l.payload.verdict === 'approved' && l.payload.relation === 'same-group' && l.payload.targetCwd === f.server,
      ),
    ).toBe(true);
    // R25: the content is never in the log.
    expect(JSON.stringify(logs)).not.toContain('version = 2');
  });

  it('a renamed project is found by its name; list_dir, glob and grep work', async () => {
    const f = fixture();
    writeFileSync(join(f.client, 'app.ts'), 'callApi(version)\n');
    const { read } = setup(f, { alwaysAllowed: [f.server, f.client] });
    expect((await read({ project: '고객 앱', op: 'list_dir' })).content).toContain('app.ts');
    expect((await read({ project: 'server', op: 'glob', pattern: '**/*.ts' })).content).toContain('src/api.ts');
    expect((await read({ project: 'server', op: 'grep', pattern: 'version' })).content).toContain('src/api.ts:1');
  });

  it('a folder that is not a git repository says so', async () => {
    const f = fixture();
    const { read } = setup(f, { alwaysAllowed: [f.client] });
    const out = await read({ project: f.client, op: 'git_status' });
    expect(out.isError).toBe(true);
    expect(out.content).toContain('not a git repository');
  });
});

describe('paths stay inside the target (§9)', () => {
  it('refuses ../, an absolute path outside and a symlink out', async () => {
    const f = fixture();
    const { read } = setup(f, { alwaysAllowed: [f.server] });
    for (const path of ['../secret/key.txt', join(f.outside, 'key.txt'), 'leak.txt']) {
      const out = await read({ project: 'server', op: 'read_file', path });
      expect(out.isError, path).toBe(true);
      expect(out.content, path).not.toContain('top secret');
    }
    const g = await read({ project: 'server', op: 'git_log', path: '../secret' });
    expect(g.isError).toBe(true);
    const ref = await read({ project: 'server', op: 'git_show', ref: '--output=/tmp/x' });
    expect(ref.isError).toBe(true);
    expect(ref.content).toMatch(/starts with "-"/);
  });

  it('a path not in the sidebar list is not a project (R1)', async () => {
    const f = fixture();
    const { read } = setup(f);
    const out = await read({ project: f.outside, op: 'list_dir' });
    expect(out.isError).toBe(true);
    expect(out.content).toContain('naby_list_projects');
  });

  it('has no op that writes or runs (R12)', () => {
    const f = fixture();
    const { tools } = setup(f);
    const op = (tools.schemas[1]!.parameters as { properties: { op: { enum: string[] } } }).properties.op.enum;
    expect(op).toEqual(['list_dir', 'read_file', 'glob', 'grep', 'git_status', 'git_log', 'git_diff', 'git_show']);
    expect(tools.schemas.map((s) => s.name)).toEqual(['naby_list_projects', 'naby_read_project']);
  });
});

describe('the card (R17–R19) — same group and other group alike', () => {
  it('a same-group project raises a card naming the group', async () => {
    const f = fixture();
    const { read, cards } = setup(f);
    const pending = read({ project: 'server', op: 'read_file', path: 'src/api.ts' });
    await answer(cards, 1, 'allow');
    expect((await pending).isError).toBeFalsy();
    expect(cards()[0]).toMatchObject({
      tool_name: CROSS_PROJECT_ACCESS_TOOL,
      source: CROSS_PROJECT_SOURCE,
      input: { project: 'server', cwd: f.server, kind: 'read', relation: 'same-group', group: 'RMS' },
    });
  });

  it('an other-group project raises a card saying so, with no group name', async () => {
    const f = fixture();
    const { read, cards } = setup(f);
    const pending = read({ project: 'other', op: 'list_dir' });
    await answer(cards, 1, 'deny');
    await pending;
    const input = cards()[0]!.input as Record<string, unknown>;
    expect(input).toMatchObject({ project: 'other', cwd: f.other, kind: 'read', relation: 'other-group' });
    expect(input.group).toBeUndefined();
  });

  it('allow once: this call passes, the next one asks again, nothing is stored', async () => {
    const f = fixture();
    const { read, cards, events, logs, sessionId } = setup(f);
    const pending = read({ project: 'other', op: 'read_file', path: 'notes.md' });
    await answer(cards, 1, 'allow');
    const out = await pending;
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain('# other');
    expect(events.some((e) => e.type === 'approval_resolved' && e.decision === 'allow' && !e.always)).toBe(true);
    expect(readCrossProjectApprovals(f.store)).toEqual([]);
    expect(crossProjectAccess(f.store, f.proposal, f.other, sessionId)).toBe('needs-approval');
    const again = read({ project: 'other', op: 'list_dir' });
    await answer(cards, 2, 'allow');
    expect((await again).isError).toBeFalsy();
    expect(cards()).toHaveLength(2);
    expect(logs.filter((l) => l.kind === 'cross_project_access').map((l) => l.payload.approval)).toEqual(['allow', 'allow']);
    // The answer is never a policy rule.
    expect(approvalMayRemember(cards()[0]!.approvalId as string, CROSS_PROJECT_ACCESS_TOOL)).toBe(false);
  });

  it('always allow: stored as a directed pair, no card afterwards — even from another session', async () => {
    const f = fixture();
    const { read, cards, events } = setup(f);
    const pending = read({ project: 'server', op: 'list_dir' });
    await answer(cards, 1, 'always');
    expect((await pending).isError).toBeFalsy();
    expect(events.some((e) => e.type === 'approval_resolved' && e.decision === 'allow' && e.always === true)).toBe(true);
    expect(readCrossProjectApprovals(f.store).map((p) => [p.from, p.to])).toEqual([[f.proposal, f.server]]);
    expect((await read({ project: 'server', op: 'list_dir' })).isError).toBeFalsy();
    expect(cards()).toHaveLength(1);
    // A different session of the same project: still no card.
    const second = setup(f);
    expect((await second.read({ project: 'server', op: 'list_dir' })).isError).toBeFalsy();
    expect(second.cards()).toHaveLength(0);
    // Directed: proposal→client still asks.
    const toClient = second.read({ project: f.client, op: 'list_dir' });
    await answer(second.cards, 1, 'deny');
    expect((await toClient).isError).toBe(true);
  });

  it('always allow survives a fresh store and a fresh registry (app restart)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'naby-cross-project-db-'));
    const path = join(dir, 'app.db');
    const proposal = join(dir, 'proposal');
    const server = join(dir, 'server');
    mkdirSync(proposal);
    mkdirSync(server);
    writeFileSync(join(server, 'a.txt'), 'hello');
    const first = new SqliteStore({ path }) as unknown as Store;
    first.upsertProject(proposal);
    first.upsertProject(server);
    const f1 = { store: first, root: dir, proposal, server, client: server, other: server, outside: dir } as Fixture;
    const a = setup(f1);
    const pending = a.read({ project: server, op: 'read_file', path: 'a.txt' });
    await answer(a.cards, 1, 'always');
    expect((await pending).isError).toBeFalsy();
    (first as unknown as { close(): void }).close();

    resetCrossProjectDecisions();
    const reopened = new SqliteStore({ path }) as unknown as Store;
    const b = setup({ ...f1, store: reopened });
    const out = await b.read({ project: server, op: 'read_file', path: 'a.txt' });
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain('hello');
    expect(b.cards()).toHaveLength(0);
    // The reverse direction was never allowed.
    expect(crossProjectAccess(reopened, server, proposal, b.sessionId)).toBe('needs-approval');
    (reopened as unknown as { close(): void }).close();
  });

  it('removing a permanent approval brings the card back (R18a)', async () => {
    const f = fixture();
    const { read, cards } = setup(f, { alwaysAllowed: [f.server] });
    expect((await read({ project: 'server', op: 'list_dir' })).isError).toBeFalsy();
    expect(cards()).toHaveLength(0);
    expect(removeCrossProjectApprovalPair(f.store, f.proposal, f.server)).toBe(true);
    expect(removeCrossProjectApprovalPair(f.store, f.proposal, f.server)).toBe(false);
    const pending = read({ project: 'server', op: 'list_dir' });
    await answer(cards, 1, 'allow');
    await pending;
    expect(cards()).toHaveLength(1);
  });

  it('the settings list names both ends and marks a project gone from the sidebar', () => {
    const f = fixture();
    addCrossProjectApprovalPair(f.store, f.proposal, f.client, 1);
    addCrossProjectApprovalPair(f.store, f.proposal, '/gone/project', 2);
    const rows = listCrossProjectApprovals(f.store);
    expect(rows).toEqual([
      { from: f.proposal, to: f.client, fromName: 'proposal', toName: '고객 앱', fromListed: true, toListed: true, at: 1 },
      { from: f.proposal, to: '/gone/project', fromName: 'proposal', toName: 'project', fromListed: true, toListed: false, at: 2 },
    ]);
  });

  it('declined: refused, and not asked again in the session', async () => {
    const f = fixture();
    const { read, cards } = setup(f);
    const pending = read({ project: 'other', op: 'list_dir' });
    await answer(cards, 1, 'deny');
    const out = await pending;
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/declined/);
    const again = await read({ project: 'other', op: 'list_dir' });
    expect(again.isError).toBe(true);
    expect(cards()).toHaveLength(1);
  });

  it('a timeout is a refusal that says the user did not answer — and is not remembered', async () => {
    const f = fixture();
    const { read, cards, sessionId } = setup(f, { ttlMs: 10 });
    const out = await read({ project: 'other', op: 'list_dir' });
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/did not answer/);
    expect(cards()).toHaveLength(1);
    expect(hasPendingApproval(cards()[0]!.approvalId as string)).toBe(false);
    expect(crossProjectDeclined(sessionId, f.other)).toBe(false);
    expect(readCrossProjectApprovals(f.store)).toEqual([]);
  });

  it('a stopped turn declines without remembering', async () => {
    const f = fixture();
    const ac = new AbortController();
    const { read, cards, sessionId } = setup(f, { signal: ac.signal });
    const pending = read({ project: 'other', op: 'list_dir' });
    for (let i = 0; i < 50 && cards().length < 1; i++) await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    const out = await pending;
    expect(out.isError).toBe(true);
    expect(crossProjectDeclined(sessionId, f.other)).toBe(false);
  });

  it('two calls to the same project while the card is open share one card — one "allow once" covers both', async () => {
    const f = fixture();
    const { read, cards } = setup(f);
    const a = read({ project: 'other', op: 'list_dir' });
    const b = read({ project: 'other', op: 'read_file', path: 'notes.md' });
    await answer(cards, 1, 'allow');
    expect((await a).isError).toBeFalsy();
    expect((await b).isError).toBeFalsy();
    expect(cards()).toHaveLength(1);
    // …and only those: the next call asks again.
    const c = read({ project: 'other', op: 'list_dir' });
    await answer(cards, 2, 'deny');
    expect((await c).isError).toBe(true);
  });
});

describe('the session tools, widened (R7, R8)', () => {
  it("scope 'all' marks every not-yet-allowed tab, same group included; a send there asks, and a refusal sends nothing", async () => {
    const { makeCrossSessionTools, pendingCountFrom, resetCrossSessionRegistry } = await import('./crossSession');
    resetCrossSessionRegistry();
    const f = fixture();
    const { sessionId, events, cards } = setup(f);
    const inServer = f.store.createSession('', 'API', f.server).sessionId;
    const inOther = f.store.createSession('', 'Notes', f.other).sessionId;
    const guard = makeCrossProjectGuard({
      store: f.store,
      sessionId,
      cwd: f.proposal,
      emit: (e) => events.push(e),
      signal: new AbortController().signal,
      ttlMs: 60_000,
      log: () => {},
    });
    const tools = makeCrossSessionTools({
      store: f.store,
      sessionId,
      cwd: f.proposal,
      isRunActive: () => false,
      log: () => {},
      crossProject: { store: f.store, guard },
      deliveryDeps: async () => {
        throw new Error('must not deliver');
      },
    });
    const list = await tools.executors.naby_list_sessions!({ scope: 'all' }, ctx());
    const rows = (list.data as { sessions: { sessionId: string; project?: string; needsApproval?: boolean }[] }).sessions;
    // Listing needs no approval; a same-group tab is marked like any other (0.2.0).
    expect(rows.find((r) => r.sessionId === inServer)).toMatchObject({ project: 'server', needsApproval: true });
    expect(rows.find((r) => r.sessionId === inOther)).toMatchObject({ project: 'other', needsApproval: true });
    const group = await tools.executors.naby_list_sessions!({ scope: 'group' }, ctx());
    expect(JSON.stringify(group.data)).not.toContain(inOther);
    expect(JSON.stringify(group.data)).toContain(inServer);
    addCrossProjectApprovalPair(f.store, f.proposal, f.server);
    const allowed = await tools.executors.naby_list_sessions!({ scope: 'group' }, ctx());
    const serverRow = (allowed.data as { sessions: { sessionId: string; needsApproval?: boolean }[] }).sessions.find(
      (r) => r.sessionId === inServer,
    );
    expect(serverRow?.needsApproval).toBeUndefined();

    const sent = tools.executors.naby_send_to_session!({ sessionId: inOther, request: 'x' }, ctx());
    await answer(cards, 1, 'deny');
    const out = await sent;
    expect(out.isError).toBe(true);
    expect(cards()[0]).toMatchObject({ input: { kind: 'send', sessionTitle: 'Notes', project: 'other' } });
    expect(pendingCountFrom(sessionId)).toBe(0);
    // Refused once: the list now leaves that project out.
    const after = await tools.executors.naby_list_sessions!({ scope: 'all' }, ctx());
    expect(JSON.stringify(after.data)).not.toContain(inOther);
  });
});

describe('a project that is a subdirectory of a larger repo — git stays in the folder', () => {
  it('status, diff, log and show never show files outside the project folder', async () => {
    const root = mkdtempSync(join(tmpdir(), 'naby-cross-project-mono-'));
    const repo = join(root, 'mono');
    const app = join(repo, 'apps', 'server');
    const lib = join(repo, 'libs', 'shared');
    mkdirSync(app, { recursive: true });
    mkdirSync(lib, { recursive: true });
    const here = join(root, 'proposal');
    mkdirSync(here);
    writeFileSync(join(app, 'api.ts'), 'export const v = 1;\n');
    writeFileSync(join(lib, 'outside.ts'), 'export const secret = 1;\n');
    git(repo, 'init', '-q');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init both');
    // A commit that touches BOTH, then one that touches only the outside file.
    writeFileSync(join(app, 'api.ts'), 'export const v = 2;\n');
    writeFileSync(join(lib, 'outside.ts'), 'export const secret = 2;\n');
    git(repo, 'commit', '-q', '-am', 'touch both');
    writeFileSync(join(lib, 'outside.ts'), 'export const secret = 3;\n');
    git(repo, 'commit', '-q', '-am', 'outside only');
    // Working-tree changes on both sides.
    writeFileSync(join(app, 'api.ts'), 'export const v = 3;\n');
    writeFileSync(join(lib, 'outside.ts'), 'export const secret = 4;\n');

    const store = new MemoryStore() as unknown as Store;
    store.upsertProject(here);
    store.upsertProject(app);
    store.setSetting(
      'sidebar.projectGroups',
      JSON.stringify({ groups: [{ id: 'g', name: 'G', collapsed: false, cwds: [here, app] }] }),
    );
    const f = { store, root, proposal: here, server: app, client: app, other: app, outside: lib } as Fixture;
    const { read } = setup(f, { alwaysAllowed: [app] });

    const status = await read({ project: app, op: 'git_status' });
    expect(status.isError).toBeFalsy();
    expect(status.content).toContain('api.ts');
    expect(status.content).not.toContain('outside.ts');

    const diff = await read({ project: app, op: 'git_diff' });
    expect(diff.content).toContain('v = 3');
    expect(diff.content).not.toContain('outside.ts');
    expect(diff.content).not.toContain('secret');

    const diffRef = await read({ project: app, op: 'git_diff', ref: 'HEAD~2' });
    expect(diffRef.content).toContain('api.ts');
    expect(diffRef.content).not.toContain('outside.ts');

    const log = await read({ project: app, op: 'git_log' });
    expect(log.content).toContain('touch both');
    expect(log.content).not.toContain('outside only');

    const showBoth = await read({ project: app, op: 'git_show', ref: 'HEAD~1' });
    expect(showBoth.content).toContain('touch both'); // the commit header stays
    expect(showBoth.content).toContain('api.ts');
    expect(showBoth.content).not.toContain('outside.ts');
    expect(showBoth.content).not.toContain('secret');

    const showOutside = await read({ project: app, op: 'git_show', ref: 'HEAD' });
    expect(showOutside.isError).toBeFalsy();
    expect(showOutside.content).toContain('outside only'); // the header is kept
    expect(showOutside.content).toContain('changes nothing inside the project folder');
    expect(showOutside.content).not.toContain('outside.ts');
    expect(showOutside.content).not.toContain('secret');
  });
});
