import { describe, it, expect } from 'vitest';
import { DEFAULT_USER_ID, type HarnessItem } from '../../../../../../../dist/naby-runtime.mjs';
import { resolveCommandPrompt, type CommandExpansionStore } from './slashCommands';

// A fake store returning owned commands per (scope,scopeKey), so expansion's
// owned-override layer is exercised without a sqlite file. An empty store means
// "no owned commands" — the pure builtin path.
function fakeStore(byScope: Record<string, HarnessItem[]> = {}): CommandExpansionStore {
  return {
    listHarness(scope: string, scopeKey: string) {
      return byScope[`${scope}:${scopeKey}`] ?? [];
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

  it('BUILTIN REGRESSION GUARD: a builtin still expands (en) when no owned command shadows it', () => {
    const out = resolveCommandPrompt('/qa hello', 'en', undefined, fakeStore());
    // builtin path writes ~/.cockpit/skills/qa/SKILL.md and injects a pointer to it
    expect(out).toContain('qa');
    expect(out).toContain('SKILL.md');
    expect(out).not.toBe('/qa hello');
  });

  it('BUILTIN REGRESSION GUARD: the ko builtin path is language-specific', () => {
    const out = resolveCommandPrompt('/qa 안녕', 'ko', undefined, fakeStore());
    // ko pointer copy differs from en ("이 skill 파일을 읽어주세요")
    expect(out).toContain('이 skill 파일을 읽어주세요');
  });
});
