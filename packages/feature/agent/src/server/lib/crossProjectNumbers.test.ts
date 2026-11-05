import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../../../../../../../dist/naby-runtime.mjs';
import type { CrossSessionMeta, ExecCtx, Store, ToolOutput } from '../../../../../../../dist/naby-runtime.mjs';
import { addCrossProjectApprovalPair, makeCrossProjectGuard, makeCrossProjectTools, resetCrossProjectDecisions } from './crossProject';
import {
  crossSessionCustomTitleKey,
  makeCrossSessionTools,
  pendingCountFrom,
  resetCrossSessionRegistry,
  type CrossSessionDeps,
  type CrossSessionOutcome,
} from './crossSession';
import { customTitleKey } from '../api/sessions/nabyBrowse';
import { hasPendingApproval, resolveApproval } from './approvalRegistry';
import { crossProjectFromApproval, crossProjectLabelKey, crossProjectQuestionKey } from '../../client/crossProjectApproval';

/**
 * CALLING A PROJECT BY ITS SIDEBAR NUMBER, AND OPENING A CONVERSATION THERE
 * (specs/cross-project-context.md §3a, R7a–R7e; project-groups §9).
 *
 * The sidebar here, in the order the list save recorded:
 *
 *   RMS   1 server · 2 client · 3 proposal (this project) · 4 dt
 *   Misc  1 other
 *   —     1 loose
 *
 * No model, no orchestrator: the delivery is the real `deliverCrossSession`
 * over a stub dispatch and run hub.
 */

type F = { store: Store; proposal: string; server: string; client: string; dt: string; other: string; loose: string };

function fixture(): F {
  const root = mkdtempSync(join(tmpdir(), 'naby-cross-project-numbers-'));
  const mk = (n: string) => {
    const d = join(root, n);
    mkdirSync(d);
    return d;
  };
  const [proposal, server, client, dt, other, loose] = ['proposal', 'server', 'client', 'DT_RMS', 'other', 'loose'].map(mk) as [
    string, string, string, string, string, string,
  ];
  const store = new MemoryStore() as unknown as Store;
  // Upserted in an order unlike the sidebar's: the numbers must follow the
  // stored sidebar order, not the table's last-opened order.
  for (const c of [loose, other, dt, client, server, proposal]) store.upsertProject(c);
  store.setSetting('sidebar.projectOrder', JSON.stringify([server, other, client, loose, proposal, dt]));
  store.setSetting(
    'sidebar.projectGroups',
    JSON.stringify({
      groups: [
        { id: 'g_rms', name: 'RMS', collapsed: false, cwds: [dt, proposal, client, server] },
        { id: 'g_misc', name: 'Misc', collapsed: true, cwds: [other] },
      ],
    }),
  );
  return { store, proposal, server, client, dt, other, loose };
}

let seq = 0;
const ctx = (): ExecCtx =>
  ({ toolCall: { toolCallId: `n${++seq}`, toolName: 'x', input: {} }, signal: new AbortController().signal }) as ExecCtx;

function guardFor(f: F, sessionId: string, events: Record<string, unknown>[]) {
  return makeCrossProjectGuard({
    store: f.store,
    sessionId,
    cwd: f.proposal,
    emit: (e) => events.push(e),
    signal: new AbortController().signal,
    ttlMs: 60_000,
    log: () => {},
  });
}

async function answer(events: Record<string, unknown>[], n: number, decision: 'allow' | 'deny') {
  const cards = () => events.filter((e) => e.type === 'approval_request');
  for (let i = 0; i < 100 && cards().length < n; i++) await new Promise((r) => setTimeout(r, 5));
  const card = cards()[n - 1]!;
  expect(hasPendingApproval(card.approvalId as string)).toBe(true);
  resolveApproval(card.approvalId as string, decision === 'deny' ? { behavior: 'deny', reason: 'no' } : { behavior: 'allow' });
  return card;
}

beforeEach(() => {
  resetCrossProjectDecisions();
  resetCrossSessionRegistry();
});

describe('naby_read_project and naby_list_projects by number (R7a, R7b)', () => {
  function readTools(f: F) {
    const sessionId = f.store.createSession('', 'Plan', f.proposal).sessionId;
    for (const to of [f.server, f.client, f.dt, f.other, f.loose]) addCrossProjectApprovalPair(f.store, f.proposal, to);
    const tools = makeCrossProjectTools({ store: f.store, sessionId, cwd: f.proposal, guard: guardFor(f, sessionId, []) });
    const read = (project: string): Promise<ToolOutput> => tools.executors.naby_read_project!({ project, op: 'list_dir' }, ctx());
    return { tools, read };
  }
  const origin = (out: ToolOutput) => out.content.split('\n')[0];

  it('"N" is N in this project’s section; "<group> N" another section; the server counts, in sidebar order', async () => {
    const f = fixture();
    const { read } = readTools(f);
    expect(origin(await read('1'))).toContain(f.server);
    expect(origin(await read('2번'))).toContain(f.client);
    expect(origin(await read('4'))).toContain(f.dt);
    expect(origin(await read('RMS 2'))).toContain(f.client);
    expect(origin(await read('rms 그룹 4번'))).toContain(f.dt);
    expect(origin(await read('Misc 1'))).toContain(f.other); // a folded group keeps its numbers
    expect(origin(await read('ungrouped 1'))).toContain(f.loose);
    expect(origin(await read('DT_RMS'))).toContain(f.dt); // names still work
  });

  it('out of range and "this project" are answered, not guessed', async () => {
    const f = fixture();
    const { read } = readTools(f);
    const far = await read('5');
    expect(far.isError).toBe(true);
    expect(far.content).toContain('no number 5 in group "RMS"');
    expect(far.content).toContain('1–4');
    const self = await read('3');
    expect(self.isError).toBe(true);
    expect(self.content).toContain('is this project itself');
    expect((await read('Misc 2')).content).toContain('no number 2 in group "Misc"');
    expect((await read('Nope 1')).content).toContain('no project "Nope 1"');
  });

  it('the list carries each project’s section and number, in sidebar order, and says which this project is', async () => {
    const f = fixture();
    const { tools } = readTools(f);
    const out = await tools.executors.naby_list_projects!({}, ctx());
    expect(out.content).toContain('This project is group "RMS" #3.');
    const lines = out.content.split('\n').filter((l) => l.startsWith('- '));
    expect(lines.map((l) => /^- \[([^\]]+)\] "([^"]+)"/.exec(l)!.slice(1).join(' '))).toEqual([
      'group "RMS" #1 server',
      'group "RMS" #2 client',
      'group "RMS" #4 DT_RMS',
      'group "Misc" #1 other',
      'no group #1 loose',
    ]);
    const rows = (out.data as { projects: { cwd: string; number?: number }[] }).projects;
    expect(rows.find((r) => r.cwd === f.dt)?.number).toBe(4);
  });

  it('reordering the sidebar renumbers on the next call (R32)', async () => {
    const f = fixture();
    const { read } = readTools(f);
    f.store.setSetting('sidebar.projectOrder', JSON.stringify([f.dt, f.server, f.client, f.proposal, f.other, f.loose]));
    expect(origin(await read('1'))).toContain(f.dt);
  });
});

describe('the card names the number (R7e)', () => {
  it('the read card carries number and section, and the client draws "RMS 4번 ‹DT_RMS›"', async () => {
    const f = fixture();
    const sessionId = f.store.createSession('', 'Plan', f.proposal).sessionId;
    const events: Record<string, unknown>[] = [];
    const tools = makeCrossProjectTools({ store: f.store, sessionId, cwd: f.proposal, guard: guardFor(f, sessionId, events) });
    const pending = tools.executors.naby_read_project!({ project: '4', op: 'list_dir' }, ctx());
    const card = await answer(events, 1, 'allow');
    await pending;
    expect(card.input).toMatchObject({ project: 'DT_RMS', cwd: f.dt, number: 4, section: 'RMS' });
    const drawn = crossProjectFromApproval(card)!;
    expect(drawn).toMatchObject({ number: 4, section: 'RMS' });
    const label = crossProjectLabelKey(drawn)!;
    expect(label.key).toBe('toolApproval.crossProject.projectNumbered');
    expect(label.params).toEqual({ section: 'RMS', number: 4, project: 'DT_RMS' });
  });

  it('an ungrouped project is labelled by number alone', () => {
    const label = crossProjectLabelKey({ project: 'loose', cwd: '/l', kind: 'read', relation: 'other-group', number: 1 })!;
    expect(label.key).toBe('toolApproval.crossProject.projectNumberedNoGroup');
  });
});

// ---------------------------------------------------------------------------
// naby_send_to_session with `project` (R7c, R7d)
// ---------------------------------------------------------------------------

type Dispatched = { sessionId: string; cwd?: string; prompt: string; meta: CrossSessionMeta };

/** A stub hub + dispatch. A request turn stays "running" until `finish(key)`
 *  when `hold` is set; a reply turn finishes at once. */
function stubRuns(store: Store, opts: { hold?: boolean } = {}) {
  const active = new Set<string>();
  const snaps = new Map<string, unknown[]>();
  const dispatched: Dispatched[] = [];
  const deps: CrossSessionDeps = {
    store,
    retryDelayMs: 0,
    pollMs: 1,
    log: () => {},
    hub: {
      isRunActive: (k) => active.has(k),
      getRunSnapshot: (k) => (snaps.has(k) ? { events: snaps.get(k)! } : undefined),
      requestStop: (k) => active.delete(k),
    },
    dispatch: async (input) => {
      if (active.has(input.sessionId)) return { ok: false, status: 409, error: 'session is already running' };
      dispatched.push({ sessionId: input.sessionId, cwd: input.cwd, prompt: input.prompt, meta: input.crossSession });
      snaps.set(input.sessionId, [{ type: 'result', result: `answer ${dispatched.length}` }]);
      if (input.crossSession.role === 'request' && opts.hold) active.add(input.sessionId);
      return { ok: true, runKey: input.sessionId };
    },
  };
  return { deps, dispatched, finish: (k: string) => active.delete(k), active };
}

function sendTools(f: F, runs: ReturnType<typeof stubRuns>) {
  const sessionId = f.store.createSession('', 'Plan', f.proposal).sessionId;
  const events: Record<string, unknown>[] = [];
  const announced: string[] = [];
  const deliveries: Promise<CrossSessionOutcome>[] = [];
  const tools = makeCrossSessionTools({
    store: f.store,
    sessionId,
    cwd: f.proposal,
    isRunActive: () => false,
    log: () => {},
    deliveryDeps: async () => runs.deps,
    onDelivery: (p) => deliveries.push(p),
    crossProject: { store: f.store, guard: guardFor(f, sessionId, events), announce: (cwd) => announced.push(cwd) },
  });
  const send = (input: Record<string, unknown>) => tools.executors.naby_send_to_session!(input, ctx());
  return { sessionId, events, announced, deliveries, tools, send };
}

describe('send by project: the open tabs decide (R7c)', () => {
  it('one open tab: asks, then sends there', async () => {
    const f = fixture();
    const runs = stubRuns(f.store);
    const api = f.store.createSession('', 'API', f.server).sessionId;
    const t = sendTools(f, runs);
    const pending = t.send({ project: '1', request: 'what changed?' });
    const card = await answer(t.events, 1, 'allow');
    const out = await pending;
    expect(card.input).toMatchObject({ kind: 'send', sessionTitle: 'API', project: 'server', number: 1, section: 'RMS' });
    expect((card.input as Record<string, unknown>).newSession).toBeUndefined();
    expect(out.isError).toBeFalsy();
    expect(out.data).toMatchObject({ ok: true, sessionId: api });
    await Promise.all(t.deliveries);
    expect(runs.dispatched.map((d) => [d.sessionId, d.cwd, d.meta.role])).toEqual([
      [api, f.server, 'request'],
      [t.sessionId, f.proposal, 'reply'],
    ]);
    expect(t.announced).toEqual([]);
  });

  it('several open tabs: nothing is sent, no card, the tabs are listed', async () => {
    const f = fixture();
    const runs = stubRuns(f.store);
    const one = f.store.createSession('', 'API', f.server).sessionId;
    const two = f.store.createSession('', 'Deploy', f.server).sessionId;
    const t = sendTools(f, runs);
    const out = await t.send({ project: 'server', request: 'x' });
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain('Nothing was sent');
    expect(out.content).toContain(one);
    expect(out.content).toContain(two);
    expect(out.data).toMatchObject({ ok: false, reason: 'choose-tab' });
    expect(t.events.filter((e) => e.type === 'approval_request')).toHaveLength(0);
    expect(pendingCountFrom(t.sessionId)).toBe(0);
    expect(runs.dispatched).toEqual([]);
  });

  it('this project, a bad number, or a declined card send nothing', async () => {
    const f = fixture();
    const runs = stubRuns(f.store);
    const t = sendTools(f, runs);
    expect((await t.send({ project: '3', request: 'x' })).content).toContain('is this project itself');
    expect((await t.send({ project: 'RMS 9', request: 'x' })).content).toContain('no number 9');
    const pending = t.send({ project: 'Misc 1', request: 'x' });
    await answer(t.events, 1, 'deny');
    expect((await pending).isError).toBe(true);
    expect(f.store.listSessionsByProject(f.other)).toEqual([]);
    expect(runs.dispatched).toEqual([]);
  });
});

describe('no open tab: a new conversation in the target project (R7d)', () => {
  it('asks first with the new-conversation card, then opens a normal session there and round-trips the answer', async () => {
    const f = fixture();
    const runs = stubRuns(f.store);
    const t = sendTools(f, runs);
    const pending = t.send({ project: 'RMS 4', request: 'Check the RMS schema\nthen report the diff', context: 'v2 API' });
    // Nothing is opened before the user answers.
    for (let i = 0; i < 100 && t.events.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(f.store.listSessionsByProject(f.dt)).toEqual([]);
    const card = await answer(t.events, 1, 'allow');
    expect(card.input).toMatchObject({ kind: 'send', newSession: true, project: 'DT_RMS', number: 4, section: 'RMS' });
    expect((card.input as Record<string, unknown>).sessionTitle).toBeUndefined();
    const drawn = crossProjectFromApproval(card)!;
    expect(crossProjectQuestionKey(drawn).key).toBe('toolApproval.crossProject.sendNew');

    const out = await pending;
    expect(out.isError).toBeFalsy();
    const created = f.store.listSessionsByProject(f.dt);
    expect(created).toHaveLength(1);
    const session = created[0]!;
    expect(session.cwd).toBe(f.dt);
    expect(session.title).toBe('Check the RMS schema');
    expect(f.store.getSetting(crossSessionCustomTitleKey(session.sessionId))).toBe('Check the RMS schema');
    expect(crossSessionCustomTitleKey('x')).toBe(customTitleKey('x'));
    expect(out.data).toMatchObject({ ok: true, sessionId: session.sessionId, openedSession: true });
    expect(out.content).toContain('Opened a new conversation "Check the RMS schema" in project "DT_RMS"');
    // The sidebar is told the project's sessions changed.
    expect(t.announced).toEqual([f.dt]);

    await Promise.all(t.deliveries);
    expect(runs.dispatched.map((d) => [d.sessionId, d.cwd, d.meta.role, d.meta.fromProject])).toEqual([
      [session.sessionId, f.dt, 'request', 'proposal'],
      [t.sessionId, f.proposal, 'reply', 'DT_RMS'],
    ]);
    expect(runs.dispatched[0]!.prompt).toContain('of project "proposal"');
    expect(runs.dispatched[0]!.prompt).toContain('v2 API');
    expect(runs.dispatched[1]!.prompt).toContain('answer 1');
    expect(runs.dispatched[1]!.prompt).toContain('of project "DT_RMS"');
  });

  it('two calls released by one card open ONE session; the second waits for the first to finish there', async () => {
    const f = fixture();
    const runs = stubRuns(f.store, { hold: true });
    const t = sendTools(f, runs);
    const first = t.send({ project: 'loose', request: 'step one' });
    const second = t.send({ project: 'ungrouped 1', request: 'step two' });
    await answer(t.events, 1, 'allow');
    const [o1, o2] = await Promise.all([first, second]);
    expect(t.events.filter((e) => e.type === 'approval_request')).toHaveLength(1);
    const sessions = f.store.listSessionsByProject(f.loose);
    expect(sessions).toHaveLength(1);
    const opened = sessions[0]!.sessionId;
    expect(o1.data).toMatchObject({ sessionId: opened, openedSession: true });
    expect(o2.data).toMatchObject({ sessionId: opened });
    expect((o2.data as Record<string, unknown>).openedSession).toBeUndefined();

    // The first request is running there; the second has not been dispatched.
    for (let i = 0; i < 100 && runs.dispatched.length === 0; i++) await new Promise((r) => setTimeout(r, 2));
    await new Promise((r) => setTimeout(r, 20));
    expect(runs.dispatched.filter((d) => d.meta.role === 'request')).toHaveLength(1);

    // A third request while the first still runs goes to the same session too
    // (after its own card — "allow once" covered only the calls it was asked for).
    const third = t.send({ project: 'loose', request: 'step three' });
    await answer(t.events, 2, 'allow');
    expect((await third).data).toMatchObject({ sessionId: opened });
    expect(f.store.listSessionsByProject(f.loose)).toHaveLength(1);

    runs.finish(opened);
    for (let i = 0; i < 200 && runs.dispatched.filter((d) => d.meta.role === 'request').length < 2; i++) {
      await new Promise((r) => setTimeout(r, 2));
    }
    runs.finish(opened);
    for (let i = 0; i < 200 && runs.dispatched.filter((d) => d.meta.role === 'request').length < 3; i++) {
      await new Promise((r) => setTimeout(r, 2));
      runs.finish(opened);
    }
    const outcomes = await Promise.all(t.deliveries);
    expect(outcomes.every((o) => o.phase === 'replied')).toBe(true);
    const requests = runs.dispatched.filter((d) => d.meta.role === 'request');
    expect(requests.map((d) => d.sessionId)).toEqual([opened, opened, opened]);
    expect(requests.map((d) => /step (one|two|three)/.exec(d.prompt)![0])).toEqual(['step one', 'step two', 'step three']);
  });
});

describe('a request lined up behind another (R7d)', () => {
  it('fails as target-closed when the opened session is closed while it waits', async () => {
    const f = fixture();
    const runs = stubRuns(f.store, { hold: true });
    const t = sendTools(f, runs);
    const first = t.send({ project: 'loose', request: 'one' });
    const second = t.send({ project: 'loose', request: 'two' });
    await answer(t.events, 1, 'allow');
    await Promise.all([first, second]);
    const opened = f.store.listSessionsByProject(f.loose)[0]!.sessionId;
    for (let i = 0; i < 100 && runs.dispatched.length === 0; i++) await new Promise((r) => setTimeout(r, 2));
    f.store.deleteSession(opened);
    const outcomes = await Promise.all(t.deliveries);
    expect(outcomes.map((o) => (o.phase === 'failed' ? o.reason : o.phase))).toEqual(['target-closed', 'target-closed']);
    expect(runs.dispatched.filter((d) => d.meta.role === 'request')).toHaveLength(1);
  });
});
