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

  it('carries argumentHint through and falls back to it for description', () => {
    const out = mergeCommands([], [
      ownedCommand({ name: 'x', description: undefined, command: { template: 't', argumentHint: '<arg>' } }),
    ]);
    expect(out[0].argumentHint).toBe('<arg>');
    expect(out[0].description).toBe('<arg>');
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

  it('includes project-scope owned commands only when a cwd is given', () => {
    const store = fakeStore({
      [`user:${DEFAULT_USER_ID}`]: [],
      ['project:/proj']: [ownedCommand({ name: 'deploy', scope: 'project', scopeKey: '/proj' })],
    });
    expect(listCommands(null, store).some((c) => c.name === '/deploy')).toBe(false);
    expect(listCommands('/proj', store).some((c) => c.name === '/deploy')).toBe(true);
  });
});
