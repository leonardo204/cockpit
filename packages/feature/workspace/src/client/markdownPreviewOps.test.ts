import { describe, it, expect } from 'vitest';
import {
  classifyMarkdownLink,
  countWords,
  formatMissingImage,
  IMAGE_MAX_WIDTH_PX,
  IMAGE_WIDE_FACTOR,
  isWideImage,
  markdownImageUrl,
  planMarkdownImage,
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

/**
 * The image rules carry the same two kinds of weight the link rules do. A
 * source that escapes the project must never become a request — a markdown file
 * is a document the user may not have written, and it must not be a way to read
 * `../../.ssh/id_rsa` — and a source the viewer cannot serve must become a
 * placeholder that explains itself rather than a broken-image icon.
 */
describe('planMarkdownImage — where the bytes come from', () => {
  it('resolves relative to the current document, not the project root', () => {
    expect(planMarkdownImage('docs/guide/setup.md', './diagram.png')).toEqual({
      kind: 'local',
      rel: 'docs/guide/diagram.png',
    });
    expect(planMarkdownImage('README.md', 'diagram.png')).toEqual({
      kind: 'local',
      rel: 'diagram.png',
    });
  });

  it('walks `..` out of the document folder and back into the project', () => {
    expect(planMarkdownImage('docs/guide/setup.md', '../img/logo.svg')).toEqual({
      kind: 'local',
      rel: 'docs/img/logo.svg',
    });
    expect(planMarkdownImage('docs/guide/setup.md', '../../assets/hero.webp')).toEqual({
      kind: 'local',
      rel: 'assets/hero.webp',
    });
  });

  it('percent-decodes each segment, so a space in a folder name still resolves', () => {
    expect(planMarkdownImage('docs/a.md', 'my%20images/shot%201.png')).toEqual({
      kind: 'local',
      rel: 'docs/my images/shot 1.png',
    });
  });

  it('drops a cache-busting query and a fragment before resolving', () => {
    expect(planMarkdownImage('docs/a.md', 'x.png?v=2')).toEqual({ kind: 'local', rel: 'docs/x.png' });
    expect(planMarkdownImage('docs/a.md', 'x.png#frag')).toEqual({ kind: 'local', rel: 'docs/x.png' });
  });

  it('REFUSES a path that climbs above the project root', () => {
    const plan = planMarkdownImage('docs/guide/setup.md', '../../../etc/passwd.png');
    expect(plan.kind).toBe('missing');
    // The attempted path is shown so the user can see WHY, and it is the path
    // that was tried rather than a sanitised one.
    expect(plan).toMatchObject({ attempted: 'docs/guide/../../../etc/passwd.png' });
  });

  it('REFUSES an absolute path — markdown has no notion of the project root', () => {
    expect(planMarkdownImage('docs/a.md', '/etc/hosts.png').kind).toBe('missing');
    expect(planMarkdownImage('docs/a.md', 'C:/Windows/win.png').kind).toBe('missing');
    expect(planMarkdownImage('docs/a.md', 'C:\\Windows\\win.png').kind).toBe('missing');
  });

  it('passes data:, http: and https: through untouched', () => {
    expect(planMarkdownImage('a.md', 'https://example.com/x.png')).toEqual({ kind: 'passthrough' });
    expect(planMarkdownImage('a.md', 'HTTP://example.com/x.png')).toEqual({ kind: 'passthrough' });
    expect(planMarkdownImage('a.md', 'data:image/png;base64,AAAA')).toEqual({ kind: 'passthrough' });
    // Protocol-relative is remote too.
    expect(planMarkdownImage('a.md', '//cdn.example.com/x.png')).toEqual({ kind: 'passthrough' });
  });

  it('does NOT pass other schemes through — they are not ours to fetch', () => {
    expect(planMarkdownImage('a.md', 'file:///etc/passwd.png').kind).toBe('missing');
    expect(planMarkdownImage('a.md', 'vscode://x.png').kind).toBe('missing');
  });

  it('honours the shared whitelist, and heic is not on it', () => {
    expect(planMarkdownImage('a.md', 'shot.avif')).toEqual({ kind: 'local', rel: 'shot.avif' });
    expect(planMarkdownImage('a.md', 'chart.TIFF')).toEqual({ kind: 'local', rel: 'chart.TIFF' });
    // Chromium cannot decode HEIC. Serving it would paint a blank frame; the
    // placeholder at least says what happened. See shared-utils/imageFile.ts.
    expect(planMarkdownImage('a.md', 'IMG_0001.heic')).toEqual({
      kind: 'missing',
      label: 'IMG_0001.heic',
      attempted: 'IMG_0001.heic',
    });
    expect(planMarkdownImage('a.md', 'notes.md').kind).toBe('missing');
    expect(planMarkdownImage('a.md', 'archive.zip').kind).toBe('missing');
  });

  it('reports an empty source rather than emitting an image with no src', () => {
    expect(planMarkdownImage('a.md', '')).toEqual({ kind: 'missing', label: '', attempted: '' });
    expect(planMarkdownImage('a.md', '   ').kind).toBe('missing');
  });
});

describe('markdownImageUrl', () => {
  it('encodes both halves, so a path with & or # cannot cut the query in two', () => {
    expect(markdownImageUrl('/Users/me/proj & co', 'docs/a#b.png')).toBe(
      '/api/fs-image?cwd=%2FUsers%2Fme%2Fproj%20%26%20co&rel=docs%2Fa%23b.png',
    );
  });
});

/**
 * The promotion rule: an image more than TWICE the cap is a screenshot or a
 * diagram, and shrinking one of those to 680px does not make it smaller, it
 * makes it unreadable. Pinned at, below and above the threshold because "wider
 * than 2x" and "at least 2x" differ by exactly one pixel and only a test says
 * which one this is.
 */
describe('isWideImage — the 2x promotion threshold', () => {
  const threshold = IMAGE_MAX_WIDTH_PX * IMAGE_WIDE_FACTOR;

  it('is 1360px, from a 680px cap and a 2x factor', () => {
    expect(IMAGE_MAX_WIDTH_PX).toBe(680);
    expect(IMAGE_WIDE_FACTOR).toBe(2);
    expect(threshold).toBe(1360);
  });

  it('below the threshold is not wide', () => {
    expect(isWideImage(threshold - 1)).toBe(false);
    expect(isWideImage(IMAGE_MAX_WIDTH_PX)).toBe(false);
    expect(isWideImage(1)).toBe(false);
  });

  it('exactly the threshold is not wide — the rule is "exceeds"', () => {
    expect(isWideImage(threshold)).toBe(false);
  });

  it('above the threshold is wide', () => {
    expect(isWideImage(threshold + 1)).toBe(true);
    expect(isWideImage(3840)).toBe(true);
  });

  it('an unprobed image is never wide — it renders under the ordinary cap', () => {
    expect(isWideImage(undefined)).toBe(false);
    expect(isWideImage(null)).toBe(false);
    expect(isWideImage(Number.NaN)).toBe(false);
    expect(isWideImage(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('formatMissingImage', () => {
  it('names the file AND the path that was tried', () => {
    expect(formatMissingImage('Image not found', 'diagram.png', 'docs/diagram.png')).toBe(
      'Image not found: diagram.png (docs/diagram.png)',
    );
  });

  it('does not repeat itself when the file is at the path', () => {
    expect(formatMissingImage('Image not found', 'x.heic', 'x.heic')).toBe(
      'Image not found: x.heic',
    );
  });

  it('carries hostile filenames through as PLAIN TEXT, unescaped and unparsed', () => {
    // The escaping is structural: this string goes into a hast TEXT node, which
    // the DOM escapes. Any escaping done HERE would be double-escaping that the
    // reader would see as literal `&lt;`. What this pins is that the function
    // does not mangle the name — rehypeMarkdownImages.test.ts pins that it
    // really lands in a text node rather than raw HTML.
    const evil = '<img src=x onerror=alert(1)>.png';
    expect(formatMissingImage('Image not found', evil, `docs/${evil}`)).toBe(
      `Image not found: ${evil} (docs/${evil})`,
    );
  });
});
