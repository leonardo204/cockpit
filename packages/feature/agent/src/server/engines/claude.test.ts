import { describe, it, expect } from 'vitest';
import { planPermission } from './claude';

describe('planPermission (plan-mode canUseTool resolver)', () => {
  it('denies + interrupts ExitPlanMode so the turn ends on plan presentation', () => {
    const r = planPermission('ExitPlanMode', { plan: '…' });
    expect(r.behavior).toBe('deny');
    if (r.behavior === 'deny') expect(r.interrupt).toBe(true);
  });

  it('(A) allows Write to a project .claude/plans/ file — the plan artifact', () => {
    const input = { file_path: '/Users/x/proj/.claude/plans/fix.md', content: '# plan' };
    const r = planPermission('Write', input);
    expect(r.behavior).toBe('allow');
    if (r.behavior === 'allow') expect(r.updatedInput).toBe(input);
  });

  it('(A) allows Write to a home ~/.claude/plans/ file', () => {
    const r = planPermission('Write', { file_path: '/Users/x/.claude/plans/p.md' });
    expect(r.behavior).toBe('allow');
  });

  it('(A) resolves the path from opts.blockedPath when input has none', () => {
    const r = planPermission('Write', {}, { blockedPath: '/repo/.claude/plans/p.md' });
    expect(r.behavior).toBe('allow');
  });

  it('(A) allows Edit/MultiEdit/NotebookEdit under .claude/plans/', () => {
    for (const tool of ['Edit', 'MultiEdit', 'NotebookEdit']) {
      const r = planPermission(tool, { file_path: '/r/.claude/plans/p.md', notebook_path: '/r/.claude/plans/p.md' });
      expect(r.behavior).toBe('allow');
    }
  });

  it('(C) denies an edit OUTSIDE .claude/plans/ with a model-visible reason, no interrupt', () => {
    const r = planPermission('Write', { file_path: '/repo/src/app.ts', content: 'x' });
    expect(r.behavior).toBe('deny');
    if (r.behavior === 'deny') {
      expect(r.message).toContain('.claude/plans/');
      expect(r.message).toContain('/repo/src/app.ts');
      expect(r.interrupt).toBeUndefined(); // adapt-and-continue, don't kill the turn
    }
  });

  it('does not treat an unrelated path containing "plans" as a plan file', () => {
    const r = planPermission('Write', { file_path: '/repo/docs/plans/roadmap.md' });
    expect(r.behavior).toBe('deny');
  });

  it('allows read-only / non-edit tools (Read, Grep, Bash) through', () => {
    for (const tool of ['Read', 'Grep', 'Glob', 'Bash']) {
      expect(planPermission(tool, { x: 1 }).behavior).toBe('allow');
    }
  });
});
