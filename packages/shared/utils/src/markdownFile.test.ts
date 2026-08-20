import { describe, it, expect } from 'vitest';
import { isMarkdownFile } from './markdownFile';

/**
 * The predicate three separate call sites branch on — the double-click
 * behaviour of a file-browser row, whether the context menu offers Preview, and
 * whether the viewer will follow a relative link. They must all get the same
 * answer, so the answers are pinned here rather than at each site.
 */

describe('isMarkdownFile — what counts as markdown', () => {
  it.each(['README.md', 'notes.markdown', 'notes.mdown', 'notes.mkd'])(
    'accepts %s',
    (name) => {
      expect(isMarkdownFile(name)).toBe(true);
    },
  );

  it('is case-insensitive — README.MD is a file people really have', () => {
    expect(isMarkdownFile('README.MD')).toBe(true);
    expect(isMarkdownFile('Notes.MarkDown')).toBe(true);
  });

  it('accepts a path, not just a bare name — callers hold rel strings', () => {
    expect(isMarkdownFile('docs/guide/setup.md')).toBe(true);
    expect(isMarkdownFile('docs\\guide\\setup.md')).toBe(true);
  });

  it.each(['index.ts', 'photo.png', 'notes.txt', 'archive.md.zip', 'Makefile'])(
    'rejects %s',
    (name) => {
      expect(isMarkdownFile(name)).toBe(false);
    },
  );

  it('rejects MDX — it is JSX, and this renderer would print its imports', () => {
    expect(isMarkdownFile('page.mdx')).toBe(false);
  });

  it('rejects a name that is nothing but the extension', () => {
    // `.md` is a dotfile whose whole name is the suffix, not a markdown
    // document — the same distinction copySiblingName draws in fsScope.ts.
    expect(isMarkdownFile('.md')).toBe(false);
    expect(isMarkdownFile('docs/.markdown')).toBe(false);
  });

  it('rejects a directory-ish or empty input rather than throwing', () => {
    expect(isMarkdownFile('')).toBe(false);
    expect(isMarkdownFile('docs/')).toBe(false);
  });
});
