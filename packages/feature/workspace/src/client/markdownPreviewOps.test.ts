import { describe, it, expect } from 'vitest';
import {
  classifyMarkdownLink,
  countWords,
  previewErrorKey,
  readingTimeMinutes,
  rowActivation,
  WORDS_PER_MINUTE,
} from './markdownPreviewOps';

/**
 * The viewer's decisions, pinned away from its JSX.
 *
 * The link classification carries the weight here. Two of its outcomes are
 * safety properties rather than conveniences: a relative href that escapes the
 * project must never become a request, and a relative href the viewer cannot
 * open must never reach the browser — an unhandled one resolves against the
 * app's own origin and navigates the single-page shell away from the running
 * chat session.
 */

describe('classifyMarkdownLink — sibling documents', () => {
  it('resolves a sibling relative to the current document, not the root', () => {
    expect(classifyMarkdownLink('docs/guide/setup.md', 'install.md')).toEqual({
      kind: 'markdown',
      rel: 'docs/guide/install.md',
      anchor: '',
    });
  });

  it('resolves an explicit ./ the same way', () => {
    expect(classifyMarkdownLink('docs/setup.md', './install.md')).toEqual({
      kind: 'markdown',
      rel: 'docs/install.md',
      anchor: '',
    });
  });

  it('walks up with ..', () => {
    expect(classifyMarkdownLink('docs/guide/setup.md', '../README.md')).toEqual({
      kind: 'markdown',
      rel: 'docs/README.md',
      anchor: '',
    });
    expect(classifyMarkdownLink('docs/guide/setup.md', '../../README.md')).toEqual({
      kind: 'markdown',
      rel: 'README.md',
      anchor: '',
    });
    expect(classifyMarkdownLink('docs/a/b/c.md', '../../x/y.md')).toEqual({
      kind: 'markdown',
      rel: 'docs/x/y.md',
      anchor: '',
    });
  });

  it('resolves from a document at the project root', () => {
    expect(classifyMarkdownLink('README.md', 'docs/setup.md')).toEqual({
      kind: 'markdown',
      rel: 'docs/setup.md',
      anchor: '',
    });
  });

  it('keeps an #anchor suffix so the new document can be scrolled to it', () => {
    expect(classifyMarkdownLink('docs/setup.md', 'install.md#requirements')).toEqual({
      kind: 'markdown',
      rel: 'docs/install.md',
      anchor: 'requirements',
    });
    expect(classifyMarkdownLink('docs/a/b.md', '../c.md#설치')).toEqual({
      kind: 'markdown',
      rel: 'docs/c.md',
      anchor: '설치',
    });
  });

  it('drops a query string, which no local file has', () => {
    expect(classifyMarkdownLink('a.md', 'b.md?v=2#top')).toEqual({
      kind: 'markdown',
      rel: 'b.md',
      anchor: 'top',
    });
  });

  it('percent-decodes each segment on its own', () => {
    // An encoded separator inside a segment must not become a real one.
    expect(classifyMarkdownLink('docs/a.md', 'my%20notes.md')).toEqual({
      kind: 'markdown',
      rel: 'docs/my notes.md',
      anchor: '',
    });
    expect(classifyMarkdownLink('a.md', 'sub%2Fdir.md')).toEqual({
      kind: 'markdown',
      rel: 'sub/dir.md',
      anchor: '',
    });
  });

  it('leaves a malformed escape as typed instead of throwing', () => {
    expect(classifyMarkdownLink('a.md', '100%.md')).toEqual({
      kind: 'markdown',
      rel: '100%.md',
      anchor: '',
    });
  });
});

describe('classifyMarkdownLink — what it refuses to follow', () => {
  it('refuses a path that climbs out of the project', () => {
    expect(classifyMarkdownLink('README.md', '../secrets.md')).toEqual({ kind: 'unsupported' });
    expect(classifyMarkdownLink('docs/a.md', '../../../etc/notes.md')).toEqual({
      kind: 'unsupported',
    });
    // Climbing out and back in is still out — the walk is refused at the top.
    expect(classifyMarkdownLink('docs/a.md', '../../other/x.md')).toEqual({
      kind: 'unsupported',
    });
  });

  it('refuses an absolute path — markdown has no notion of the project root', () => {
    expect(classifyMarkdownLink('a.md', '/etc/passwd.md')).toEqual({ kind: 'unsupported' });
    expect(classifyMarkdownLink('a.md', 'C:/Windows/notes.md')).toEqual({ kind: 'unsupported' });
  });

  it('refuses a relative link to something that is not markdown', () => {
    // Inside the project, but outside what this viewer renders. Refusing means
    // the click is consumed, NOT that it navigates the shell.
    expect(classifyMarkdownLink('docs/a.md', 'diagram.png')).toEqual({ kind: 'unsupported' });
    expect(classifyMarkdownLink('docs/a.md', '../src/index.ts')).toEqual({ kind: 'unsupported' });
    expect(classifyMarkdownLink('docs/a.md', 'guide/')).toEqual({ kind: 'unsupported' });
  });

  it('refuses an empty or anchor-only href', () => {
    // MarkdownRenderer resolves same-document anchors before consulting the
    // host, so these should never arrive; if one does it is dropped, not chased.
    expect(classifyMarkdownLink('a.md', '')).toEqual({ kind: 'unsupported' });
    expect(classifyMarkdownLink('a.md', '#section')).toEqual({ kind: 'unsupported' });
  });
});

describe('classifyMarkdownLink — what belongs to the browser', () => {
  it.each([
    'https://example.com/doc.md',
    'http://example.com',
    'mailto:someone@example.com',
    'vscode://file/tmp/x.md',
    '//cdn.example.com/x.md',
  ])('hands %s back unhandled so the anchor opens it externally', (href) => {
    expect(classifyMarkdownLink('a.md', href)).toEqual({ kind: 'external' });
  });
});

describe('countWords', () => {
  it('counts space-separated words', () => {
    expect(countWords('one two three four')).toBe(4);
  });

  it('ignores markdown punctuation that is not a word', () => {
    expect(countWords('# Title\n\n---\n\n- one\n- two\n')).toBe(3);
    expect(countWords('| a | b |\n| --- | --- |')).toBe(2);
  });

  it('does not count fenced code, inline code or raw HTML tags', () => {
    const doc = 'alpha beta\n\n```ts\nconst x = 1; const y = 2;\n```\n\ngamma';
    expect(countWords(doc)).toBe(3);
    expect(countWords('alpha `const y = 2` beta')).toBe(2);
    expect(countWords('<div class="x">alpha</div>')).toBe(1);
  });

  it('keeps a link label and drops its URL', () => {
    expect(countWords('see the [install guide](docs/install.md)')).toBe(4);
    expect(countWords('![a diagram](img/x.png)')).toBe(2);
  });

  it('counts Korean by eojeol, not by syllable', () => {
    // Korean is spaced, so per-syllable counting would triple the estimate and
    // turn a two-minute document into a six-minute one.
    expect(countWords('나는 오늘 문서를 읽는다')).toBe(4);
  });

  it('counts Han and kana per character, because they are written unspaced', () => {
    expect(countWords('日本語')).toBe(3);
    expect(countWords('ひらがな')).toBe(4);
  });

  it('is 0 for an empty or punctuation-only document', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('\n\n---\n\n')).toBe(0);
  });
});

describe('readingTimeMinutes', () => {
  it('reports 0 — "less than a minute" — below one minute of prose', () => {
    expect(readingTimeMinutes(0)).toBe(0);
    expect(readingTimeMinutes(1)).toBe(0);
    expect(readingTimeMinutes(WORDS_PER_MINUTE - 1)).toBe(0);
  });

  it('reads at 200 words per minute', () => {
    expect(readingTimeMinutes(200)).toBe(1);
    expect(readingTimeMinutes(400)).toBe(2);
    expect(readingTimeMinutes(2000)).toBe(10);
  });

  it('rounds rather than inflating every part-minute to a whole one', () => {
    expect(readingTimeMinutes(280)).toBe(1);
    expect(readingTimeMinutes(300)).toBe(2);
  });
});

describe('previewErrorKey', () => {
  it('gives an over-sized file its own sentence', () => {
    // A real property of the user's file, not a malfunction: "could not read
    // this file" would send them looking for a bug.
    expect(previewErrorKey('too-large')).toBe('markdownPreview.tooLarge');
  });

  it.each(['not-found', 'escape', 'failed', undefined])('falls back for %s', (reason) => {
    expect(previewErrorKey(reason)).toBe('markdownPreview.loadError');
  });
});

describe('rowActivation — which "open" a double-click means', () => {
  it('previews markdown in the app', () => {
    expect(rowActivation({ name: 'README.md', isDir: false })).toBe('preview');
    expect(rowActivation({ name: 'notes.MARKDOWN', isDir: false })).toBe('preview');
  });

  it('hands everything else to the OS — the user\'s own tools still win', () => {
    expect(rowActivation({ name: 'index.ts', isDir: false })).toBe('os-open');
    expect(rowActivation({ name: 'photo.png', isDir: false })).toBe('os-open');
  });

  it('does nothing for a folder — a double-click there is two expand toggles', () => {
    expect(rowActivation({ name: 'docs', isDir: true })).toBe('none');
    expect(rowActivation({ name: 'weird.md', isDir: true })).toBe('none');
  });
});
