import { describe, it, expect } from 'vitest';
import { DEFAULT_USER_ID, type HarnessItem } from '../../../../../../../dist/naby-runtime.mjs';
import { listCommands, mergeCommands, type CommandInfo } from './commands';

function ownedCommand(over: Partial<HarnessItem> & { name: string }): HarnessItem {
  return {
    id: `id-${over.name}`,
    scope: 'user',
    scopeKey: DEFAULT_USER_ID,
    kind: 'command',
    status: 'enabled',
    provenance: { source: 'user' },
    command: { template: `body-${over.name}` },
    createdAt: 1,
    updatedAt: 1,
    ...over,
  } as HarnessItem;
}

function ownedSkill(over: Partial<HarnessItem> & { name: string }): HarnessItem {
  return {
    id: `id-${over.name}`,
    scope: 'user',
    scopeKey: DEFAULT_USER_ID,
    kind: 'skill',
    status: 'enabled',
    provenance: { source: 'user' },
    skill: { instructions: `skill-${over.name}` },
    createdAt: 1,
    updatedAt: 1,
    ...over,
  } as HarnessItem;
}

function ownedSubagent(over: Partial<HarnessItem> & { name: string }): HarnessItem {
  return {
    id: `id-${over.name}`,
    scope: 'user',
    scopeKey: DEFAULT_USER_ID,
    kind: 'subagent',
    status: 'enabled',
    provenance: { source: 'user' },
    subagent: { systemPrompt: `persona-${over.name}` },
    createdAt: 1,
    updatedAt: 1,
    ...over,
  } as HarnessItem;
}

describe('mergeCommands', () => {
  it('lists a registered command, badged by scope', () => {
    const out = mergeCommands([ownedCommand({ name: 'ship' })]);
    expect(out.map((c) => c.name)).toEqual(['/ship']);
    expect(out[0].source).toBe('user');
  });

  it('offers nothing when the harness is empty — there are no builtins to fall back on', () => {
    expect(mergeCommands([])).toEqual([]);
  });

  it('a project-scope owned command overrides a user-scope one of the same verb', () => {
    // input order is user-first, project-second (as loadOwnedCommands returns)
    const out = mergeCommands([
      ownedCommand({ name: 'dup', scope: 'user', description: 'user dup' }),
      ownedCommand({ name: 'dup', scope: 'project', scopeKey: '/w', description: 'project dup' }),
    ]);
    const dup = out.find((c) => c.name === '/dup')!;
    expect(dup.source).toBe('project');
    expect(dup.description).toBe('project dup');
  });

  it('badges an org-scope owned command as "org" (HP-08 inheritance)', () => {
    const out = mergeCommands([
      ownedCommand({ name: 'onboard', scope: 'org', scopeKey: 'default', description: 'team onboard' }),
    ]);
    const org = out.find((c) => c.name === '/onboard')!;
    expect(org.source).toBe('org');
    expect(org.description).toBe('team onboard');
  });

  it('a project-scope command overrides an org-scope one of the same verb', () => {
    // input order user → org → project (as loadOwnedCommands returns)
    const out = mergeCommands([
      ownedCommand({ name: 'dup', scope: 'org', scopeKey: 'default', description: 'org dup' }),
      ownedCommand({ name: 'dup', scope: 'project', scopeKey: '/w', description: 'project dup' }),
    ]);
    const dup = out.find((c) => c.name === '/dup')!;
    expect(dup.source).toBe('project');
    expect(dup.description).toBe('project dup');
  });

  it('carries argumentHint through and falls back to it for description', () => {
    const out = mergeCommands([
      ownedCommand({ name: 'x', description: undefined, command: { template: 't', argumentHint: '<arg>' } }),
    ]);
    expect(out[0].argumentHint).toBe('<arg>');
    expect(out[0].description).toBe('<arg>');
  });

  it('lists owned skills and subagents alongside commands, each kind-tagged', () => {
    const out = mergeCommands([
      ownedCommand({ name: 'ship' }),
      ownedSkill({ name: 'summarize', description: 'summarize a doc' }),
      ownedSubagent({ name: 'reviewer', description: 'code reviewer persona' }),
    ]);
    const byName = (n: string) => out.find((c) => c.name === n)!;
    expect(byName('/ship').kind).toBe('command');
    expect(byName('/summarize').kind).toBe('skill');
    expect(byName('/summarize').description).toBe('summarize a doc');
    expect(byName('/reviewer').kind).toBe('subagent');
    // display grouping: command before skill before subagent
    expect(out.map((c) => c.name)).toEqual(['/ship', '/summarize', '/reviewer']);
  });

  it('a command wins a verb clash over a skill/subagent of the same name', () => {
    // Same verb "dup" as all three kinds — the command must win regardless of order.
    const out = mergeCommands([
      ownedSubagent({ name: 'dup', description: 'sub dup' }),
      ownedSkill({ name: 'dup', description: 'skill dup' }),
      ownedCommand({ name: 'dup', description: 'command dup' }),
    ]);
    expect(out.filter((c) => c.name === '/dup')).toHaveLength(1);
    expect(out.find((c) => c.name === '/dup')!.kind).toBe('command');
    expect(out.find((c) => c.name === '/dup')!.description).toBe('command dup');
  });

  it('skips an owned row whose kind-payload is missing (no silent empty verb)', () => {
    const broken = { ...ownedSkill({ name: 'nope' }), skill: undefined } as HarnessItem;
    const out = mergeCommands([broken]);
    expect(out.some((c) => c.name === '/nope')).toBe(false);
  });
});

describe('listCommands (store-backed)', () => {
  function fakeStore(byScope: Record<string, HarnessItem[]>) {
    return {
      listHarness(scope: string, scopeKey: string) {
        return byScope[`${scope}:${scopeKey}`] ?? [];
      },
    };
  }

  it('lists user-scope harness rows even without a cwd, and nothing else', () => {
    const store = fakeStore({
      [`user:${DEFAULT_USER_ID}`]: [ownedCommand({ name: 'ship' })],
    });
    const out = listCommands(null, store);
    // The palette is exactly the harness now: what the store returns and no more.
    expect(out.map((c) => c.name)).toEqual(['/ship']);
  });

  it('includes org-scope owned commands even without a cwd (HP-08 inheritance)', () => {
    const store = fakeStore({
      [`user:${DEFAULT_USER_ID}`]: [],
      ['org:default']: [ownedCommand({ name: 'onboard', scope: 'org', scopeKey: 'default' })],
    });
    const out = listCommands(null, store);
    const onboard = out.find((c) => c.name === '/onboard')
    expect(onboard).toBeDefined()
    expect(onboard?.source).toBe('org')
  });

  it('surfaces enabled owned skills and subagents in the palette too', () => {
    const store = fakeStore({
      [`user:${DEFAULT_USER_ID}`]: [
        ownedSkill({ name: 'summarize' }),
        ownedSubagent({ name: 'reviewer' }),
      ],
    });
    const out = listCommands(null, store);
    expect(out.find((c) => c.name === '/summarize')?.kind).toBe('skill');
    expect(out.find((c) => c.name === '/reviewer')?.kind).toBe('subagent');
  });

  it('includes project-scope owned commands only when a cwd is given', () => {
    const store = fakeStore({
      [`user:${DEFAULT_USER_ID}`]: [],
      ['project:/proj']: [ownedCommand({ name: 'deploy', scope: 'project', scopeKey: '/proj' })],
    });
    expect(listCommands(null, store).some((c) => c.name === '/deploy')).toBe(false);
    expect(listCommands('/proj', store).some((c) => c.name === '/deploy')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scan-before-read (source assertion, the repo's pattern for wiring facts).
// The palette must reconcile the naby harness home before listing, or a skill
// installed mid-chat stays invisible to "/" until the Settings harness tab —
// the only other scan trigger — happens to be opened.
// ---------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('palette scan-on-read wiring', () => {
  const source = readFileSync(join(__dirname, 'commands.ts'), 'utf8');

  it('listCommands reconciles the naby home before reading harness rows', () => {
    const body = source.slice(source.indexOf('export function listCommands'));
    const reconcileAt = body.indexOf('reconcileNabyHome(');
    const readAt = body.indexOf('loadOwnedCommands(');
    expect(reconcileAt).toBeGreaterThan(-1);
    expect(readAt).toBeGreaterThan(-1);
    expect(reconcileAt).toBeLessThan(readAt);
  });

  it('the reconcile is guarded so a fake or broken store cannot empty the palette', () => {
    expect(source).toMatch(/try\s*\{\s*\n?\s*reconcileNabyHome\(/);
  });
});

describe('palette fresh scan wiring', () => {
  const source = readFileSync(join(__dirname, 'commands.ts'), 'utf8');
  const harnessSource = readFileSync(join(__dirname, 'harness.ts'), 'utf8');

  it('GET forwards fresh=1 into listCommands and the reconcile force flag', () => {
    expect(source).toMatch(/params\.get\("fresh"\) === "1"/);
    expect(source).toMatch(/reconcileNabyHome\([^)]*\{ force: fresh \}/);
  });

  it('force bypasses the scan throttle but still stamps it', () => {
    // The throttle guard must consult force…
    expect(harnessSource).toMatch(/!force && last !== undefined/);
    // …and the stamp line survives unconditionally after it.
    expect(harnessSource).toContain('lastScanAt.set(key, now)');
  });
});
