import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildZip,
  DEFAULT_USER_ID,
  mcpOAuthSettingKey,
  nabyHomeDir,
  ON_DEMAND_LISTING_HEADER,
  ORG_HARNESS_SCOPE_KEY,
  type HarnessItem,
} from '../../../../../../../dist/naby-runtime.mjs';
import { runNabyAction } from '../api/naby';
import { resetOrgHarnessBootForTests, setOrgHarnessFetch } from '../lib/orgHarness';
import { SKILL_HUB_SERVER_NAME } from '../lib/systemMcp';
import { createNabySpec, getStore } from './naby';
import type { RunCtx, RunEvent } from './types';

/**
 * THE ORG HARNESS INSIDE A REAL TURN (specs/org-harness-sync.md M2, §3.3–§3.4,
 * §4.5, §4.8).
 *
 * The rules are proven in `npm run spike:org-harness-load`. What is tested HERE is
 * the wiring only a turn through the production `createNabySpec` can show: that
 * the listing and the preload reach the MODEL's system prompt, that
 * `naby_skill_load` is in the model's tool list exactly when the org harness is
 * on and a shell exists, that `/task start …` at the head of a line preloads the
 * body instead of expanding to the description stub, and that a new session is
 * told about a same-name copy once.
 *
 * NO NETWORK: a fake Skill Hub through `setOrgHarnessFetch`, a hand-rolled model
 * (see handoffInjection.test.ts for why it is hand-rolled), and the throwaway
 * NABY_HOME from vitest.setup.ts.
 */

const HUB_KEY = 'shub_orgTurnTestKeyDoNotLeak';
const TASK_BODY = '# task\n\nRun `python3 ${CLAUDE_SKILL_DIR}/scripts/task.py start`.';
const skill = (name: string, description: string, body: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

function installHub(version: string): void {
  const zip = buildZip([
    { name: '.claude-plugin/plugin.json', data: JSON.stringify({ name: 'altimedia-harness', version }) },
    { name: 'skills/task/SKILL.md', data: skill('task', 'Open and close a task.', TASK_BODY) },
    { name: 'skills/pdoc/SKILL.md', data: skill('pdoc', 'Project documents.', '# pdoc\n\nDocs.') },
    { name: 'skills/task/scripts/task.py', data: 'print("task")\n' },
  ]);
  setOrgHarnessFetch(async (url) => {
    const respond = (status: number, body: unknown, bytes?: Buffer) => ({
      status,
      json: async () => body,
      arrayBuffer: async () => {
        const b = bytes ?? Buffer.alloc(0);
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
      },
    });
    if (url.endsWith('/api/v1/marketplace.json')) {
      return respond(200, {
        plugins: [
          {
            name: 'altimedia-harness',
            version,
            source: {
              url: '/api/v1/plugins/altimedia-harness/download',
              sha256: createHash('sha256').update(zip).digest('hex'),
            },
          },
        ],
      });
    }
    if (url.endsWith('/download')) return respond(200, null, zip);
    if (url.endsWith('/harness/bootstrap')) return respond(200, { env: { HARNESS_METRICS_TOKEN: 'hmt_x' } });
    return respond(404, null);
  });
}

const orgRows = (): HarnessItem[] => getStore().listHarness('org', ORG_HARNESS_SCOPE_KEY, { kind: 'skill' });

function clear(): void {
  const store = getStore();
  store.removeMcpEntry(SKILL_HUB_SERVER_NAME);
  for (const row of orgRows()) store.removeHarness({ id: row.id });
  for (const row of store.listHarness('user', DEFAULT_USER_ID, { kind: 'skill' })) {
    if (['task', 'pdoc'].includes(row.name)) store.removeHarness({ id: row.id });
  }
  for (const key of Object.keys(store.listSettings())) {
    if (key.startsWith('harness.org.')) store.setSetting(key, '');
  }
  store.setSetting(mcpOAuthSettingKey('atlassian'), '');
  rmSync(join(nabyHomeDir(), 'org'), { recursive: true, force: true });
  setOrgHarnessFetch(undefined);
  resetOrgHarnessBootForTests();
}

async function installOrgHarness(): Promise<void> {
  const saved = await runNabyAction({ action: 'systemMcp.set', preset: SKILL_HUB_SERVER_NAME, fields: { token: HUB_KEY } });
  expect(saved.ok).toBe(true);
  // The skill-hub preset is ALSO an MCP server, and a turn connects every MCP
  // entry. Keep the token (it is what the org harness reads) but point the entry
  // at a refused loopback port, so the turn never reaches the real Skill Hub.
  const store = getStore();
  const entry = store.listMcpEntries().find((e) => e.name === SKILL_HUB_SERVER_NAME)!;
  if (entry.transport === 'stdio') throw new Error('skill-hub preset is expected to be http');
  store.upsertMcpEntry({ ...entry, url: 'http://127.0.0.1:9/mcp' });
  installHub('0.7.1');
  const synced = await runNabyAction({ action: 'orgHarness.sync' });
  expect(synced.ok).toBe(true);
  expect(orgRows()).toHaveLength(2);
}

type Seen = { system?: string; tools?: string[] };

function recordingModel(seen: Seen) {
  return {
    specificationVersion: 'v4' as const,
    provider: 'mock',
    modelId: 'claude-sonnet-4-5',
    supportedUrls: {},
    async doGenerate(options: { prompt: unknown; tools?: { name: string }[] }) {
      const prompt = options.prompt as { role: string; content: unknown }[];
      const system = prompt.find((m) => m.role === 'system');
      if (system && typeof system.content === 'string') seen.system = system.content;
      seen.tools = (options.tools ?? []).map((t) => t.name);
      return {
        content: [{ type: 'text' as const, text: 'ok.' }],
        finishReason: { unified: 'stop' as const, raw: 'end_turn' },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [] as never[],
      };
    },
    async doStream() {
      throw new Error('not used');
    },
  };
}

const PROJECT = join(nabyHomeDir(), 'org-turn-project');

async function turn(
  prompt: string,
  opts: { cwd?: string; sessionId?: string } = {},
): Promise<{ seen: Seen; events: RunEvent[] }> {
  const events: RunEvent[] = [];
  const seen: Seen = {};
  let key = opts.sessionId ?? '';
  const ctx: RunCtx = {
    prompt,
    images: undefined,
    cwd: opts.cwd ?? '',
    sessionId: opts.sessionId,
    params: { prompt, engine: 'naby', model: 'claude-sonnet-4-5' },
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
  const spec = createNabySpec({ resolveModel: () => recordingModel(seen) as never });
  await spec.runner.run(ctx);
  return { seen, events };
}

const orgPills = (events: RunEvent[]) =>
  events
    .filter((e) => e.type === 'system' && (e as { harness_subtype?: string }).harness_subtype === 'org-harness')
    .map((e) => (e as { harness_detail?: string }).harness_detail);

beforeEach(() => {
  clear();
  mkdirSync(PROJECT, { recursive: true });
  // M3 (§3.6): with the org harness on, a prompt needs the Atlassian sign-in. These
  // M2 tests are about the turn itself, so the gate is switched off the plugin's
  // way (`HARNESS_GATE=0`) — the gate has its own tests (nabyOrgHarnessM3.test.ts).
  process.env.HARNESS_GATE = '0';
});
afterAll(() => {
  clear();
  delete process.env.HARNESS_GATE;
});

describe('org harness in a turn — listing and naby_skill_load (§3.3)', () => {
  it('lists the org skills (not their bodies) and offers naby_skill_load when a project is open', async () => {
    await installOrgHarness();
    const { seen } = await turn('hello', { cwd: PROJECT });
    expect(seen.system).toContain(ON_DEMAND_LISTING_HEADER);
    expect(seen.system).toContain('- task: Open and close a task.');
    expect(seen.system).not.toContain('# task');
    expect(seen.tools).toContain('naby_skill_load');
    expect(seen.tools).toContain('run_command');
  });

  it('`/task start …` at the head of a line preloads the body, with the skill folder substituted', async () => {
    await installOrgHarness();
    const { seen } = await turn('/task start 회의록', { cwd: PROJECT });
    const taskDir = join(nabyHomeDir(), 'org', 'altimedia-harness', '0.7.1', 'skills', 'task');
    expect(seen.system).toContain('Skill "task" was named in this turn');
    expect(seen.system).toContain(`python3 ${taskDir}/scripts/task.py start`);
    expect(seen.system).toContain(`Skill folder: ${taskDir}`);
  });

  it('a turn with no project (no shell) lists nothing and offers no loader', async () => {
    await installOrgHarness();
    const { seen } = await turn('/task start', {});
    expect(seen.system ?? '').not.toContain(ON_DEMAND_LISTING_HEADER);
    expect(seen.system ?? '').not.toContain('Skill "task" was named');
    expect(seen.tools ?? []).not.toContain('naby_skill_load');
  });

  it('the kill switch hides the listing and the loader (§4.8)', async () => {
    await installOrgHarness();
    const off = await runNabyAction({ action: 'orgHarness.set', enabled: false });
    expect(off.ok).toBe(true);
    const { seen } = await turn('/task start', { cwd: PROJECT });
    expect(seen.system ?? '').not.toContain(ON_DEMAND_LISTING_HEADER);
    expect(seen.tools ?? []).not.toContain('naby_skill_load');
  });

  it('with no skill-hub key nothing about the turn changes', async () => {
    const { seen } = await turn('hello', { cwd: PROJECT });
    expect(seen.system ?? '').not.toContain(ON_DEMAND_LISTING_HEADER);
    expect(seen.tools ?? []).not.toContain('naby_skill_load');
  });
});

describe('org harness in a turn — same-name copy notice once at session start (§4.5)', () => {
  it('a new session gets the pill; a resumed one does not', async () => {
    await installOrgHarness();
    getStore().putHarnessItem({
      item: {
        scope: 'user',
        scopeKey: DEFAULT_USER_ID,
        kind: 'skill',
        name: 'task',
        provenance: { source: 'external', origin: join(nabyHomeDir(), 'skills', 'task', 'SKILL.md'), format: 'claude-skill-md' },
        skill: { instructions: 'my own task body' },
      },
      requestedStatus: 'enabled',
      autoEnable: true,
    });
    const first = await turn('hello', { cwd: PROJECT });
    expect(orgPills(first.events)).toEqual(['copy-notice:task:edited']);
    // The copy shadows the org listing entry for `task`; pdoc is still listed.
    expect(first.seen.system).not.toContain('- task: Open and close a task.');
    expect(first.seen.system).toContain('- pdoc: Project documents.');

    const sessionId = first.events.find((e) => e.type === 'system' && (e as { subtype?: string }).subtype === 'init')
      ?.session_id as string;
    const resumed = await turn('again', { cwd: PROJECT, sessionId });
    expect(orgPills(resumed.events)).toEqual([]);
  });
});

describe('org harness in a turn — wiring the spike cannot see', () => {
  const SRC = readFileSync(join(__dirname, 'naby.ts'), 'utf8');

  it('pins the org harness ONCE, before the toolset and the gate read it (§4.7)', () => {
    const pins = [...SRC.matchAll(/pinOrgHarnessForTurn\(/g)];
    expect(pins).toHaveLength(1);
    const pinAt = pins[0]!.index!;
    expect(SRC.indexOf('readRoots: orgReadRoots(orgTurn)')).toBeGreaterThan(pinAt);
    expect(SRC.indexOf('commandEnv: (command, cwd) => orgCommandEnv(orgTurn, command, cwd)')).toBeGreaterThan(pinAt);
    expect(SRC.indexOf('loadBody: orgSkillPreloader(orgTurn)')).toBeGreaterThan(pinAt);
  });

  it('the gate write-protects <NABY_HOME>/org on every turn, both engines', () => {
    expect(SRC).toContain('writeProtectedRoots: [orgHarnessProtectedRoot(orgTurn.home)]');
  });

  it('on dev-claude, run_command counts as available only where Bash is usable', () => {
    expect(SRC).toContain("const sdkShellUsable = engineId === 'dev-claude' && !!projectCwd && allowChanges && !planMode;");
    expect(SRC).toContain("...(sdkShellUsable && !runtimeToolNames.includes('run_command') ? ['run_command'] : []),");
    expect(SRC).toContain('const orgLoad = orgListed && turnHasShell ? makeOrgSkillLoadTool(orgTurn) : undefined;');
  });
});
