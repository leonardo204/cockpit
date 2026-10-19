import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNabySpec, getStore } from './naby';
import {
  CROSS_SESSION_ENABLED_KEY,
  resetCrossSessionRegistry,
  type CrossSessionDeps,
} from '../lib/crossSession';
import { PARTICIPANT_EXCLUDED_TOOLS } from '../lib/participantTurn';
import { toChatMessages } from '../api/session/toChatMessages';
import type { RuntimeMessage } from '../../../../../../../dist/naby-runtime.mjs';
import type { RunCtx, RunEvent } from './types';

/**
 * SESSIONS ASKING EACH OTHER, WIRED (cross-session-messaging §3.1, R7, R10) —
 * through the production `createNabySpec` with a scripted model: which turns are
 * offered the two tools, that a turn another session started stores its user row
 * labelled and has no send tool, and that a send from naby's turn returns a
 * request id and hands the request to the delivery (a stub here — no second
 * turn, no model). The store is the throwaway one vitest.setup.ts points at.
 */

const LIST = 'naby_list_sessions';
const SEND = 'naby_send_to_session';

type Call = { tools: string[] };
type Step = { tool?: { id: string; name: string; input: Record<string, unknown> }; text?: string };

function scriptedModel(steps: Step[], calls: Call[]) {
  let i = 0;
  return {
    specificationVersion: 'v4' as const,
    provider: 'mock',
    modelId: 'claude-sonnet-4-5',
    supportedUrls: {},
    async doGenerate(options: { prompt: unknown; tools?: { name: string }[] }) {
      calls.push({ tools: (options.tools ?? []).map((t) => t.name) });
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

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'naby-cross-session-engine-'));
  resetCrossSessionRegistry();
});
afterEach(() => {
  getStore().setSetting(CROSS_SESSION_ENABLED_KEY, '');
});

describe('cross-session tools — which turns get them', () => {
  it('naby’s own turn in a project has both', async () => {
    const { sessionId } = getStore().createSession('', 'A', cwd);
    const calls: Call[] = [];
    const spec = createNabySpec({ resolveModel: () => scriptedModel([{ text: 'hi' }], calls) as never });
    await spec.runner.run(harness(sessionId, 'hello', cwd).ctx);
    expect(calls[0]!.tools).toEqual(expect.arrayContaining([LIST, SEND]));
  });

  it('none without a project, none on a scheduled turn, none with the setting off (R10)', async () => {
    const store = getStore();
    const calls: Call[] = [];
    const spec = createNabySpec({ resolveModel: () => scriptedModel([{ text: 'ok' }], calls) as never });

    const noProject = store.createSession('', 'np').sessionId;
    await spec.runner.run(harness(noProject, 'hello', '').ctx);
    const scheduled = store.createSession('', 'sch', cwd).sessionId;
    await spec.runner.run(harness(scheduled, 'daily', cwd, { source: 'scheduled' }).ctx);
    store.setSetting(CROSS_SESSION_ENABLED_KEY, 'false');
    const off = store.createSession('', 'off', cwd).sessionId;
    await spec.runner.run(harness(off, 'hello', cwd).ctx);

    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c.tools).not.toContain(LIST);
      expect(c.tools).not.toContain(SEND);
    }
  });

  it('a turn another session started has no send tool and stores a labelled user row (R7, §3.3)', async () => {
    const store = getStore();
    const { sessionId } = store.createSession('', 'B', cwd);
    const calls: Call[] = [];
    const spec = createNabySpec({ resolveModel: () => scriptedModel([{ text: 'found it' }], calls) as never });
    const meta = { requestId: 'xs-9', fromSessionId: 'A', fromTitle: 'Research', role: 'request' as const };
    await spec.runner.run(
      harness(sessionId, '[cross-session request] search X', cwd, { source: 'cross-session', crossSession: meta }).ctx,
    );
    expect(calls[0]!.tools).not.toContain(SEND);
    expect(calls[0]!.tools).not.toContain(LIST);
    const rows = store.getMessages(sessionId) as RuntimeMessage[];
    const user = rows.find((m) => m.role === 'user') as Extract<RuntimeMessage, { role: 'user' | 'assistant' }>;
    expect(user.crossSession).toEqual(meta);
    const chat = toChatMessages(rows);
    expect(chat[0]).toMatchObject({ role: 'system', systemEvent: { kind: 'cross-session', status: 'request', peer: 'Research' } });
  });

  it('a participant never gets them, whatever its toolRefs say', () => {
    expect(PARTICIPANT_EXCLUDED_TOOLS.has(LIST)).toBe(true);
    expect(PARTICIPANT_EXCLUDED_TOOLS.has(SEND)).toBe(true);
  });
});

describe('cross-session send — from naby’s turn to the delivery', () => {
  it('returns a request id at once and hands B the request', async () => {
    const store = getStore();
    const a = store.createSession('', 'Research', cwd).sessionId;
    const b = store.createSession('', 'Search', cwd).sessionId;
    const dispatched: { sessionId: string; role: string }[] = [];
    let done!: () => void;
    const finished = new Promise<void>((r) => (done = r));
    const delivery = async (): Promise<CrossSessionDeps> => ({
      store,
      retryDelayMs: 0,
      pollMs: 0,
      log: () => {},
      hub: { isRunActive: () => false, getRunSnapshot: () => ({ events: [{ type: 'result', result: 'X is 42' }] }), requestStop: () => true },
      dispatch: async (input) => {
        dispatched.push({ sessionId: input.sessionId, role: input.crossSession.role });
        if (input.crossSession.role === 'reply') done();
        return { ok: true, runKey: input.sessionId };
      },
    });
    const calls: Call[] = [];
    const spec = createNabySpec({
      resolveModel: () =>
        scriptedModel(
          [{ tool: { id: 'c1', name: SEND, input: { sessionId: b, request: 'search X' } } }, { text: 'sent' }],
          calls,
        ) as never,
      crossSessionDelivery: delivery,
    });
    const { ctx, events } = harness(a, '2번 탭에 X 검색 맡겨 줘', cwd);
    await spec.runner.run(ctx);
    const toolResult = JSON.stringify(events.filter((e) => e.type === 'user'));
    expect(toolResult).toMatch(/request xs-/);
    await finished;
    expect(dispatched).toEqual([
      { sessionId: b, role: 'request' },
      { sessionId: a, role: 'reply' },
    ]);
  });
});
