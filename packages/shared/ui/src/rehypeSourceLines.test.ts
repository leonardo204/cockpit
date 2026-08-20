import { describe, it, expect } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import { rehypeSourceLines } from './rehypeSourceLines';
import { extractToc } from './TocSidebar';
import type { Root, Element } from 'hast';

/**
 * The seam the outline sidebar is built on, pinned end to end.
 *
 * `TocSidebar` finds a heading by querying `h1..h6[data-source-start="<line>"]`,
 * where `<line>` comes from its own `extractToc()` scan of the raw markdown.
 * Nothing else connects the two: if `rehypeSourceLines` stops stamping that
 * attribute, or stamps a line the scanner does not agree with, every entry in
 * the outline silently becomes a no-op click. jsdom has no layout and there is
 * no component-render harness here, so the honest check is to run the same
 * plugin chain the renderer runs and read the tree.
 *
 * REHYPE-RAW IS IN THE CHAIN ON PURPOSE. It re-parses the whole tree through an
 * HTML parser, which is exactly the step that could drop the `position` data
 * `rehypeSourceLines` reads — and it runs BEFORE it in MarkdownRenderer's
 * pipeline (base plugins first, caller-supplied ones appended).
 */

function render(markdown: string): Root {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSourceLines);
  return processor.runSync(processor.parse(markdown)) as Root;
}

/** Every element in the tree, flattened. */
function elements(node: Root | Element): Element[] {
  const out: Element[] = [];
  const walk = (n: Root | Element) => {
    for (const child of n.children) {
      if (child.type === 'element') {
        out.push(child);
        walk(child);
      }
    }
  };
  walk(node);
  return out;
}

const headingLine = (tree: Root, text: string): number | undefined => {
  const heading = elements(tree).find(
    (el) => /^h[1-6]$/.test(el.tagName) && JSON.stringify(el.children).includes(text),
  );
  const stamped = heading?.properties?.['data-source-start'];
  return typeof stamped === 'number' ? stamped : undefined;
};

const DOC = [
  '# Title', // 1
  '', // 2
  'Some prose.', // 3
  '', // 4
  '## Install', // 5
  '', // 6
  '```md', // 7
  '## Not a heading', // 8
  '```', // 9
  '', // 10
  '### 설치 방법', // 11
  '', // 12
  '<div>raw html the parser will re-parse</div>', // 13
  '', // 14
  '## Done', // 15
].join('\n');

describe('rehypeSourceLines ↔ TocSidebar — they agree on every heading line', () => {
  it('stamps each heading with the source line extractToc reports', () => {
    const tree = render(DOC);
    for (const item of extractToc(DOC)) {
      expect(headingLine(tree, item.text), `heading "${item.text}"`).toBe(item.sourceLine);
    }
  });

  it('finds the headings it claims to be checking', () => {
    // A scan that silently matched nothing would make the loop above pass
    // vacuously; the fenced `## Not a heading` must NOT be one of them.
    const items = extractToc(DOC).map((i) => i.text);
    expect(items).toEqual(['Title', 'Install', '설치 방법', 'Done']);
  });

  it('survives rehype-raw, which re-parses the tree it stamps', () => {
    // The heading after the raw HTML block is the one that would lose its
    // position data if re-parsing dropped it.
    expect(headingLine(render(DOC), 'Done')).toBe(15);
  });

  it('stamps the <code> inside a <pre> with the fence\'s own line range', () => {
    // MarkdownRenderer's code component reads this to number the highlighted
    // lines: react-markdown gives the code element no usable position of its own.
    const tree = render(DOC);
    const code = elements(tree).find((el) => el.tagName === 'code');
    expect(code?.properties?.['data-source-start']).toBe(7);
    expect(code?.properties?.['data-source-end']).toBe(9);
  });
});
