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

const BUILTINS: CommandInfo[] = [
  { name: '/qa', description: 'builtin qa', source: 'builtin' },
  { name: '/fx', description: 'builtin fx', source: 'builtin' },
];

describe('mergeCommands', () => {
  it('appends a new owned verb after the builtins, badged by scope', () => {
    const out = mergeCommands(BUILTINS, [ownedCommand({ name: 'ship' })]);
    expect(out.map((c) => c.name)).toEqual(['/qa', '/fx', '/ship']);
    expect(out.find((c) => c.name === '/ship')?.source).toBe('user');
  });

  it('an owned command OVERRIDES a builtin of the same verb', () => {
    const out = mergeCommands(BUILTINS, [
      ownedCommand({ name: 'qa', description: 'my own qa' }),
    ]);
    // still one /qa entry, now owned
    expect(out.filter((c) => c.name === '/qa')).toHaveLength(1);
    const qa = out.find((c) => c.name === '/qa')!;
    expect(qa.source).toBe('user');
    expect(qa.description).toBe('my own qa');
    // order preserved: /qa stays first
    expect(out[0].name).toBe('/qa');
  });

  it('a project-scope owned command overrides a user-scope one of the same verb', () => {
    // input order is user-first, project-second (as loadOwnedCommands returns)
    const out = mergeCommands(BUILTINS, [
      ownedCommand({ name: 'dup', scope: 'user', description: 'user dup' }),
      ownedCommand({ name: 'dup', scope: 'project', scopeKey: '/w', description: 'project dup' }),
    ]);
    const dup = out.find((c) => c.name === '/dup')!;
    expect(dup.source).toBe('project');
    expect(dup.description).toBe('project dup');
  });

  it('badges an org-scope owned command as "org" (HP-08 inheritance)', () => {
    const out = mergeCommands(BUILTINS, [
      ownedCommand({ name: 'onboard', scope: 'org', scopeKey: 'default', description: 'team onboard' }),
    ]);
    const org = out.find((c) => c.name === '/onboard')!;
    expect(org.source).toBe('org');
    expect(org.description).toBe('team onboard');
  });

  it('a project-scope command overrides an org-scope one of the same verb', () => {
    // input order user → org → project (as loadOwnedCommands returns)
    const out = mergeCommands(BUILTINS, [
      ownedCommand({ name: 'dup', scope: 'org', scopeKey: 'default', description: 'org dup' }),
      ownedCommand({ name: 'dup', scope: 'project', scopeKey: '/w', description: 'project dup' }),
    ]);
    const dup = out.find((c) => c.name === '/dup')!;
    expect(dup.source).toBe('project');
    expect(dup.description).toBe('project dup');
  });

  it('carries argumentHint through and falls back to it for description', () => {
    const out = mergeCommands([], [
      ownedCommand({ name: 'x', description: undefined, command: { template: 't', argumentHint: '<arg>' } }),
    ]);
    expect(out[0].argumentHint).toBe('<arg>');
    expect(out[0].description).toBe('<arg>');
  });

  it('lists owned skills and subagents alongside commands, each kind-tagged', () => {
    const out = mergeCommands(BUILTINS, [
      ownedCommand({ name: 'ship' }),
      ownedSkill({ name: 'summarize', description: 'summarize a doc' }),
      ownedSubagent({ name: 'reviewer', description: 'code reviewer persona' }),
    ]);
    const byName = (n: string) => out.find((c) => c.name === n)!;
    expect(byName('/ship').kind).toBe('command');
    expect(byName('/summarize').kind).toBe('skill');
    expect(byName('/summarize').description).toBe('summarize a doc');
    expect(byName('/reviewer').kind).toBe('subagent');
    // display grouping: command before skill before subagent (builtins first)
    expect(out.map((c) => c.name)).toEqual(['/qa', '/fx', '/ship', '/summarize', '/reviewer']);
  });

  it('a command wins a verb clash over a skill/subagent of the same name', () => {
    // Same verb "dup" as all three kinds — the command must win regardless of order.
    const out = mergeCommands([], [
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
    const out = mergeCommands([], [broken]);
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

  it('merges user-scope owned commands with builtins even without a cwd', () => {
    const store = fakeStore({
      [`user:${DEFAULT_USER_ID}`]: [ownedCommand({ name: 'ship' })],
    });
    const out = listCommands(null, store);
    expect(out.some((c) => c.name === '/ship')).toBe(true);
    expect(out.some((c) => c.name === '/qa')).toBe(true); // builtin retained
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
