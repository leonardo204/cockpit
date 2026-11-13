import { describe, it, expect } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { REMARK_GFM } from './markdownGfm';

type Node = { type: string; value?: string; children?: Node[] };

/** Parse with the renderer's GFM settings; return node types and the text kept. */
function parse(md: string): { types: string[]; text: string } {
  const p = unified().use(remarkParse).use(...REMARK_GFM);
  const tree = p.runSync(p.parse(md)) as Node;
  const types: string[] = [];
  let text = '';
  const walk = (n: Node) => {
    types.push(n.type);
    if (n.type === 'text') text += n.value ?? '';
    n.children?.forEach(walk);
  };
  walk(tree);
  return { types, text };
}

describe('REMARK_GFM strikethrough', () => {
  it('leaves single-tilde ranges alone (field case: "12/13~15, 16~18")', () => {
    const { types, text } = parse('일정은 12/13~15, 16~18 중에 잡아요.');
    expect(types).not.toContain('delete');
    expect(text).toBe('일정은 12/13~15, 16~18 중에 잡아요.');
  });

  it('still strikes through ~~double tildes~~', () => {
    expect(parse('이건 ~~취소~~ 됐어요.').types).toContain('delete');
  });

  it('keeps the rest of GFM (tables)', () => {
    expect(parse('| a | b |\n| --- | --- |\n| 1 | 2 |').types).toContain('table');
  });
});
