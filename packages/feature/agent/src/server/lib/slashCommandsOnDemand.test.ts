import { describe, it, expect } from 'vitest';
import { DEFAULT_USER_ID, type HarnessItem } from '../../../../../../../dist/naby-runtime.mjs';
import { resolveCommandPrompt, unclaimedLineLedVerbs, type CommandExpansionStore } from './slashCommands';

/**
 * THE `/` PALETTE AND AN ON-DEMAND ORG SKILL (org-harness-sync §3.3, M2).
 *
 * An org skill row carries only a description paragraph; its real SKILL.md is in
 * the package. Before M2, picking `/task` from the palette and sending
 * `/task start …` made the line-led dispatcher inline that DESCRIPTION as if it
 * were the skill — and, because a line-led verb counts as "already expanded", the
 * real body was never loaded. Now the dispatcher leaves the line alone and the
 * engine names the row for the runtime (`unclaimedLineLedVerbs`), which preloads
 * the body. Every other row expands exactly as before.
 */

function store(byScope: Record<string, HarnessItem[]>): CommandExpansionStore {
  return {
    listHarness(scope: string, scopeKey: string) {
      return byScope[`${scope}:${scopeKey}`] ?? [];
    },
    getAgentByName() {
      return undefined;
    },
  } as CommandExpansionStore;
}

function row(
  name: string,
  instructions: string,
  opts: { scope?: 'user' | 'org'; onDemand?: boolean } = {},
): HarnessItem {
  const scope = opts.scope ?? 'user';
  return {
    id: `id-${scope}-${name}`,
    scope,
    scopeKey: scope === 'org' ? 'default' : DEFAULT_USER_ID,
    kind: 'skill',
    name,
    status: 'enabled',
    provenance: { source: 'artifact' },
    skill: {
      instructions,
      ...(opts.onDemand
        ? { toolRefs: ['naby_skill_load', 'run_command'], loadMode: 'on-demand' as const, packageRef: 'altimedia-harness' }
        : {}),
    },
    createdAt: 1,
    updatedAt: 1,
  } as HarnessItem;
}

const ORG_TASK = row('task', 'Open and close a task. (description only)', { scope: 'org', onDemand: true });

describe('on-demand org skills in the line-led dispatcher', () => {
  it('does NOT expand `/task start …` into the description stub', () => {
    const s = store({ 'org:default': [ORG_TASK] });
    expect(resolveCommandPrompt('/task start 회의록', 'ko', undefined, s)).toBe('/task start 회의록');
  });

  it('reports the verb as unclaimed, so the engine names it for the preload', () => {
    const s = store({ 'org:default': [ORG_TASK] });
    expect(unclaimedLineLedVerbs('/task start 회의록', undefined, s)).toEqual(['task']);
  });

  it('a body-carrying skill still expands, and is NOT reported (no double injection)', () => {
    const s = store({ [`user:${DEFAULT_USER_ID}`]: [row('review', 'REVIEW BODY')] });
    expect(resolveCommandPrompt('/review now', 'en', undefined, s)).toBe('REVIEW BODY\n\nnow');
    expect(unclaimedLineLedVerbs('/review now', undefined, s)).toEqual([]);
  });

  it('a same-name user copy wins the dispatcher (§3.2 precedence) and is claimed', () => {
    const s = store({
      'org:default': [ORG_TASK],
      [`user:${DEFAULT_USER_ID}`]: [row('task', 'MY TASK BODY')],
    });
    expect(resolveCommandPrompt('/task start', 'en', undefined, s)).toBe('MY TASK BODY\n\nstart');
    expect(unclaimedLineLedVerbs('/task start', undefined, s)).toEqual([]);
  });

  it('mid-sentence tokens are not its business, and duplicates collapse', () => {
    const s = store({ 'org:default': [ORG_TASK] });
    expect(unclaimedLineLedVerbs('please /task this\n/task close\n/task start', undefined, s)).toEqual(['task']);
    expect(unclaimedLineLedVerbs('nothing here', undefined, s)).toEqual([]);
  });
});
