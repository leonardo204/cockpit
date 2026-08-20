import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * How the viewer and the image rewriter are joined together.
 *
 * SOURCE ASSERTIONS, because there is no component-render harness in this repo
 * (see the header of markdownPreviewOps.ts) and because every rule below is a
 * property of the WIRING rather than of any function: each one produces a
 * working-looking build in which images silently never get measured. They are
 * cheap to state and impossible to observe any other way.
 */

const DIR = __dirname;
// The VIEWER, not its window. The modal was split when the same viewer had to
// serve a tab as well (MarkdownDocument's header explains why there is only
// one); every rule below belongs to the reading pane, which moved with it.
const MODAL = readFileSync(join(DIR, 'MarkdownDocument.tsx'), 'utf8');

describe('markdown preview — the image scan survives the memo', () => {
  /**
   * The rewriter runs inside ReactMarkdown's render and writes what it found
   * into an object captured ONCE by `imageOptions`. Replacing `scanRef.current`
   * with a fresh object on each document would leave the rewriter filling the
   * old one while the probe effect read the new, empty one — the images would
   * render, nothing would ever be probed, and no document would reserve a box.
   * The symptom is a preview that looks right and jumps as you scroll.
   */
  it('clears the scan IN PLACE and never reassigns the ref', () => {
    expect(MODAL).toContain('scanRef.current.rels = []');
    expect(MODAL).toContain('scanRef.current.missing = 0');
    expect(MODAL).not.toMatch(/scanRef\.current\s*=\s*\{/);
  });

  it('hands the rewriter the ref object, not a copy of it', () => {
    expect(MODAL).toContain('scan: scanRef.current');
  });
});

describe('markdown preview — images resolve from the document being read', () => {
  /**
   * The viewer navigates between markdown files, so the base directory moves.
   * Passing the `rel` the modal was OPENED with would resolve `./diagram.png`
   * from the first document forever, and images would break the moment a reader
   * followed a link into a subdirectory — while the links themselves kept
   * working, which is the confusing half.
   */
  it('passes the currently viewed document as the resolution base', () => {
    expect(MODAL).toContain('fromRel: current');
    expect(MODAL).not.toContain('fromRel: rel');
  });
});

describe('markdown preview — the probe terminates', () => {
  /**
   * `sizes` is both a dependency of the probe effect and what it writes. The
   * loop closes only because every requested rel comes back with a key, even
   * when the request fails outright: a rel with no key reads as "not probed
   * yet" and would be asked for again on the next render, and the next, at one
   * request per render forever.
   */
  it('pre-fills a null answer for every rel before the request is made', () => {
    expect(MODAL).toMatch(/const blank: SizeMap = \{\};\s*\n\s*for \(const rel of rels\) blank\[rel\] = null;/);
    // Every early return in probeImageSizes hands back that same full map.
    const fn = /async function probeImageSizes[\s\S]*?\n\}/.exec(MODAL)?.[0] ?? '';
    expect(fn).toBeTruthy();
    expect(fn).not.toMatch(/return\s*\{\s*\}/);
    expect((fn.match(/return blank;/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('only asks about rels it has no answer for', () => {
    expect(MODAL).toContain("scan.rels.filter((rel) => !(rel in sizes))");
    expect(MODAL).toContain('if (pending.length === 0) return;');
  });

  it('asks in ONE batch per document, not once per image', () => {
    // Fifty screenshots would otherwise open fifty connections before the
    // document could lay itself out.
    expect(MODAL).toContain("fetch('/api/fs-image'");
    expect(MODAL).toContain('JSON.stringify({ cwd, rels })');
  });
});

describe('markdown preview — unresolved images are reported, not hidden', () => {
  it('surfaces the count in the status line', () => {
    expect(MODAL).toContain("t('markdownPreview.imagesUnresolved'");
    expect(MODAL).toContain('unresolved > 0');
  });

  it('gives the rewriter a localised prefix for the placeholder', () => {
    expect(MODAL).toContain("missingPrefix: t('markdownPreview.imageMissing')");
  });
});
