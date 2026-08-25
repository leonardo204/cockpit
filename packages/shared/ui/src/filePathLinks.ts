/**
 * filePathLinks.ts — turning a file path the assistant WROTE OUT into something
 * the reader can click.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PROBLEM
 *
 * The assistant finishes a job by saying where it put the file:
 *
 *     파일: /Users/zerolive/Downloads/탐지성능_리포트_20260824.md
 *
 * and the reader's only move is to select that string, copy it, leave the app
 * and paste it somewhere. The path is already the answer; it just is not
 * actionable. This makes it open the document in a tab beside the conversation.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PROPERTY THIS DESIGN IS BUILT AROUND: A LINK CANNOT LIE ABOUT ITS TARGET
 *
 * Clicking a link that reads a file is a small capability, but it is one an
 * attacker would want to aim: a prompt injection can put words in an assistant
 * message, and `[리포트 열기](/Users/you/.ssh/id_rsa)` is exactly the shape that
 * abuses a "click to open" affordance — the label promises one thing and the
 * href does another.
 *
 * So NOTHING AUTHORED IS EVER TURNED INTO A FILE LINK. Only a bare path found in
 * the prose is linkified, and its own text becomes its target — label and
 * destination are the same string, so the label cannot misdescribe where it
 * goes. A hand-written markdown link keeps whatever behaviour it always had.
 *
 * That distinction has to survive to CLICK TIME, and the click handler is given
 * only an href — it cannot tell a minted link from an authored one. So a minted
 * link carries `data-file-path`, the same way `rehypeSourceLines` marks up code
 * blocks with `data-source-start`, and only a marked link opens a file.
 *
 * Two further limits, both narrowing:
 *
 *   - ONLY DOCUMENTS (see `DOCUMENT_EXTENSIONS`). The viewer can only render
 *     text anyway, and the restriction happens to exclude the files worth
 *     stealing — `id_rsa` has no extension, `.env` is all extension, and
 *     `.credentials.json` is not on the list.
 *   - ONLY ABSOLUTE PATHS. A relative one cannot be resolved without knowing
 *     what it is relative to, and guessing would be how a link ends up pointing
 *     somewhere its text does not say.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A MODULE AND NOT A REGEX INSIDE THE RENDERER
 *
 * The same reason `markdownLinks.ts` sits beside it: what counts as a path, and
 * which project a path belongs to, are rules whose failure modes are silent —
 * a sibling directory mistaken for the project, a trailing bracket swallowed
 * into a filename. They are pure, so they are tested here rather than asserted
 * through a component this repo has no harness to render.
 */

import { visit } from 'unist-util-visit';
import type { Node, Parent } from 'unist';

/**
 * What may be linked. The viewer renders text, so this is what it can honestly
 * open — and a link that opens nothing is worse than no link.
 *
 * Deliberately short. Every addition widens what one click can read, so a format
 * earns its place by being one the document tab actually displays.
 */
export const DOCUMENT_EXTENSIONS = ['.md', '.markdown', '.txt'] as const;

/**
 * An absolute POSIX path ending in a document extension.
 *
 * WHAT THE CHARACTER CLASS EXCLUDES IS THE WHOLE DESIGN of this expression.
 * Paths appear inside prose, and prose has punctuation:
 *
 *     `파일: /tmp/a.md 입니다.`      the trailing full stop is not the filename
 *     `(/tmp/a.md)`                 nor is the bracket
 *     `"/tmp/a.md"`                 nor the quote
 *
 * So a segment may not contain whitespace, quotes, brackets, backticks or
 * angle brackets — and because the extension must be at the END of the match,
 * a trailing `.` cannot be absorbed either. Windows paths are not matched: this
 * app's own paths are POSIX, and a `C:\…` pattern would drag in escaping rules
 * for a case that does not arise.
 *
 * The `u` flag is what lets `탐지성능_리포트.md` match — the negated class is
 * over code points, so CJK filenames are ordinary characters here.
 */
const PATH_PATTERN = new RegExp(
  `(?:^|(?<=[\\s:"'\`(\\[<]))(/(?:[^\\s"'\`()\\[\\]<>]+/)*[^\\s"'\`()\\[\\]<>]+(?:${DOCUMENT_EXTENSIONS.map(
    (e) => e.replace('.', '\\.'),
  ).join('|')}))(?=$|[\\s"'\`)\\]>.,;!?])`,
  'gu',
);

/** Does this whole string name a document we would link? Used for inline code,
 *  where the span's ENTIRE content has to be the path — `\`the /tmp/a.md file\``
 *  is prose that happens to be in a code span, not a path. */
export function isDocumentPath(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return false;
  if (/\s/.test(trimmed)) return false;
  return DOCUMENT_EXTENSIONS.some((ext) => trimmed.toLowerCase().endsWith(ext));
}

/** Every document path in a run of prose, with where it sits. Returned rather
 *  than replaced so the caller can split a text node without this module
 *  knowing what an mdast node is. */
export interface PathMatch {
  path: string;
  start: number;
  end: number;
}

export function findDocumentPaths(text: string): PathMatch[] {
  const out: PathMatch[] = [];
  // A fresh regex per call: `lastIndex` on a shared global one is state, and
  // two callers interleaving would make matches disappear at random.
  const re = new RegExp(PATH_PATTERN.source, PATH_PATTERN.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const path = m[1];
    if (!path) continue;
    out.push({ path, start: m.index + m[0].indexOf(path), end: m.index + m[0].indexOf(path) + path.length });
  }
  return out;
}

// ─────────────────────────────────────────────────────────
// Which root the document is read against
// ─────────────────────────────────────────────────────────

/** Where a document tab should be opened: the root, and the path within it. */
export interface DocTabTarget {
  cwd: string;
  rel: string;
}

/**
 * Split an absolute path into the pair a document tab takes.
 *
 * THE OUT-OF-PROJECT CASE IS THE POINT. The report in the screenshot is in
 * `~/Downloads`, and the tab's `rel` is resolved against `cwd` by a server guard
 * that refuses anything outside it (`withinCwd`) — a guard shared with the route
 * that WRITES and DELETES. Relaxing it to reach `~/Downloads` would quietly
 * widen what those operations can touch, which is not a trade worth making for a
 * viewer.
 *
 * It does not have to be made. A document outside the project is opened against
 * ITS OWN DIRECTORY: `/Users/me/Downloads/r.md` becomes `{cwd: '/Users/me/
 * Downloads', rel: 'r.md'}`, which the guard accepts on its own terms with
 * nothing loosened. Relative links and images inside that document then resolve
 * against the folder it lives in, which is what they meant anyway.
 *
 * A document INSIDE the project keeps the project as its root, because there its
 * relative links legitimately walk up (`../specs/x.md`) and a per-file root would
 * refuse them.
 */
export function docTabTarget(absolutePath: string, projectCwd?: string): DocTabTarget {
  const path = absolutePath.replace(/\/+$/, '');
  const slash = path.lastIndexOf('/');
  const parent = slash <= 0 ? '/' : path.slice(0, slash);
  const base = path.slice(slash + 1);

  if (projectCwd && isInsideProject(path, projectCwd)) {
    const root = projectCwd.replace(/\/+$/, '');
    return { cwd: projectCwd, rel: path.slice(root.length + 1) };
  }
  return { cwd: parent, rel: base };
}

/**
 * Is this path strictly inside the project?
 *
 * THE `+ '/'` IS LOAD-BEARING and is the same trick the server's `withinCwd`
 * uses: without it `/work/proj-old/x.md` reads as inside `/work/proj`, and the
 * document would be opened against a root that does not contain it — the server
 * would then refuse the read and the click would do nothing.
 */
function isInsideProject(path: string, projectCwd: string): boolean {
  const root = projectCwd.replace(/\/+$/, '');
  if (!root || root === '/') return path.startsWith('/') && path.length > 1;
  return path.startsWith(root + '/');
}

// ─────────────────────────────────────────────────────────
// The remark plugin
// ─────────────────────────────────────────────────────────

/** The attribute a MINTED link carries. Authored links never have it, which is
 *  how the click handler tells "the app made this out of the path you can see"
 *  from "someone wrote a link that happens to point at a file". */
export const FILE_PATH_ATTR = 'data-file-path';

interface TextNode extends Node {
  type: 'text';
  value: string;
}

/**
 * Rewrite bare document paths in prose into links to themselves.
 *
 * INSIDE AN EXISTING LINK IS LEFT ALONE — `[docs](/tmp/a.md)` already has an
 * author's intent attached, and nesting a link inside a link is invalid mdast
 * besides. Code blocks are skipped for free: `visit` over `text` nodes never
 * enters `code` or `inlineCode`, whose values are not text children. Inline code
 * is handled at render time instead (see the `code` component), because a path
 * in backticks is the SHAPE THIS FEATURE EXISTS FOR — it is how the assistant
 * writes a path and how this repo's own conventions ask for one.
 */
export function remarkFilePathLinks() {
  return (tree: Node): void => {
    visit(tree, 'text', (node: TextNode, index: number | undefined, parent: Parent | undefined) => {
      if (!parent || index === undefined) return;
      if (parent.type === 'link' || parent.type === 'linkReference') return;

      const matches = findDocumentPaths(node.value);
      if (matches.length === 0) return;

      const children: Node[] = [];
      let cursor = 0;
      for (const m of matches) {
        if (m.start > cursor) {
          children.push({ type: 'text', value: node.value.slice(cursor, m.start) } as TextNode);
        }
        children.push({
          type: 'link',
          url: m.path,
          // `hProperties` is how mdast hands attributes to the HTML it becomes;
          // this is the mark the click handler keys on.
          data: { hProperties: { [FILE_PATH_ATTR]: m.path } },
          children: [{ type: 'text', value: m.path } as TextNode],
        } as unknown as Node);
        cursor = m.end;
      }
      if (cursor < node.value.length) {
        children.push({ type: 'text', value: node.value.slice(cursor) } as TextNode);
      }

      parent.children.splice(index, 1, ...(children as Parent['children']));
      // Skip past what was just inserted: revisiting the new text nodes would
      // find the same paths again and recurse until the stack gave out.
      return index + children.length;
    });
  };
}
