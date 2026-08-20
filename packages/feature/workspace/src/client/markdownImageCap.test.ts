import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IMAGE_MAX_WIDTH_PX } from './markdownPreviewOps';

/**
 * The reading-width cap lives in two places by necessity — CSS applies it, and
 * TypeScript measures the 2x "promote instead of shrink" rule against it — and
 * only source can show that the two still agree. jsdom has no layout, so a
 * mounted test cannot see a drift; the same reason sidebarPopoverClipping and
 * messageBubbleStretch are source assertions (see shell/CLAUDE.md).
 *
 * If they drift, images between the two numbers are shrunk by one rule while
 * the other still calls them ordinary — visible only to the eye, and only on
 * documents nobody thought to check.
 */

const DIR = __dirname;
const GLOBALS = join(DIR, '..', '..', '..', '..', '..', 'src', 'app', 'globals.css');
const RENDERER = join(
  DIR, '..', '..', '..', '..', 'shared', 'ui', 'src', 'MarkdownRenderer.tsx',
);

describe('markdown image cap — CSS and TypeScript agree', () => {
  const css = readFileSync(GLOBALS, 'utf8');

  it('--md-img-max-width is IMAGE_MAX_WIDTH_PX', () => {
    const declared = /--md-img-max-width:\s*(\d+)px/.exec(css)?.[1];
    expect(declared, '--md-img-max-width is missing from globals.css').toBeDefined();
    expect(Number(declared)).toBe(IMAGE_MAX_WIDTH_PX);
  });

  it('the cap is applied by CSS, and the wide class lifts it to the pane', () => {
    expect(css).toMatch(/\.md-img\s*\{[^}]*max-width:\s*var\(--md-img-max-width\)/);
    expect(css).toMatch(/\.md-img\.md-img-wide\s*\{[^}]*max-width:\s*100%/);
  });

  /**
   * MANDATORY WHEREVER DIMENSIONS ARE INJECTED. The injected height is the
   * intrinsic one; the moment max-width shrinks the image, a fixed height
   * attribute holds the old value and the aspect ratio breaks. Scoped to the
   * attribute PAIR exactly, so an author who wrote raw `<img height="28">`
   * still wins through MarkdownRenderer's inline-style branch.
   */
  it('img[width][height] is released to height:auto', () => {
    expect(css).toMatch(/img\[width\]\[height\]\s*\{\s*height:\s*auto/);
  });

  it('nothing in this feature resamples, thumbnails or inlines an image', () => {
    // The cap is CSS and the bytes are a URL. Base64-inlining was measured by
    // the reference editor at 358 KB → 3.7 MB for a 56-image document, and it
    // bypasses the engine's image cache entirely.
    expect(css).not.toMatch(/md-img[^}]*image-rendering:\s*pixelated/);
  });
});

describe('MarkdownRenderer — viewer-owned images are sized by CSS, not by pixels', () => {
  const src = readFileSync(RENDERER, 'utf8');

  it('branches on data-md-image before the raw-HTML explicit-size branch', () => {
    const ownedAt = src.indexOf("'data-md-image'");
    const explicitAt = src.indexOf('const hasExplicitSize');
    expect(ownedAt).toBeGreaterThan(-1);
    // Order matters: injected intrinsic dimensions would otherwise fall into
    // the raw-HTML branch and be pinned as inline pixels, freezing every
    // diagram at its full width with a broken aspect ratio.
    expect(ownedAt).toBeLessThan(explicitAt);
  });

  it('passes the class the CSS cap is written against', () => {
    expect(src).toContain("'md-img md-img-wide'");
    expect(src).toContain("'md-img'");
  });
});
