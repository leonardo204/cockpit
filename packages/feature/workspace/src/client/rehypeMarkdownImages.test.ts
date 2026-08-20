import { describe, it, expect } from 'vitest';
import type { Element, Root } from 'hast';
import {
  rehypeMarkdownImages,
  type MarkdownImageScan,
  type MarkdownImageSize,
} from './rehypeMarkdownImages';

/**
 * The rewriter, driven over real hast trees.
 *
 * This is the whole reason the port uses the AST instead of the reference
 * editor's regex over rendered HTML: an `Element` node can be built in a test
 * literally, walked by the real transformer, and inspected property by
 * property — no string reassembly, no quoting hazards, and nothing that a `>`
 * inside an `alt` could confuse.
 */

const CWD = '/Users/me/proj';

function img(properties: Record<string, unknown>): Element {
  return { type: 'element', tagName: 'img', properties, children: [] };
}

/** A paragraph wrapping the images, which is where markdown really puts them. */
function tree(...children: Element[]): Root {
  return {
    type: 'root',
    children: [{ type: 'element', tagName: 'p', properties: {}, children }],
  };
}

function run(
  nodes: Element[],
  opts: {
    fromRel?: string;
    sizes?: Record<string, MarkdownImageSize | null>;
    scan?: MarkdownImageScan;
  } = {},
): MarkdownImageScan {
  const scan = opts.scan ?? { rels: [], missing: 0 };
  rehypeMarkdownImages({
    cwd: CWD,
    fromRel: opts.fromRel ?? 'docs/guide/setup.md',
    sizes: opts.sizes ?? {},
    scan,
    missingPrefix: 'Image not found',
  })(tree(...nodes));
  return scan;
}

describe('rehypeMarkdownImages — local images', () => {
  it('repoints src at the route, resolved from the CURRENT document', () => {
    const node = img({ src: './diagram.png', alt: 'a diagram' });
    run([node], { fromRel: 'docs/guide/setup.md' });
    expect(node.properties.src).toBe(
      '/api/fs-image?cwd=%2FUsers%2Fme%2Fproj&rel=docs%2Fguide%2Fdiagram.png',
    );
    // The alt is the author's and is never touched.
    expect(node.properties.alt).toBe('a diagram');
  });

  it('adds lazy loading and async decoding, which is what makes a long document cheap', () => {
    const node = img({ src: 'x.png' });
    run([node]);
    expect(node.properties.loading).toBe('lazy');
    expect(node.properties.decoding).toBe('async');
  });

  it('injects intrinsic dimensions when they are known, so lazy loading does not shift the layout', () => {
    const node = img({ src: 'x.png' });
    run([node], { sizes: { 'docs/guide/x.png': { width: 800, height: 600 } } });
    expect(node.properties.width).toBe(800);
    expect(node.properties.height).toBe(600);
    expect(node.properties['data-md-image']).toBe('doc');
  });

  it('STILL RENDERS an image whose dimensions are unknown, just without a box', () => {
    // Dimension injection is polish; images loading is the requirement.
    const unprobed = img({ src: 'a.png' });
    const probedNull = img({ src: 'b.png' });
    run([unprobed, probedNull], { sizes: { 'docs/guide/b.png': null } });
    for (const node of [unprobed, probedNull]) {
      expect(node.tagName).toBe('img');
      expect(String(node.properties.src)).toContain('/api/fs-image?');
      expect(node.properties.width).toBeUndefined();
      expect(node.properties.height).toBeUndefined();
      expect(node.properties['data-md-image']).toBe('doc');
    }
  });

  it('promotes an image wider than 2x the cap instead of shrinking it', () => {
    const wide = img({ src: 'shot.png' });
    const normal = img({ src: 'small.png' });
    const exactly = img({ src: 'edge.png' });
    run([wide, normal, exactly], {
      sizes: {
        'docs/guide/shot.png': { width: 1361, height: 800 },
        'docs/guide/small.png': { width: 900, height: 500 },
        // Exactly 2x is NOT wide — the rule is "exceeds".
        'docs/guide/edge.png': { width: 1360, height: 700 },
      },
    });
    expect(wide.properties['data-md-image']).toBe('wide');
    expect(normal.properties['data-md-image']).toBe('doc');
    expect(exactly.properties['data-md-image']).toBe('doc');
    // Promotion is a CSS decision only — the real dimensions are unchanged, and
    // nothing anywhere resamples the file.
    expect(wide.properties.width).toBe(1361);
    expect(wide.properties.height).toBe(800);
  });
});

describe('rehypeMarkdownImages — the author always wins', () => {
  it.each([
    ['width', { src: 'x.png', width: 28 }],
    ['height', { src: 'x.png', height: 28 }],
    ['loading', { src: 'x.png', loading: 'eager' }],
  ])('does not overwrite an author-specified %s', (_name, properties) => {
    const node = img({ ...properties });
    const before = { ...node.properties };
    run([node], { sizes: { 'docs/guide/x.png': { width: 800, height: 600 } } });

    // The src IS repointed — otherwise the hand-written tag would simply 404.
    expect(String(node.properties.src)).toContain('/api/fs-image?');
    // Everything else is left exactly as written: no injected dimensions, no
    // lazy attributes, and no `data-md-image`, so the renderer keeps using its
    // raw-HTML branch and paints the badge at the size it was given.
    expect(node.properties.width).toBe(before.width);
    expect(node.properties.height).toBe(before.height);
    expect(node.properties.loading).toBe(before.loading);
    expect(node.properties.decoding).toBeUndefined();
    expect(node.properties['data-md-image']).toBeUndefined();
  });
});

describe('rehypeMarkdownImages — remote and inline sources', () => {
  it.each([
    'https://example.com/x.png',
    'http://example.com/x.png',
    'data:image/png;base64,AAAA',
    '//cdn.example.com/x.png',
  ])('leaves %s completely alone', (src) => {
    const node = img({ src });
    const scan = run([node]);
    expect(node.properties).toEqual({ src });
    expect(scan.rels).toEqual([]);
    expect(scan.missing).toBe(0);
  });
});

describe('rehypeMarkdownImages — the diagnostic placeholder', () => {
  it('replaces an escaping path with an INLINE span, not a block', () => {
    // An image sits inside a paragraph; a block element here would be
    // un-nested by the HTML parser and split the paragraph around it.
    const node = img({ src: '../../../etc/passwd.png' });
    run([node], { fromRel: 'docs/guide/setup.md' });
    expect(node.tagName).toBe('span');
    expect(node.properties.className).toEqual(['md-img-missing']);
  });

  it('names the file and the full attempted path', () => {
    const node = img({ src: '../../../etc/passwd.png' });
    run([node], { fromRel: 'docs/guide/setup.md' });
    const text = node.children[0];
    expect(text).toMatchObject({
      type: 'text',
      value: 'Image not found: passwd.png (docs/guide/../../../etc/passwd.png)',
    });
    expect(node.properties.title).toBe('docs/guide/../../../etc/passwd.png');
  });

  it('replaces a non-whitelisted format, heic included', () => {
    const heic = img({ src: 'IMG_0001.heic' });
    const scan = run([heic]);
    expect(heic.tagName).toBe('span');
    // Nothing was requested for it — the whitelist is shared with the route,
    // so an image the route would refuse never becomes a request.
    expect(scan.rels).toEqual([]);
  });

  /**
   * THE ESCAPING IS STRUCTURAL, AND THIS IS WHAT PINS IT. The filename and the
   * path come from a document the user may not have written. They are carried
   * as a hast TEXT node and as a plain `title` property — never as a `raw`
   * node, which is the one shape rehype-raw would parse as markup. React then
   * escapes both on its way to the DOM.
   */
  it('carries a hostile filename as text, never as markup', () => {
    // `.heic` so it takes the placeholder path — a hostile name with a
    // whitelisted extension is a perfectly ordinary local image (see below).
    const evil = '<img src=x onerror=alert(1)>.heic';
    const node = img({ src: `./${evil}` });
    run([node], { fromRel: 'a.md' });
    const child = node.children[0];
    expect(child).toBeDefined();
    expect(child?.type).toBe('text');
    expect(child).not.toMatchObject({ type: 'raw' });
    expect((child as { value: string }).value).toContain(evil);
    expect(node.properties.title).toContain(evil);
    // Exactly one child and no nested elements — nothing was parsed into a
    // real <img>.
    expect(node.children).toHaveLength(1);
  });

  it('a hostile filename that IS servable ends up percent-encoded in the URL', () => {
    // The other half of the same worry. `<` and `>` are legal in a POSIX
    // filename, so this file may really exist; the defence is encoding, not
    // refusal.
    const node = img({ src: './<img src=x onerror=alert(1)>.png' });
    run([node], { fromRel: 'a.md' });
    expect(node.tagName).toBe('img');
    const src = String(node.properties.src);
    expect(src).not.toContain('<');
    expect(src).not.toContain('>');
    expect(src).toContain('%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E.png');
  });
});

describe('rehypeMarkdownImages — the scan it hands back', () => {
  it('collects distinct local paths and counts the unresolved', () => {
    const scan = run([
      img({ src: 'a.png' }),
      img({ src: './a.png' }), // the same file, written differently
      img({ src: '../b.webp' }),
      img({ src: 'https://example.com/c.png' }),
      img({ src: '/etc/passwd.png' }),
      img({ src: 'nope.heic' }),
    ]);
    expect(scan.rels).toEqual(['docs/guide/a.png', 'docs/b.webp']);
    expect(scan.missing).toBe(2);
  });

  it('is refilled from scratch, so a second pass does not double-count', () => {
    // The host holds this object in a ref and the plugin runs inside render —
    // StrictMode renders twice, and a scan that accumulated would report every
    // image twice and probe it twice.
    const scan: MarkdownImageScan = { rels: [], missing: 0 };
    const nodes = () => [img({ src: 'a.png' }), img({ src: 'bad.heic' })];
    run(nodes(), { scan });
    run(nodes(), { scan });
    expect(scan.rels).toEqual(['docs/guide/a.png']);
    expect(scan.missing).toBe(1);
  });
});
