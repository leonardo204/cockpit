import { describe, it, expect } from 'vitest';
import {
  TOOL_CALL_HEADER_THRESHOLD,
  filterDisplayToolCalls,
  parseWorkflowRunId,
  relativizePath,
  shouldGroupUnderHeader,
  toolCallPreview,
  toolIconFor,
} from './toolCallDisplay';
import type { ToolCallInfo } from './types';

const call = (name: string, input: Record<string, unknown> = {}): ToolCallInfo => ({
  id: `id-${name}`,
  name,
  input,
});

describe('shouldGroupUnderHeader', () => {
  it('leaves small runs bare — a "1 tool call" header is pure noise', () => {
    expect(shouldGroupUnderHeader(1)).toBe(false);
    expect(shouldGroupUnderHeader(2)).toBe(false);
    expect(shouldGroupUnderHeader(3)).toBe(false);
  });

  it('hides a wall of calls behind the header', () => {
    expect(shouldGroupUnderHeader(TOOL_CALL_HEADER_THRESHOLD)).toBe(true);
    expect(shouldGroupUnderHeader(12)).toBe(true);
  });

  it('renders nothing for an empty run', () => {
    expect(shouldGroupUnderHeader(0)).toBe(false);
  });
});

describe('filterDisplayToolCalls', () => {
  it('drops ExitPlanMode — the plan has its own card', () => {
    const out = filterDisplayToolCalls([
      call('Read'),
      call('ExitPlanMode', { plan: '# do this' }),
      call('Bash'),
    ]);
    expect(out.map((tc) => tc.name)).toEqual(['Read', 'Bash']);
  });

  it('handles an absent list', () => {
    expect(filterDisplayToolCalls(undefined)).toEqual([]);
  });
});

describe('toolCallPreview', () => {
  it('shows the command for Bash, verbatim and copyable', () => {
    expect(toolCallPreview('Bash', { command: 'npm test' })).toEqual({
      text: 'npm test',
      kind: 'literal',
    });
  });

  it('shows a path as a path, so it can be shortened and copied', () => {
    expect(toolCallPreview('Read', { file_path: '/a/b/c.ts' })).toEqual({
      text: '/a/b/c.ts',
      kind: 'path',
    });
  });

  it('does not treat a search query as a path', () => {
    // getRelativePath used to run over these, so a query containing slashes was
    // silently rewritten into ".../two segments".
    expect(toolCallPreview('ToolSearch', { query: 'a/b/c d' })).toEqual({
      text: 'a/b/c d',
      kind: 'literal',
    });
  });

  it('labels a subagent task by its description, with no copy affordance', () => {
    expect(toolCallPreview('Task', { description: 'audit the parser' })).toEqual(
      { text: 'audit the parser', kind: 'label' }
    );
  });

  it('joins a workflow name with its args', () => {
    expect(
      toolCallPreview('Workflow', { name: 'release', args: '--dry-run' })
    ).toEqual({ text: 'release · --dry-run', kind: 'label' });
  });

  it('falls back to the first string field rather than showing a bare name', () => {
    expect(toolCallPreview('SomeMcpTool', { url: 'https://example.com' })).toEqual(
      { text: 'https://example.com', kind: 'label' }
    );
  });

  it('condenses a long fallback onto one line', () => {
    const preview = toolCallPreview('SomeMcpTool', {
      note: `${'x'.repeat(200)}\nsecond line`,
    });
    expect(preview?.text.length).toBe(121); // 120 + the ellipsis
    expect(preview?.text.endsWith('…')).toBe(true);
    expect(preview?.text).not.toContain('\n');
  });

  it('returns nothing when there is no string worth showing', () => {
    expect(toolCallPreview('TodoWrite', { todos: [{ content: 'a' }] })).toBeNull();
    expect(toolCallPreview('Read', undefined)).toBeNull();
  });
});

describe('relativizePath', () => {
  it('strips the cwd', () => {
    expect(relativizePath('/repo/src/a.ts', '/repo')).toBe('src/a.ts');
  });

  it('keeps the last two segments of an outside path', () => {
    expect(relativizePath('/etc/nginx/nginx.conf', '/repo')).toBe(
      '.../nginx/nginx.conf'
    );
  });

  it('leaves a short path alone', () => {
    expect(relativizePath('a.ts')).toBe('a.ts');
  });
});

describe('toolIconFor', () => {
  it('falls back to a generic wrench', () => {
    expect(toolIconFor('Read')).toBe('📄');
    expect(toolIconFor('WhateverTool')).toBe('🔧');
  });
});

describe('parseWorkflowRunId', () => {
  it('reads the run id out of the launch text', () => {
    expect(
      parseWorkflowRunId('Transcript dir: /x/subagents/workflows/wf_abc-1')
    ).toBe('wf_abc-1');
  });

  it('answers null when there is no run', () => {
    expect(parseWorkflowRunId(undefined)).toBeNull();
    expect(parseWorkflowRunId('ok')).toBeNull();
  });
});
