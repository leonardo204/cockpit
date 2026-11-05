import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNabySpec, getStore } from './naby';
import { CROSS_SESSION_ENABLED_KEY, resetCrossSessionRegistry, type CrossSessionDeps } from '../lib/crossSession';
import { addCrossProjectApprovalPair, CROSS_PROJECT_ENABLED_KEY, resetCrossProjectDecisions } from '../lib/crossProject';
import { resolveApproval } from '../lib/approvalRegistry';
import { PARTICIPANT_EXCLUDED_TOOLS } from '../lib/participantTurn';
import { toChatMessages } from '../api/session/toChatMessages';
import type { RuntimeMessage } from '../../../../../../../dist/naby-runtime.mjs';
import type { RunCtx, RunEvent } from './types';

/**
 * OTHER PROJECTS, WIRED (cross-project-context R6, R7–R10, R11, R14, R16, R17)
 * — through the production `createNabySpec` with a scripted model: which turns
 * get the two tools, a same-group read that waits on a card naming the group
 * (0.2.0), an out-of-group read that waits on the card, a permanently allowed
 * project read with no card (0.3.0), the group awareness paragraph in the
 * system prompt (R26), and a request to another project's tab whose two legs
 * run in the right folders and carry the project names. The store is the throwaway
 * one vitest.setup.ts points at; folders live under mkdtemp. No model, no
 * second turn (the delivery is a stub).
 */

const LIST_PROJECTS = 'naby_list_projects';
const READ_PROJECT = 'naby_read_project';
const LIST_SESSIONS = 'naby_list_sessions';
const SEND = 'naby_send_to_session';
const GROUPS_KEY = 'sidebar.projectGroups';
const ORDER_KEY = 'sidebar.projectOrder';

type Tool = { name: string; inputSchema?: { properties?: Record<string, unknown> } };
type Call = { tools: Tool[]; system: string };
type Step = { tool?: { id: string; name: string; input: Record<string, unknown> }; text?: string };

function scriptedModel(steps: Step[], calls: Call[]) {
  let i = 0;
  return {
    specificationVersion: 'v4' as const,
    provider: 'mock',
    modelId: 'claude-sonnet-4-5',
    supportedUrls: {},
    async doGenerate(options: { prompt: unknown; tools?: Tool[] }) {
      const prompt = Array.isArray(options.prompt) ? (options.prompt as { role?: string; content?: unknown }[]) : [];
      const system = prompt
        .filter((m) => m.role === 'system')
        .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
        .join('\n\n');
      calls.push({ tools: options.tools ?? [], system });
      const usage = {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      };
      const step = steps[Math.min(i, Math.max(0, steps.length - 1))] ?? { text: 'ok.' };
      i += 1;
      if (step.tool) {
        return {
          content: [
            { type: 'tool-call' as const, toolCallId: step.tool.id, toolName: step.tool.name, input: JSON.stringify(step.tool.input) },
          ],
          finishReason: { unified: 'tool-calls' as const, raw: 'tool_use' },
          usage,
          warnings: [] as never[],
        };
      }
      return {
        content: [{ type: 'text' as const, text: step.text ?? 'ok.' }],
        finishReason: { unified: 'stop' as const, raw: 'end_turn' },
        usage,
        warnings: [] as never[],
      };
    },
    async doStream() {
      throw new Error('not used');
    },
  };
}

function harness(sessionId: string, prompt: string, cwd: string, params: Record<string, unknown> = {}) {
  const events: RunEvent[] = [];
  let key = sessionId;
  const ctx: RunCtx = {
    prompt,
    images: undefined,
    cwd,
    sessionId,
    params: { prompt, engine: 'naby', model: 'claude-sonnet-4-5', ...params },
    signal: new AbortController().signal,
    emit(event: RunEvent) {
      events.push(event);
    },
    rekey(id: string) {
      key = id;
    },
    currentKey() {
      return key;
    },
  };
  return { ctx, events };
}

const names = (c: Call) => c.tools.map((t) => t.name);
const toolResults = (events: RunEvent[]) => JSON.stringify(events.filter((e) => e.type === 'user'));

/** Wait for the n-th access card of a running turn and answer it. */
async function answerCard(events: RunEvent[], n: number, decision: 'allow' | 'always' | 'deny'): Promise<RunEvent> {
  const cards = () => events.filter((e) => e.type === 'approval_request');
  for (let i = 0; i < 400 && cards().length < n; i++) await new Promise((r) => setTimeout(r, 5));
  const card = cards()[n - 1];
  expect(card).toBeDefined();
  resolveApproval(
    (card as { approvalId: string }).approvalId,
    decision === 'deny' ? { behavior: 'deny', reason: 'no' } : { behavior: 'allow' },
    decision === 'always' ? { always: true } : undefined,
  );
  return card!;
}

let proposal: string;
let server: string;
let other: string;
beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'naby-cross-project-engine-'));
  proposal = join(root, 'proposal');
  server = join(root, 'server');
  other = join(root, 'other');
  for (const d of [proposal, server, other]) mkdirSync(d);
  writeFileSync(join(server, 'api.ts'), 'export const route = "/v2/items";\n');
  writeFileSync(join(other, 'notes.md'), 'other notes\n');
  const store = getStore();
  for (const d of [proposal, server, other]) store.upsertProject(d);
  store.setSetting(
    GROUPS_KEY,
    JSON.stringify({ groups: [{ id: 'g_rms', name: 'RMS', collapsed: false, cwds: [proposal, server] }] }),
  );
  resetCrossSessionRegistry();
  resetCrossProjectDecisions();
});
afterEach(() => {
  const store = getStore();
  store.setSetting(CROSS_PROJECT_ENABLED_KEY, '');
  store.setSetting(CROSS_SESSION_ENABLED_KEY, '');
  store.setSetting(GROUPS_KEY, '');
  store.setSetting(ORDER_KEY, '');
  store.setSetting('sessions.crossProject.approvals', '');
  // The store is shared across this file: a second "server" would make the
  // name ambiguous (correctly) for the next test.
  for (const d of [proposal, server, other]) store.removeProject(d);
});

describe('cross-project tools — which turns get them (R6, R16)', () => {
  it('naby’s own turn in a project has both, and the session list takes a scope', async () => {
    const { sessionId } = getStore().createSession('', 'A', proposal);
    const calls: Call[] = [];
    const spec = createNabySpec({ resolveModel: () => scriptedModel([{ text: 'hi' }], calls) as never });
    await spec.runner.run(harness(sessionId, 'hello', proposal).ctx);
    expect(names(calls[0]!)).toEqual(expect.arrayContaining([LIST_PROJECTS, READ_PROJECT, LIST_SESSIONS, SEND]));
    const list = calls[0]!.tools.find((t) => t.name === LIST_SESSIONS)!;
    expect(JSON.stringify(list)).toContain('scope');
  });

  it('none on a scheduled turn, on a turn another session started, or with the setting off', async () => {
    const store = getStore();
    const calls: Call[] = [];
    const spec = createNabySpec({ resolveModel: () => scriptedModel([{ text: 'ok' }], calls) as never });
    const scheduled = store.createSession('', 'sch', proposal).sessionId;
    await spec.runner.run(harness(scheduled, 'daily', proposal, { source: 'scheduled' }).ctx);
    const jobReport = store.createSession('', 'job', proposal).sessionId;
    await spec.runner.run(harness(jobReport, 'job done', proposal, { source: 'job-report' }).ctx);
    const b = store.createSession('', 'B', proposal).sessionId;
    const meta = { requestId: 'xs-1', fromSessionId: 'A', fromTitle: 'Plan', role: 'request' as const, fromProject: 'server' };
    await spec.runner.run(harness(b, '[cross-session request] x', proposal, { source: 'cross-session', crossSession: meta }).ctx);
    store.setSetting(CROSS_PROJECT_ENABLED_KEY, 'false');
    const off = store.createSession('', 'off', proposal).sessionId;
    await spec.runner.run(harness(off, 'hello', proposal).ctx);

    expect(calls).toHaveLength(4);
    for (const c of calls) {
      expect(names(c)).not.toContain(LIST_PROJECTS);
      expect(names(c)).not.toContain(READ_PROJECT);
    }
    // Setting off: the session tools are back to this project only — no scope.
    const offList = calls[3]!.tools.find((t) => t.name === LIST_SESSIONS)!;
    expect(JSON.stringify(offList)).not.toContain('scope');
  });

  it('a participant never gets them', () => {
    expect(PARTICIPANT_EXCLUDED_TOOLS.has(LIST_PROJECTS)).toBe(true);
    expect(PARTICIPANT_EXCLUDED_TOOLS.has(READ_PROJECT)).toBe(true);
  });

  it('a delegated run filters them out and the gate refuses a subagent (source)', () => {
    const src = readFileSync(join(__dirname, 'naby.ts'), 'utf8');
    expect(src).toMatch(/NABY_TURN_ONLY_TOOLS: readonly string\[\] = \[\.\.\.CROSS_SESSION_TOOL_NAMES, \.\.\.CROSS_PROJECT_TOOL_NAMES\]/);
    expect(src).toMatch(/!NABY_TURN_ONLY_TOOLS\.includes\(t\.name\)/);
    expect(src).toMatch(/call\.subagent && CROSS_PROJECT_TOOL_NAMES\.includes\(normalizeToolName\(call\.toolName\)\)/);
  });
});

describe('naby_read_project from naby’s turn (R11, R14, R17, R21)', () => {
  it('a same-group project waits on a card naming the group, then reads, labelled with its origin', async () => {
    const { sessionId } = getStore().createSession('', 'A', proposal);
    const calls: Call[] = [];
    const spec = createNabySpec({
      resolveModel: () =>
        scriptedModel(
          [{ tool: { id: 'r1', name: READ_PROJECT, input: { project: 'server', op: 'read_file', path: 'api.ts' } } }, { text: 'done' }],
          calls,
        ) as never,
    });
    const { ctx, events } = harness(sessionId, 'server API 봐 줘', proposal);
    const run = spec.runner.run(ctx);
    const card = await answerCard(events, 1, 'allow');
    await run;
    expect(card).toMatchObject({
      source: 'cross_project',
      tool_name: 'cross_project.access',
      input: { project: 'server', relation: 'same-group', group: 'RMS' },
    });
    const results = toolResults(events);
    expect(results).toContain('[from project \\"server\\"');
    expect(results).toContain('/v2/items');
  });

  it('a permanently allowed project reads with no card', async () => {
    const store = getStore();
    addCrossProjectApprovalPair(store, proposal, server);
    const { sessionId } = store.createSession('', 'A', proposal);
    const calls: Call[] = [];
    const spec = createNabySpec({
      resolveModel: () =>
        scriptedModel(
          [{ tool: { id: 'r3', name: READ_PROJECT, input: { project: 'server', op: 'read_file', path: 'api.ts' } } }, { text: 'done' }],
          calls,
        ) as never,
    });
    const { ctx, events } = harness(sessionId, 'server API 봐 줘', proposal);
    await spec.runner.run(ctx);
    expect(events.some((e) => e.type === 'approval_request')).toBe(false);
    expect(toolResults(events)).toContain('/v2/items');
  });

  it('an out-of-group project waits on the card, then reads', async () => {
    const { sessionId } = getStore().createSession('', 'A', proposal);
    const calls: Call[] = [];
    const spec = createNabySpec({
      resolveModel: () =>
        scriptedModel(
          [{ tool: { id: 'r2', name: READ_PROJECT, input: { project: 'other', op: 'read_file', path: 'notes.md' } } }, { text: 'done' }],
          calls,
        ) as never,
    });
    const { ctx, events } = harness(sessionId, 'other 프로젝트 노트 봐 줘', proposal);
    const run = spec.runner.run(ctx);
    let card: RunEvent | undefined;
    for (let i = 0; i < 400 && !card; i++) {
      card = events.find((e) => e.type === 'approval_request');
      if (!card) await new Promise((r) => setTimeout(r, 5));
    }
    expect(card).toMatchObject({ source: 'cross_project', tool_name: 'cross_project.access', input: { relation: 'other-group' } });
    resolveApproval((card as { approvalId: string }).approvalId, { behavior: 'allow' });
    await run;
    expect(toolResults(events)).toContain('other notes');
  });
});

describe('a request to another project’s tab (R7–R10)', () => {
  it('lists the group’s tabs, sends, and both legs run in their own folders with project names', async () => {
    const store = getStore();
    const a = store.createSession('', 'Plan', proposal).sessionId;
    const b = store.createSession('', 'API', server).sessionId;
    const dispatched: { sessionId: string; cwd?: string; prompt: string; meta: Record<string, unknown> }[] = [];
    let done!: () => void;
    const finished = new Promise<void>((r) => (done = r));
    const delivery = async (): Promise<CrossSessionDeps> => ({
      store,
      retryDelayMs: 0,
      pollMs: 0,
      log: () => {},
      hub: { isRunActive: () => false, getRunSnapshot: () => ({ events: [{ type: 'result', result: 'client must follow /v2' }] }), requestStop: () => true },
      dispatch: async (input) => {
        dispatched.push({ sessionId: input.sessionId, cwd: input.cwd, prompt: input.prompt, meta: input.crossSession });
        if (input.crossSession.role === 'reply') done();
        return { ok: true, runKey: input.sessionId };
      },
    });
    const calls: Call[] = [];
    const spec = createNabySpec({
      resolveModel: () =>
        scriptedModel(
          [
            { tool: { id: 'l1', name: LIST_SESSIONS, input: { scope: 'group' } } },
            { tool: { id: 's1', name: SEND, input: { sessionId: b, request: 'what changed in the API?' } } },
            { text: 'sent' },
          ],
          calls,
        ) as never,
      crossSessionDelivery: delivery,
    });
    const { ctx, events } = harness(a, 'server 탭에 물어봐 줘', proposal);
    const run = spec.runner.run(ctx);
    // 0.2.0: a same-group tab is asked about too.
    const card = await answerCard(events, 1, 'allow');
    await run;
    expect(card).toMatchObject({ input: { kind: 'send', sessionTitle: 'API', relation: 'same-group', group: 'RMS' } });
    const results = toolResults(events);
    expect(results).toContain(b);
    expect(results).toContain('[project \\"server\\"');
    expect(results).toContain('needsApproval');
    expect(results).toMatch(/request xs-/);
    await finished;
    expect(dispatched.map((d) => [d.sessionId, d.cwd, d.meta.role, d.meta.fromProject])).toEqual([
      [b, server, 'request', 'proposal'],
      [a, proposal, 'reply', 'server'],
    ]);
    expect(dispatched[0]!.prompt).toContain('of project "proposal"');
    expect(dispatched[1]!.prompt).toContain('of project "server"');
  });

  it('R7d: "2번" with no tab there opens a session in that project, runs the request through the engine and answers back', async () => {
    const store = getStore();
    store.setSetting(ORDER_KEY, JSON.stringify([proposal, server, other]));
    const a = store.createSession('', 'Plan', proposal).sessionId;
    expect(store.listSessionsByProject(server)).toEqual([]);
    // The sidebar's global-state viewers, as `src/lib/globalStateBroadcast.ts` pins them.
    const pushed: string[] = [];
    const g = globalThis as unknown as { __cockpitGlobalStateClients?: Set<unknown> };
    const before = g.__cockpitGlobalStateClients;
    g.__cockpitGlobalStateClients = new Set([{ readyState: 1, send: (d: string) => pushed.push(d) }]);
    try {
      // B's turn runs through the real engine adapter with its own scripted model.
      const bCalls: Call[] = [];
      const bSpec = createNabySpec({ resolveModel: () => scriptedModel([{ text: 'the API moved to /v2' }], bCalls) as never });
      const snaps = new Map<string, RunEvent[]>();
      const legs: { sessionId: string; cwd?: string; role: string; prompt: string }[] = [];
      let done!: () => void;
      const finished = new Promise<void>((r) => (done = r));
      const delivery = async (): Promise<CrossSessionDeps> => ({
        store,
        retryDelayMs: 0,
        pollMs: 0,
        log: () => {},
        hub: {
          isRunActive: () => false,
          getRunSnapshot: (k) => ({ events: snaps.get(k) ?? [] }),
          requestStop: () => true,
        },
        dispatch: async (input) => {
          legs.push({ sessionId: input.sessionId, cwd: input.cwd, role: input.crossSession.role, prompt: input.prompt });
          if (input.crossSession.role === 'reply') {
            done();
            return { ok: true, runKey: input.sessionId };
          }
          const h = harness(input.sessionId, input.prompt, input.cwd ?? '', {
            source: 'cross-session',
            crossSession: input.crossSession,
          });
          await bSpec.runner.run(h.ctx);
          snaps.set(input.sessionId, h.events);
          return { ok: true, runKey: input.sessionId };
        },
      });
      const calls: Call[] = [];
      const spec = createNabySpec({
        resolveModel: () =>
          scriptedModel(
            [{ tool: { id: 'p1', name: SEND, input: { project: '2', request: 'What changed in the API?\nList routes.' } } }, { text: 'sent' }],
            calls,
          ) as never,
        crossSessionDelivery: delivery,
      });
      const { ctx, events } = harness(a, '2번한테 물어봐 줘', proposal);
      const run = spec.runner.run(ctx);
      const card = await answerCard(events, 1, 'allow');
      await run;
      expect(card).toMatchObject({ input: { kind: 'send', newSession: true, project: 'server', number: 2, section: 'RMS' } });
      await finished;

      const opened = store.listSessionsByProject(server);
      expect(opened).toHaveLength(1);
      const b = opened[0]!;
      expect(b.title).toBe('What changed in the API?');
      expect(toolResults(events)).toContain('Opened a new conversation');
      expect(pushed.map((d) => JSON.parse(d))).toContainEqual({ type: 'project-state-changed', cwd: server, closedSessionIds: [] });
      expect(legs.map((l) => [l.sessionId, l.cwd, l.role])).toEqual([
        [b.sessionId, server, 'request'],
        [a, proposal, 'reply'],
      ]);
      // B ran as a request turn: the first message is the request, with its pill.
      const chat = toChatMessages(store.getMessages(b.sessionId) as RuntimeMessage[]);
      expect(chat[0]).toMatchObject({ systemEvent: { kind: 'cross-session', status: 'request', peerProject: 'proposal' } });
      // …and got no cross-project tools of its own (R16).
      expect(names(bCalls[0]!)).not.toContain(SEND);
      expect(legs[1]!.prompt).toContain('the API moved to /v2');
      expect(legs[1]!.prompt).toContain('of project "server"');
    } finally {
      g.__cockpitGlobalStateClients = before;
    }
  });

  it('the received request row names the sender project on its pill (R10)', async () => {
    const store = getStore();
    const b = store.createSession('', 'API', server).sessionId;
    const calls: Call[] = [];
    const spec = createNabySpec({ resolveModel: () => scriptedModel([{ text: 'ok' }], calls) as never });
    const meta = { requestId: 'xs-7', fromSessionId: 'A', fromTitle: 'Plan', role: 'request' as const, fromProject: 'proposal' };
    await spec.runner.run(harness(b, '[cross-session request] x', server, { source: 'cross-session', crossSession: meta }).ctx);
    const chat = toChatMessages(store.getMessages(b) as RuntimeMessage[]);
    expect(chat[0]).toMatchObject({
      role: 'system',
      systemEvent: { kind: 'cross-session', status: 'request', peer: 'Plan', peerProject: 'proposal' },
    });
  });

  it('with the setting off a send to another project is refused as before (R6)', async () => {
    const store = getStore();
    store.setSetting(CROSS_PROJECT_ENABLED_KEY, 'false');
    const a = store.createSession('', 'Plan', proposal).sessionId;
    const b = store.createSession('', 'API', server).sessionId;
    const calls: Call[] = [];
    const spec = createNabySpec({
      resolveModel: () =>
        scriptedModel([{ tool: { id: 's2', name: SEND, input: { sessionId: b, request: 'x' } } }, { text: 'no' }], calls) as never,
      crossSessionDelivery: async () => {
        throw new Error('must not deliver');
      },
    });
    const { ctx, events } = harness(a, 'send', proposal);
    await spec.runner.run(ctx);
    expect(toolResults(events)).toContain('belongs to another project');
  });
});

describe('the group awareness paragraph (R2, R26)', () => {
  const PARA = 'This project is in the sidebar group ‹RMS›, numbered as in the sidebar: ';

  it('naby’s main turn in a grouped project carries it — names and cwds in sidebar-number order, no content (§3a)', async () => {
    const store = getStore();
    // A third member, named so that it sorts BEFORE "server" by name — but the
    // sidebar order the list save recorded puts it last. The turn itself
    // touches its project's last-opened stamp; the numbers must not follow it.
    store.setSetting(
      GROUPS_KEY,
      JSON.stringify({ groups: [{ id: 'g_rms', name: 'RMS', collapsed: false, cwds: [proposal, server, other] }] }),
    );
    store.setSetting(ORDER_KEY, JSON.stringify([server, proposal, other]));
    const { sessionId } = store.createSession('', 'A', proposal);
    const calls: Call[] = [];
    const spec = createNabySpec({ resolveModel: () => scriptedModel([{ text: 'hi' }], calls) as never });
    await spec.runner.run(harness(sessionId, 'hello', proposal).ctx);
    const sys = calls[0]!.system;
    expect(sys).toContain(`${PARA}1 ‹server› (${server}), 2 ‹proposal› (this project), 3 ‹other› (${other}).`);
    expect(sys).toContain('"N번" (number N) means that number in this group');
    expect(sys).toContain('the user is asked to approve unless they already allowed it permanently. Do not guess their contents.');
    expect(sys).not.toContain(`‹proposal› (${proposal})`);
    // Reordering the sidebar reorders the paragraph (R32: computed, not stored).
    store.setSetting(ORDER_KEY, JSON.stringify([other, server, proposal]));
    await spec.runner.run(harness(sessionId, 'again', proposal).ctx);
    expect(calls[1]!.system).toContain(`${PARA}1 ‹other› (${other}), 2 ‹server› (${server}), 3 ‹proposal› (this project).`);
    expect(sys).not.toContain('/v2/items');
    expect(sys).not.toContain('other notes');
  });

  it('absent for a project in no group, or alone in its group', async () => {
    const store = getStore();
    const calls: Call[] = [];
    const spec = createNabySpec({ resolveModel: () => scriptedModel([{ text: 'hi' }], calls) as never });
    await spec.runner.run(harness(store.createSession('', 'o', other).sessionId, 'hello', other).ctx);
    store.setSetting(GROUPS_KEY, JSON.stringify({ groups: [{ id: 'g', name: 'Solo', collapsed: false, cwds: [proposal] }] }));
    await spec.runner.run(harness(store.createSession('', 'p', proposal).sessionId, 'hello', proposal).ctx);
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(c.system).not.toContain('This project is in the sidebar group');
  });

  it('absent on R16-excluded turns and with the setting off', async () => {
    const store = getStore();
    const calls: Call[] = [];
    const spec = createNabySpec({ resolveModel: () => scriptedModel([{ text: 'ok' }], calls) as never });
    await spec.runner.run(harness(store.createSession('', 's', proposal).sessionId, 'daily', proposal, { source: 'scheduled' }).ctx);
    await spec.runner.run(harness(store.createSession('', 'j', proposal).sessionId, 'job done', proposal, { source: 'job-report' }).ctx);
    const meta = { requestId: 'xs-9', fromSessionId: 'A', fromTitle: 'Plan', role: 'request' as const, fromProject: 'server' };
    await spec.runner.run(
      harness(store.createSession('', 'b', proposal).sessionId, '[cross-session request] x', proposal, {
        source: 'cross-session',
        crossSession: meta,
      }).ctx,
    );
    store.setSetting(CROSS_PROJECT_ENABLED_KEY, 'false');
    await spec.runner.run(harness(store.createSession('', 'off', proposal).sessionId, 'hello', proposal).ctx);
    expect(calls).toHaveLength(4);
    for (const c of calls) expect(c.system).not.toContain('This project is in the sidebar group');
  });

  it('rides the shared system prompt both engines receive, beside the tools it names (source)', () => {
    const src = readFileSync(join(__dirname, 'naby.ts'), 'utf8');
    // Built only when the cross-project guard exists (R16 + R6 are its condition)…
    expect(src).toMatch(/const crossProjectGroupNote = \(\(\) => \{\s*if \(!crossProjectGuard \|\| !projectCwd\) return undefined;/);
    // …and placed in `turnSystem`, the one system string handed to either engine.
    const turnSystem = src.slice(src.indexOf('const turnSystem ='), src.indexOf('.filter(Boolean)', src.indexOf('const turnSystem =')));
    expect(turnSystem).toContain('crossProjectGroupNote,');
  });
});
