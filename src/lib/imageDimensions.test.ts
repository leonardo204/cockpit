import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyExifOrientation,
  createDimensionCache,
  dimensionCacheKey,
  probeImageSize,
} from './imageDimensions';

/**
 * Two properties matter here, and both fail SILENTLY if they regress.
 *
 *   1. A rotated phone photo's dimensions are transposed. Injecting the stored
 *      pair for one of those reserves a landscape box for a portrait picture,
 *      which reflows worse than injecting nothing at all — a wrong answer is
 *      not a smaller version of no answer.
 *   2. A cache entry dies when its file changes. There is no watcher; the key
 *      is the invalidation, and a stale hit means the reader gets a box the
 *      wrong shape for the picture that arrives in it.
 */

const root = mkdtempSync(join(tmpdir(), 'naby-imgdim-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/**
 * A PNG that is nothing but a valid signature and an IHDR chunk. Header probing
 * never reads past this, which is precisely the property being relied on: the
 * viewer must be able to lay out a 40 MB screenshot without pulling 40 MB.
 */
function writePng(path: string, width: number, height: number): void {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8; // bit depth
  ihdr[17] = 6; // colour type: RGBA
  writeFileSync(path, Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), ihdr]));
}

describe('applyExifOrientation', () => {
  it('leaves an upright or mirrored photo alone — a mirror does not change the box', () => {
    for (const orientation of [undefined, 1, 2, 3, 4]) {
      expect(applyExifOrientation(4032, 3024, orientation)).toEqual({
        width: 4032,
        height: 3024,
      });
    }
  });

  it('TRANSPOSES orientations 5-8, which are quarter turns', () => {
    for (const orientation of [5, 6, 7, 8]) {
      expect(applyExifOrientation(4032, 3024, orientation)).toEqual({
        width: 3024,
        height: 4032,
      });
    }
  });

  it('treats an out-of-range tag as upright rather than guessing', () => {
    expect(applyExifOrientation(100, 50, 0)).toEqual({ width: 100, height: 50 });
    expect(applyExifOrientation(100, 50, 9)).toEqual({ width: 100, height: 50 });
  });
});

describe('dimensionCacheKey', () => {
  it('changes when either the mtime or the byte length changes', () => {
    const base = dimensionCacheKey('/p/a.png', 1000, 512);
    expect(dimensionCacheKey('/p/a.png', 1000, 512)).toBe(base);
    expect(dimensionCacheKey('/p/a.png', 1001, 512)).not.toBe(base);
    expect(dimensionCacheKey('/p/a.png', 1000, 513)).not.toBe(base);
    expect(dimensionCacheKey('/p/b.png', 1000, 512)).not.toBe(base);
  });

  it('floors the mtime, so float noise is not a permanent miss', () => {
    expect(dimensionCacheKey('/p/a.png', 1000.4, 512)).toBe(
      dimensionCacheKey('/p/a.png', 1000.9, 512),
    );
  });
});

describe('createDimensionCache', () => {
  it('distinguishes "never probed" from "probed and unknown"', () => {
    const cache = createDimensionCache(4);
    expect(cache.get('a')).toBeUndefined();
    cache.set('a', null);
    // Without this distinction a broken image is re-opened on every render of
    // the document, forever.
    expect(cache.get('a')).toBeNull();
  });

  it('evicts the least recently used once it is full', () => {
    const cache = createDimensionCache(2);
    cache.set('a', { width: 1, height: 1 });
    cache.set('b', { width: 2, height: 2 });
    // Touch 'a' so 'b' becomes the oldest.
    expect(cache.get('a')).toEqual({ width: 1, height: 1 });
    cache.set('c', { width: 3, height: 3 });
    expect(cache.size).toBe(2);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toEqual({ width: 1, height: 1 });
    expect(cache.get('c')).toEqual({ width: 3, height: 3 });
  });

  it('never grows past its bound', () => {
    const cache = createDimensionCache(3);
    for (let i = 0; i < 100; i++) cache.set(`k${i}`, { width: i, height: i });
    expect(cache.size).toBe(3);
  });
});

describe('probeImageSize', () => {
  const png = join(root, 'shot.png');
  beforeAll(() => writePng(png, 1920, 1080));

  it('reads the intrinsic size out of the header', async () => {
    await expect(probeImageSize(png)).resolves.toEqual({ width: 1920, height: 1080 });
  });

  it('answers null rather than throwing for anything it cannot read', async () => {
    const notThere = join(root, 'ghost.png');
    const notAnImage = join(root, 'notes.png');
    writeFileSync(notAnImage, 'this is not a png');
    // A failure here must be a VALUE: the contract of the whole feature is that
    // an image with unknown dimensions still renders.
    await expect(probeImageSize(notThere)).resolves.toBeNull();
    await expect(probeImageSize(notAnImage)).resolves.toBeNull();
    await expect(probeImageSize(root)).resolves.toBeNull();
  });

  it('rejects a zero dimension — a width="0" hint is worse than none', async () => {
    const degenerate = join(root, 'zero.png');
    writePng(degenerate, 0, 0);
    await expect(probeImageSize(degenerate)).resolves.toBeNull();
  });
});
