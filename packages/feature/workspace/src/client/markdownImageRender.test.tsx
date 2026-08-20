import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import {
  rehypeMarkdownImages,
  type MarkdownImageScan,
  type MarkdownImageSize,
} from './rehypeMarkdownImages';

/**
 * The rewriter driven through the REAL react-markdown pipeline, all the way to
 * markup.
 *
 * WHY THIS EXISTS ALONGSIDE THE UNIT TESTS. rehypeMarkdownImages.test.ts pins
 * what the plugin writes into the tree; it cannot see what react-markdown then
 * does with it. Everything between the two is assumption: that a `data-md-image`
 * key in `properties` survives as a real DOM attribute rather than being
 * dropped as unknown, that a numeric `width` becomes `width="800"`, that a
 * `text` child is escaped rather than parsed, and that rehype-raw running
 * BEFORE this plugin does not turn a hand-written `<img>` into something the
 * rewriter cannot see. Each of those is a silent, total failure of the feature
 * if it is wrong, and none of them is visible from the tree.
 *
 * No DOM is needed: `renderToStaticMarkup` is a pure string renderer, which is
 * also why this can test the pipeline without the component-render harness the
 * repo does not have. It renders ReactMarkdown DIRECTLY rather than
 * MarkdownRenderer, whose theme context and CSS imports are a different
 * concern — MarkdownRenderer's own branch is pinned in markdownImageCap.test.ts.
 */

const SIZES: Record<string, MarkdownImageSize | null> = {
  // Wider than 2x the 680px cap → promoted.
  'docs/x.png': { width: 2000, height: 1000 },
  'docs/y.png': { width: 400, height: 300 },
};

function render(markdown: string): { html: string; scan: MarkdownImageScan } {
  const scan: MarkdownImageScan = { rels: [], missing: 0 };
  const html = renderToStaticMarkup(
    <ReactMarkdown
      rehypePlugins={[
        // Same order as the viewer: raw HTML is resolved into real element
        // nodes first, so an author's hand-written <img> reaches the rewriter
        // as an element rather than as an opaque raw string.
        rehypeRaw,
        [
          rehypeMarkdownImages,
          { cwd: '/p', fromRel: 'docs/a.md', sizes: SIZES, scan, missingPrefix: 'Image not found' },
        ],
      ]}
    >
      {markdown}
    </ReactMarkdown>,
  );
  return { html, scan };
}

describe('markdown image rendering — end to end through react-markdown', () => {
  it('emits a route URL with real, encoded attributes', () => {
    const { html } = render('![small](./y.png)');
    expect(html).toContain('src="/api/fs-image?cwd=%2Fp&amp;rel=docs%2Fy.png"');
    expect(html).toContain('alt="small"');
  });

  it('emits loading, decoding, intrinsic dimensions and the ownership marker', () => {
    const { html } = render('![small](./y.png)');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
    expect(html).toContain('width="400"');
    expect(html).toContain('height="300"');
    // The attribute MarkdownRenderer branches on. If react-markdown ever
    // dropped it as an unknown property, every document image would fall into
    // the raw-HTML branch and be pinned at its full intrinsic width.
    expect(html).toContain('data-md-image="doc"');
  });

  it('marks an image wider than 2x the cap as wide, at render time', () => {
    const { html } = render('![wide](./x.png)');
    expect(html).toContain('data-md-image="wide"');
    // Promotion is a CSS decision; the dimensions are still the real ones.
    expect(html).toContain('width="2000"');
  });

  it('does not preload a lazy image', () => {
    // React 19 emits `<link rel="preload" as="image">` for images it expects to
    // fetch immediately, and does NOT for lazy ones — so this is a direct
    // readout of whether the laziness took. Asserted only in the failing
    // direction: React dropping preloads entirely would leave this passing,
    // React preloading a lazy image would not.
    const { html } = render('![wide](./x.png)');
    expect(html).not.toContain('rel="preload" as="image" href="/api/fs-image?cwd=%2Fp&amp;rel=docs%2Fx.png"');
  });

  it('renders an unresolvable image as an inline span with ESCAPED text', () => {
    const { html } = render('![bad](./z.heic)');
    expect(html).toContain('<span class="md-img-missing" title="docs/z.heic">');
    expect(html).toContain('Image not found: z.heic (docs/z.heic)');
    // Inline, inside the paragraph the image was in — a block here would be
    // un-nested by the parser and split the paragraph.
    expect(html).toContain('<p><span class="md-img-missing"');
  });

  it('escapes a hostile filename instead of parsing it', () => {
    // Percent-encoded, which is how a real document references a name with
    // angle brackets in it. The rewriter decodes it, fails to resolve it, and
    // puts the decoded name in a TEXT node — where React escapes it.
    const { html } = render('![bad](./%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E.heic)');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;.heic');
    // Nothing was parsed into a live element.
    expect(html).not.toContain('onerror=alert(1)>');
  });

  it('neutralises a raw <img> an author wrote by hand into the document', () => {
    // rehype-raw turns this into a real element node, so it reaches the
    // rewriter like any other image and is judged by the same rules — here it
    // has no whitelisted extension, so it becomes a placeholder rather than a
    // live element with an onerror handler.
    const { html } = render('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('onerror');
    expect(html).toContain('class="md-img-missing"');
  });

  it('leaves a hand-written <img> at the size its author gave it', () => {
    const { html } = render('<img src="./y.png" height="28">');
    // Repointed, or it would 404 like every other relative source…
    expect(html).toContain('src="/api/fs-image?cwd=%2Fp&amp;rel=docs%2Fy.png"');
    // …but otherwise untouched: no injected dimensions, no lazy attributes, and
    // no ownership marker, so MarkdownRenderer keeps painting it at 28px.
    expect(html).toContain('height="28"');
    expect(html).not.toContain('width="400"');
    expect(html).not.toContain('data-md-image');
    expect(html).not.toContain('loading="lazy"');
  });

  it('leaves a remote image completely alone', () => {
    const { html } = render('![remote](https://example.com/r.png)');
    expect(html).toContain('src="https://example.com/r.png"');
    expect(html).not.toContain('/api/fs-image');
    expect(html).not.toContain('loading="lazy"');
  });

  it('reports what it found for the host to probe and to count', () => {
    const { scan } = render(
      '![w](./x.png)\n\n![s](./y.png)\n\n![b](./z.heic)\n\n![r](https://e.com/r.png)',
    );
    expect(scan.rels).toEqual(['docs/x.png', 'docs/y.png']);
    expect(scan.missing).toBe(1);
  });
});
