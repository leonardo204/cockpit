import { describe, it, expect } from 'vitest';
import { DEFAULT_USER_ID, type HarnessItem } from '../../../../../../../dist/naby-runtime.mjs';
import { resolveCommandPrompt, type CommandExpansionStore } from './slashCommands';

// A fake store returning owned commands per (scope,scopeKey), so expansion's
// owned-override layer is exercised without a sqlite file. An empty store means
// "no owned commands" — the pure builtin path.
function fakeStore(
  byScope: Record<string, HarnessItem[]> = {},
  agentNames: string[] = [],
): CommandExpansionStore {
  return {
    listHarness(scope: string, scopeKey: string) {
      return byScope[`${scope}:${scopeKey}`] ?? [];
    },
    // P3-M2: the `@`-collision guard asks whether a verb is a registered agent.
    getAgentByName(name: string) {
      return agentNames.includes(name) ? ({ id: `a-${name}`, name } as never) : undefined;
    },
  } as CommandExpansionStore;
}

function owned(name: string, template: string, scope: 'user' | 'project' = 'user', scopeKey = DEFAULT_USER_ID): HarnessItem {
  return {
    id: `id-${name}`,
    scope,
    scopeKey,
    kind: 'command',
    name,
    status: 'enabled',
    provenance: { source: 'user' },
    command: { template },
    createdAt: 1,
    updatedAt: 1,
  } as HarnessItem;
}

function ownedSkill(name: string, instructions: string): HarnessItem {
  return {
    id: `id-${name}`,
    scope: 'user',
    scopeKey: DEFAULT_USER_ID,
    kind: 'skill',
    name,
    status: 'enabled',
    provenance: { source: 'user' },
    skill: { instructions },
    createdAt: 1,
    updatedAt: 1,
  } as HarnessItem;
}

function ownedSubagent(name: string, systemPrompt: string): HarnessItem {
  return {
    id: `id-${name}`,
    scope: 'user',
    scopeKey: DEFAULT_USER_ID,
    kind: 'subagent',
    name,
    status: 'enabled',
    provenance: { source: 'user' },
    subagent: { systemPrompt },
    createdAt: 1,
    updatedAt: 1,
  } as HarnessItem;
}

describe('resolveCommandPrompt — owned commands (Phase 1.6 HP-02)', () => {
  it('leaves ordinary text untouched', () => {
    const out = resolveCommandPrompt('just a message', 'en', undefined, fakeStore());
    expect(out).toBe('just a message');
  });

  it('leaves an unknown /verb untouched', () => {
    const out = resolveCommandPrompt('/notacommand hi', 'en', undefined, fakeStore());
    expect(out).toBe('/notacommand hi');
  });

  it('expands a NEW owned command to its template + trailing text', () => {
    const store = fakeStore({ [`user:${DEFAULT_USER_ID}`]: [owned('ship', 'SHIP IT')] });
    const out = resolveCommandPrompt('/ship now', 'en', undefined, store);
    expect(out).toBe('SHIP IT\n\nnow');
  });

  it('an owned command OVERRIDES a builtin of the same verb (no SKILL.md pointer)', () => {
    const store = fakeStore({ [`user:${DEFAULT_USER_ID}`]: [owned('qa', 'OWNED QA BODY')] });
    const out = resolveCommandPrompt('/qa question', 'en', undefined, store);
    expect(out).toContain('OWNED QA BODY');
    expect(out).not.toContain('SKILL.md'); // the builtin file-pointer path was bypassed
  });

  it('a project-scope owned command overrides a user-scope one of the same verb', () => {
    const store = fakeStore({
      [`user:${DEFAULT_USER_ID}`]: [owned('dup', 'USER BODY')],
      ['project:/proj']: [owned('dup', 'PROJECT BODY', 'project', '/proj')],
    });
    const out = resolveCommandPrompt('/dup x', 'en', '/proj', store);
    expect(out).toBe('PROJECT BODY\n\nx');
  });

  it('leaves a retired cockpit builtin as ordinary text', () => {
    // `/qa` and its five siblings were removed along with the palette entries
    // that advertised them. The resolver must not keep a private list of verbs
    // the menu no longer offers — that is the divergence this whole change was
    // about, just pointing the other way.
    for (const verb of ['/qa', '/ap', '/fx', '/ex', '/go', '/new-branch']) {
      const line = `${verb} hello`;
      expect(resolveCommandPrompt(line, 'en', undefined, fakeStore())).toBe(line);
      expect(resolveCommandPrompt(line, 'ko', undefined, fakeStore())).toBe(line);
    }
  });

  it('expands a registered command that reuses a retired builtin name', () => {
    // Nothing is reserved any more: the user may register `qa` and get theirs.
    const store = fakeStore({
      [`user:${DEFAULT_USER_ID}`]: [owned('qa', 'MY OWN QA')],
    });
    expect(resolveCommandPrompt('/qa hello', 'en', undefined, store)).toBe('MY OWN QA\n\nhello');
  });

  it('expands an owned SKILL invoked via "/" by inlining its instructions', () => {
    const store = fakeStore({
      [`user:${DEFAULT_USER_ID}`]: [ownedSkill('summarize', 'SUMMARIZE THE DOC')],
    });
    const out = resolveCommandPrompt('/summarize this', 'en', undefined, store);
    expect(out).toBe('SUMMARIZE THE DOC\n\nthis');
    expect(out).not.toContain('SKILL.md'); // inlined, not a file pointer
  });

  it('expands an owned SUBAGENT invoked via "/" as a persona directive (en/ko)', () => {
    const store = fakeStore({
      [`user:${DEFAULT_USER_ID}`]: [ownedSubagent('reviewer', 'You are a strict code reviewer.')],
    });
    const en = resolveCommandPrompt('/reviewer check', 'en', undefined, store);
    expect(en).toContain('Adopt the following persona');
    expect(en).toContain('You are a strict code reviewer.');
    expect(en.endsWith('check')).toBe(true);

    const ko = resolveCommandPrompt('/reviewer 확인', 'ko', undefined, store);
    expect(ko).toContain('다음 페르소나로');
    expect(ko).toContain('You are a strict code reviewer.');
  });

  it('a command wins a verb clash over a skill of the same name', () => {
    const store = fakeStore({
      [`user:${DEFAULT_USER_ID}`]: [
        ownedSkill('dup', 'SKILL BODY'),
        owned('dup', 'COMMAND BODY'),
      ],
    });
    const out = resolveCommandPrompt('/dup x', 'en', undefined, store);
    expect(out).toBe('COMMAND BODY\n\nx');
  });
});

describe('resolveCommandPrompt — @agent collision rule (Phase 3 P3-M2)', () => {
  it('a registered agent SHADOWS a same-named @subagent — the line is left literal for engine routing', () => {
    const store = fakeStore(
      { [`user:${DEFAULT_USER_ID}`]: [ownedSubagent('reviewer', 'You are a strict code reviewer.')] },
      ['reviewer'], // 'reviewer' is ALSO a registered naby agent
    );
    const out = resolveCommandPrompt('@reviewer check', 'en', undefined, store);
    // NOT expanded to a persona directive — passed through verbatim so the engine
    // (parseAgentAddress) routes the turn to the registered @reviewer agent.
    expect(out).toBe('@reviewer check');
    expect(out).not.toContain('Adopt the following persona');
  });

  it('the collision rule is @-only: /verb still expands the harness subagent even when an agent shares the name', () => {
    const store = fakeStore(
      { [`user:${DEFAULT_USER_ID}`]: [ownedSubagent('reviewer', 'You are a strict code reviewer.')] },
      ['reviewer'],
    );
    const out = resolveCommandPrompt('/reviewer check', 'en', undefined, store);
    expect(out).toContain('Adopt the following persona');
    expect(out).toContain('You are a strict code reviewer.');
  });

  it('without a registered agent, @subagent expands as before (no regression)', () => {
    const store = fakeStore({
      [`user:${DEFAULT_USER_ID}`]: [ownedSubagent('reviewer', 'You are a strict code reviewer.')],
    });
    const out = resolveCommandPrompt('@reviewer check', 'en', undefined, store);
    expect(out).toContain('You are a strict code reviewer.');
  });
});
