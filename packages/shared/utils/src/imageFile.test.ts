import { describe, it, expect } from 'vitest';
import { IMAGE_MIME_TYPES, imageMediaType, isImageFile } from './imageFile';

/**
 * The whitelist is a security boundary as much as a rendering one — it is what
 * stops /api/fs-image from being asked for `.env` — so the refusals are pinned
 * as hard as the acceptances.
 */
describe('imageMediaType', () => {
  it('maps every whitelisted extension to its content type', () => {
    expect(imageMediaType('diagram.png')).toBe('image/png');
    expect(imageMediaType('photo.jpg')).toBe('image/jpeg');
    expect(imageMediaType('photo.jpeg')).toBe('image/jpeg');
    expect(imageMediaType('scan.jfif')).toBe('image/jpeg');
    expect(imageMediaType('anim.gif')).toBe('image/gif');
    expect(imageMediaType('logo.svg')).toBe('image/svg+xml');
    expect(imageMediaType('shot.webp')).toBe('image/webp');
    expect(imageMediaType('old.bmp')).toBe('image/bmp');
    expect(imageMediaType('page.tiff')).toBe('image/tiff');
    expect(imageMediaType('page.tif')).toBe('image/tiff');
    expect(imageMediaType('next.avif')).toBe('image/avif');
    expect(imageMediaType('favicon.ico')).toBe('image/x-icon');
  });

  it('is case-insensitive and reads the basename of a path', () => {
    expect(imageMediaType('README.PNG')).toBe('image/png');
    expect(imageMediaType('docs/img/Chart.JPEG')).toBe('image/jpeg');
    expect(imageMediaType('docs\\img\\Chart.Gif')).toBe('image/gif');
  });

  /**
   * The whole reason heic/heif are not in the map: Chromium cannot decode them,
   * so whitelisting one would render a blank frame instead of a placeholder
   * that says what happened. This test is the guard against someone "fixing"
   * the list by copying the reference editor's WebKit-era one.
   */
  it('refuses heic and heif, which Chromium cannot decode', () => {
    expect(imageMediaType('IMG_0001.heic')).toBeNull();
    expect(imageMediaType('IMG_0001.HEIC')).toBeNull();
    expect(imageMediaType('burst.heif')).toBeNull();
    expect(IMAGE_MIME_TYPES['heic']).toBeUndefined();
    expect(IMAGE_MIME_TYPES['heif']).toBeUndefined();
  });

  it('refuses non-images, extensionless names and dotfiles', () => {
    expect(imageMediaType('notes.md')).toBeNull();
    expect(imageMediaType('.env')).toBeNull();
    expect(imageMediaType('.png')).toBeNull();
    expect(imageMediaType('Makefile')).toBeNull();
    expect(imageMediaType('')).toBeNull();
    expect(imageMediaType('archive.png.gz')).toBeNull();
  });

  it('isImageFile agrees with imageMediaType', () => {
    expect(isImageFile('a.webp')).toBe(true);
    expect(isImageFile('a.heic')).toBe(false);
  });
});
