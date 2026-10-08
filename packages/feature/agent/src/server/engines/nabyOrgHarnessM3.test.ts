import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  buildZip,
  mcpOAuthSettingKey,
  nabyHomeDir,
  ORG_HARNESS_SCOPE_KEY,
  type ZipWriteEntry,
} from '../../../../../../../dist/naby-runtime.mjs';
import { resolveApproval } from '../lib/approvalRegistry';
import { resetOrgHarnessBootForTests, setOrgHarnessFetch, syncOrgHarnessNow } from '../lib/orgHarness';
import { orgHooksIdle, resetOrgHookStateForTests } from '../lib/orgHarnessHooks';
import { SKILL_HUB_SERVER_NAME } from '../lib/systemMcp';
import { createNabySpec, getStore } from './naby';
import type { RunCtx, RunEvent } from './types';

/**
 * THE ORG HARNESS M3 INSIDE A REAL TURN (specs/org-harness-sync.md §3.5, §3.6,
 * §4.6) — the wiring only `createNabySpec` can show:
 *
 *   * the Atlassian gate blocks a prompt BEFORE anything else happens: an
 *     `atlassian-required` pill, an error result, no model call, no session;
 *   * during the grace a new session runs and is told how many days are left;
 *   * a PreToolUse hook's `ask` reaches the approval prompt with its reason and
 *     `source: 'hook'`, and the call runs once the user allows it.
 *
 * The rules themselves are proven in `spike:org-harness-gate` and
 * `spike:org-harness-hooks`. NO NETWORK: a fake Skill Hub serving the fixture
 * package (whose stand-in hook scripts record into a temp file) and a hand-rolled
 * model.
 */

const FIXTURE = join(__dirname, '../../../../../../../src/spikes/fixtures/org-harness/altimedia-harness');
const HOOK_LOG = join(nabyHomeDir(), 'm3-hooks.jsonl');
const HOOK_CONTROL = join(nabyHomeDir(), 'm3-control.json');
const PROJECT = join(nabyHomeDir(), 'm3-project');

function fixtureZip(): Buffer {
  const out: ZipWriteEntry[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push({ name: relative(FIXTURE, full).split('\\').join('/'), data: readFileSync(full) });
    }
  };
  walk(FIXTURE);
  return buildZip(out);
}

async function installOrgHarness(): Promise<void> {
  const zip = fixtureZip();
  const sha = createHash('sha256').update(zip).digest('hex');
  setOrgHarnessFetch(async (url) => {
    const respond = (status: number, body: unknown, bytes?: Buffer) => ({
      status,
      json: async () => body,
      arrayBuffer: async () => {
        const b = bytes ?? Buffer.alloc(0);
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
      },
    });
    if (url.endsWith('/marketplace.json')) {
      return respond(200, { plugins: [{ name: 'altimedia-harness', version: '0.7.1', source: { url: '/dl', sha256: sha } }] });
    }
    if (url.endsWith('/dl')) return respond(200, null, zip);
    if (url.endsWith('/harness/bootstrap')) return respond(200, { env: { HARNESS_METRICS_TOKEN: 'hmt_m3' } });
    return respond(404, null);
  });
  getStore().upsertMcpEntry({
    name: SKILL_HUB_SERVER_NAME,
    transport: 'http',
    url: 'http://127.0.0.1:9/mcp',
    headers: { Authorization: 'Bearer shub_m3_key' },
    status: 'enabled',
  });
  await syncOrgHarnessNow(getStore(), { applyNow: true });
}

function clear(): void {
  const store = getStore();
  store.removeMcpEntry(SKILL_HUB_SERVER_NAME);
  for (const row of store.listHarness('org', ORG_HARNESS_SCOPE_KEY, { kind: 'skill' })) store.removeHarness({ id: row.id });
  for (const key of Object.keys(store.listSettings())) {
    if (key.startsWith('harness.org.')) store.setSetting(key, '');
  }
  store.setSetting(mcpOAuthSettingKey('atlassian'), '');
  rmSync(join(nabyHomeDir(), 'org'), { recursive: true, force: true });
  setOrgHarnessFetch(undefined);
  resetOrgHarnessBootForTests();
  resetOrgHookStateForTests();
}

type Step = { tool?: { id: string; name: string; input: Record<string, unknown> }; text?: string };

function scriptedModel(steps: Step[], calls: { prompt: unknown }[]) {
  let i = 0;
  return {
    specificationVersion: 'v4' as const,
    provider: 'mock',
    modelId: 'mock-m3',
    supportedUrls: {},
    async doGenerate(options: { prompt: unknown }) {
      calls.push({ prompt: options.prompt });
      const step = steps[Math.min(i, steps.length - 1)]!;
      i += 1;
      const usage = {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      };
      if (step.tool) {
        return {
          content: [{ type: 'tool-call' as const, toolCallId: step.tool.id, toolName: step.tool.name, input: JSON.stringify(step.tool.input) }],
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

async function turn(
  prompt: string,
  steps: Step[],
  opts: { sessionId?: string; onEvent?: (e: RunEvent) => void } = {},
): Promise<{ events: RunEvent[]; calls: { prompt: unknown }[] }> {
  const events: RunEvent[] = [];
  const calls: { prompt: unknown }[] = [];
  let key = opts.sessionId ?? '';
  const ctx: RunCtx = {
    prompt,
    images: undefined,
    cwd: PROJECT,
    sessionId: opts.sessionId,
    params: { prompt, engine: 'naby', model: 'mock-m3' },
    signal: new AbortController().signal,
    emit(event: RunEvent) {
      events.push(event);
      opts.onEvent?.(event);
    },
    rekey(id: string) {
      key = id;
    },
    currentKey() {
      return key;
    },
  };
  await createNabySpec({ resolveModel: () => scriptedModel(steps, calls) as never }).runner.run(ctx);
  return { events, calls };
}

const orgPills = (events: RunEvent[]) =>
  events
    .filter((e) => e.type === 'system' && (e as { harness_subtype?: string }).harness_subtype === 'org-harness')
    .map((e) => String((e as { harness_detail?: string }).harness_detail));

beforeEach(async () => {
  clear();
  mkdirSync(PROJECT, { recursive: true });
  delete process.env.HARNESS_GATE;
  process.env.NABY_SPIKE_HOOK_LOG = HOOK_LOG;
  process.env.NABY_SPIKE_HOOK_CONTROL = HOOK_CONTROL;
  writeFileSync(HOOK_LOG, '');
  writeFileSync(HOOK_CONTROL, '{}');
  await installOrgHarness();
});
afterAll(() => {
  clear();
  delete process.env.NABY_SPIKE_HOOK_LOG;
  delete process.env.NABY_SPIKE_HOOK_CONTROL;
});

describe('the Atlassian gate in a turn (§3.6, §4.6)', () => {
  it('blocks a prompt with no sign-in: pill + error result, no model call, no session', async () => {
    // A fresh install: blocking starts the moment the gate arms.
    const store = getStore();
    store.setSetting('harness.org.gateGraceKind', 'new');
    store.setSetting('harness.org.gateGraceStartedAt', String(Date.now() - 1000));
    const before = store.listSessions().length;
    const { events, calls } = await turn('hello', [{ text: 'should not answer' }]);
    expect(orgPills(events).some((p) => p.startsWith('atlassian-required'))).toBe(true);
    const result = events.find((e) => e.type === 'result') as { is_error?: boolean } | undefined;
    expect(result?.is_error).toBe(true);
    expect(calls).toHaveLength(0);
    expect(store.listSessions().length).toBe(before);
    expect(events.some((e) => e.type === 'system' && (e as { subtype?: string }).subtype === 'init')).toBe(false);
  });

  it('during the grace a new session runs and is told the days left', async () => {
    const store = getStore();
    store.setSetting('harness.org.gateGraceKind', 'upgrade');
    store.setSetting('harness.org.gateGraceStartedAt', String(Date.now() - 2 * 24 * 60 * 60 * 1000));
    const { events, calls } = await turn('hello', [{ text: 'hi.' }]);
    expect(calls).toHaveLength(1);
    expect(orgPills(events)).toContain('atlassian-grace:5');
  });

  it('HARNESS_GATE=0 turns the gate off, the plugin way', async () => {
    const store = getStore();
    store.setSetting('harness.org.gateGraceKind', 'new');
    store.setSetting('harness.org.gateGraceStartedAt', String(Date.now() - 1000));
    process.env.HARNESS_GATE = '0';
    const { calls } = await turn('hello', [{ text: 'hi.' }]);
    expect(calls).toHaveLength(1);
  });
});

describe('a PreToolUse hook that asks (§3.5)', () => {
  it('reaches the approval prompt with its reason, marked as a hook; allowed, the call runs', async () => {
    process.env.HARNESS_GATE = '0';
    writeFileSync(
      HOOK_CONTROL,
      JSON.stringify({
        'pre-commit.py': {
          stdout: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'commit check' } },
        },
      }),
    );
    const approvals: Record<string, unknown>[] = [];
    const { events } = await turn(
      'run it',
      [{ tool: { id: 'c1', name: 'run_command', input: { command: 'echo m3-ok' } } }, { text: 'done.' }],
      {
        onEvent: (e) => {
          if (e.type !== 'approval_request') return;
          approvals.push(e as Record<string, unknown>);
          setTimeout(() => resolveApproval(String((e as unknown as { approvalId: string }).approvalId), { behavior: 'allow' }), 5);
        },
      },
    );
    await orgHooksIdle(8000);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ reason: 'commit check', source: 'hook', tool_name: 'run_command' });
    expect(String(approvals[0]!.approvalId)).toMatch(/:hook$/);
    const resultRow = events.find(
      (e) => e.type === 'user' && JSON.stringify(e).includes('m3-ok'),
    );
    expect(resultRow).toBeDefined();
    // The hook saw Claude Code's spelling.
    const log = existsSync(HOOK_LOG) ? readFileSync(HOOK_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    const pre = log.find((l: { input?: { hook_event_name?: string } }) => l.input?.hook_event_name === 'PreToolUse');
    expect(pre?.input?.tool_name).toBe('Bash');
    expect(log.some((l: { forbidden?: boolean }) => l.forbidden)).toBe(false);
  });

  it('denied, the call does not run and the turn still ends', async () => {
    process.env.HARNESS_GATE = '0';
    writeFileSync(
      HOOK_CONTROL,
      JSON.stringify({
        'pre-commit.py': {
          stdout: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'commit check' } },
        },
      }),
    );
    const { events } = await turn(
      'run it',
      [{ tool: { id: 'c2', name: 'run_command', input: { command: 'echo m3-never' } } }, { text: 'ok, not run.' }],
      {
        onEvent: (e) => {
          if (e.type !== 'approval_request') return;
          setTimeout(
            () => resolveApproval(String((e as unknown as { approvalId: string }).approvalId), { behavior: 'deny', reason: 'no' }),
            5,
          );
        },
      },
    );
    expect(events.some((e) => e.type === 'user' && JSON.stringify(e).includes('m3-never') && !JSON.stringify(e).includes('Denied'))).toBe(false);
    const result = events.find((e) => e.type === 'result') as { subtype?: string } | undefined;
    expect(result?.subtype).toBe('success');
  });
});
