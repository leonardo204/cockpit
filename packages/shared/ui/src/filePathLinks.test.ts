import { describe, it, expect } from 'vitest';
import {
  DOCUMENT_EXTENSIONS,
  FILE_PATH_ATTR,
  docTabTarget,
  findDocumentPaths,
  isDocumentPath,
  remarkFilePathLinks,
} from './filePathLinks';

/**
 * A PATH THE ASSISTANT WROTE OUT IS CLICKABLE, AND A LINK CANNOT LIE.
 *
 * Two contracts, and the second is the one worth being strict about: only a bare
 * path found in prose becomes a file link, its own text is its target, and the
 * mark that says so survives to click time. An authored `[열기](/tmp/x.md)` must
 * come out the other side untouched.
 */

const paths = (s: string) => findDocumentPaths(s).map((m) => m.path);

describe('finding a path in prose', () => {
  it('finds the case this feature exists for', () => {
    expect(paths('파일: /Users/zerolive/Downloads/탐지성능_리포트_20260824.md')).toEqual([
      '/Users/zerolive/Downloads/탐지성능_리포트_20260824.md',
    ]);
  });

  it('does not swallow the punctuation around it', () => {
    // Prose has full stops and brackets, and a filename that ate one would point
    // at a file that does not exist — a link that silently does nothing.
    expect(paths('저장했습니다: /tmp/a.md.')).toEqual(['/tmp/a.md']);
    expect(paths('(/tmp/a.md)')).toEqual(['/tmp/a.md']);
    expect(paths('"/tmp/a.md"')).toEqual(['/tmp/a.md']);
    expect(paths('see /tmp/a.md, then /tmp/b.md;')).toEqual(['/tmp/a.md', '/tmp/b.md']);
  });

  it('reads a path at the very start and the very end', () => {
    expect(paths('/tmp/a.md')).toEqual(['/tmp/a.md']);
    expect(paths('here: /tmp/a.md')).toEqual(['/tmp/a.md']);
  });

  it('takes only documents', () => {
    // The viewer renders text. A link that opens nothing is worse than none —
    // and the same restriction is what keeps a click away from the files worth
    // stealing: no extension at all, or one that is not on the list.
    expect(paths('/Users/me/.ssh/id_rsa')).toEqual([]);
    expect(paths('/Users/me/.claude/.credentials.json')).toEqual([]);
    expect(paths('/etc/passwd')).toEqual([]);
    expect(paths('/tmp/photo.png')).toEqual([]);
    for (const ext of DOCUMENT_EXTENSIONS) {
      expect(paths(`file: /tmp/doc${ext}`)).toEqual([`/tmp/doc${ext}`]);
    }
  });

  it('takes only absolute paths', () => {
    // A relative path cannot be resolved without knowing what it is relative to,
    // and guessing is how a link ends up pointing where its text does not say.
    expect(paths('see docs/readme.md')).toEqual([]);
    expect(paths('./notes.md and ../up.md')).toEqual([]);
  });

  it('does not expand ~ — a known and deliberate miss', () => {
    // The client cannot know the home directory, so `~/Downloads/r.md` stays
    // plain text rather than becoming a link that resolves to the wrong file.
    expect(paths('~/Downloads/r.md')).toEqual([]);
  });

  it('is safe on a path still being streamed', () => {
    // Text arrives a chunk at a time. A half-written path has no extension yet,
    // so it simply does not match until it is complete — no link that points at
    // a prefix of the real file.
    expect(paths('파일: /Users/me/Down')).toEqual([]);
    expect(paths('파일: /Users/me/report.m')).toEqual([]);
    expect(paths('파일: /Users/me/report.md')).toEqual(['/Users/me/report.md']);
  });
});

describe('a whole inline-code span that is a path', () => {
  it('accepts the span the assistant actually writes', () => {
    expect(isDocumentPath('/Users/zerolive/Downloads/r.md')).toBe(true);
    expect(isDocumentPath('  /tmp/a.txt  ')).toBe(true);
  });

  it('refuses prose that merely contains one', () => {
    // `the /tmp/a.md file` in backticks is a sentence in a code span, not a path,
    // and linking the whole span would misdescribe what it opens.
    expect(isDocumentPath('the /tmp/a.md file')).toBe(false);
    expect(isDocumentPath('cat /tmp/a.md')).toBe(false);
  });

  it('refuses the same things prose does', () => {
    expect(isDocumentPath('/etc/passwd')).toBe(false);
    expect(isDocumentPath('docs/readme.md')).toBe(false);
    expect(isDocumentPath('')).toBe(false);
  });
});

describe('which root the document is opened against', () => {
  const PROJECT = '/Volumes/work/naby';

  it('opens an outside document against its own folder', () => {
    // The motivating case. The server guard that resolves `rel` against `cwd`
    // is shared with the route that writes and deletes, so it is not relaxed —
    // the document simply gets a root that already contains it.
    expect(docTabTarget('/Users/zerolive/Downloads/r.md', PROJECT)).toEqual({
      cwd: '/Users/zerolive/Downloads',
      rel: 'r.md',
    });
  });

  it('keeps the project as the root for a document inside it', () => {
    // Inside the project a document's relative links legitimately walk up
    // (`../specs/x.md`); a per-file root would refuse them.
    expect(docTabTarget('/Volumes/work/naby/specs/plan.md', PROJECT)).toEqual({
      cwd: PROJECT,
      rel: 'specs/plan.md',
    });
  });

  it('does not mistake a sibling directory for the project', () => {
    // `/work/proj-old` is not inside `/work/proj`. Getting this wrong opens the
    // document against a root that does not contain it, the server refuses the
    // read, and the click does nothing at all.
    expect(docTabTarget('/Volumes/work/naby-old/x.md', PROJECT)).toEqual({
      cwd: '/Volumes/work/naby-old',
      rel: 'x.md',
    });
  });

  it('survives a trailing separator on either side', () => {
    expect(docTabTarget('/Volumes/work/naby/a.md', '/Volumes/work/naby/')).toEqual({
      cwd: '/Volumes/work/naby/',
      rel: 'a.md',
    });
  });

  it('works with no project at all', () => {
    // A chat tab can have no cwd; the document still opens.
    expect(docTabTarget('/tmp/a.md')).toEqual({ cwd: '/tmp', rel: 'a.md' });
  });

  it('handles a document at the filesystem root', () => {
    expect(docTabTarget('/a.md')).toEqual({ cwd: '/', rel: 'a.md' });
  });
});

// ─────────────────────────────────────────────────────────
// The plugin
// ─────────────────────────────────────────────────────────

const text = (value: string) => ({ type: 'text', value });
const para = (...children: unknown[]) => ({
  type: 'root',
  children: [{ type: 'paragraph', children }],
});
const run = (tree: unknown) => {
  remarkFilePathLinks()(tree as never);
  return (tree as { children: { children: Record<string, unknown>[] }[] }).children[0]!.children;
};

describe('minting the link', () => {
  it('splits the prose around the path and links it to itself', () => {
    const out = run(para(text('파일: /tmp/a.md 입니다')));
    expect(out.map((n) => n.type)).toEqual(['text', 'link', 'text']);
    expect(out[0]!.value).toBe('파일: ');
    expect(out[1]!.url).toBe('/tmp/a.md');
    expect(out[2]!.value).toBe(' 입니다');
  });

  it('makes the link text the path — so the label cannot misdescribe it', () => {
    // The property the whole design rests on: what you read IS where it goes.
    const out = run(para(text('/tmp/a.md')));
    const link = out[0] as { url: string; children: { value: string }[] };
    expect(link.children[0]!.value).toBe(link.url);
  });

  it('marks it, so click time can tell a minted link from an authored one', () => {
    const out = run(para(text('/tmp/a.md')));
    const link = out[0] as { data: { hProperties: Record<string, string> } };
    expect(link.data.hProperties[FILE_PATH_ATTR]).toBe('/tmp/a.md');
  });

  it('links several paths in one paragraph', () => {
    const out = run(para(text('/tmp/a.md and /tmp/b.md')));
    expect(out.filter((n) => n.type === 'link').map((n) => n.url)).toEqual([
      '/tmp/a.md',
      '/tmp/b.md',
    ]);
  });

  it('leaves prose with no path completely alone', () => {
    const out = run(para(text('nothing to see')));
    expect(out).toEqual([{ type: 'text', value: 'nothing to see' }]);
  });
});

describe('what the plugin refuses to touch', () => {
  it('never rewrites an AUTHORED link', () => {
    // This is the attack shape: a label that promises one thing pointing at
    // another. It is not minted, so it carries no mark, and the click handler
    // will not open it as a file.
    const tree = para({
      type: 'link',
      url: '/Users/me/.ssh/id_rsa',
      children: [text('리포트 열기')],
    });
    const out = run(tree);
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe('link');
    expect(out[0]!.data).toBeUndefined();
  });

  it('does not linkify a path sitting inside an authored link’s text', () => {
    // Nesting a link inside a link is invalid mdast, and the author already
    // attached an intent to this text.
    const tree = para({
      type: 'link',
      url: 'https://example.com',
      children: [text('/tmp/a.md')],
    });
    const out = run(tree);
    expect(out[0]!.type).toBe('link');
    expect((out[0] as { url: string }).url).toBe('https://example.com');
    expect((out[0] as { children: { type: string }[] }).children[0]!.type).toBe('text');
  });

  it('terminates on a path-only paragraph rather than re-entering its own output', () => {
    // The inserted link contains a text node holding the same path. Revisiting
    // it would find the path again and recurse until the stack gave out, so the
    // visitor skips past what it inserted.
    const out = run(para(text('/tmp/a.md')));
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe('link');
  });
});
