import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NabyAvatar } from './NabyAvatar';
import * as sharedUi from './index';

/**
 * naby's avatar (multi-agent-chat MAC-M3b). Rendered statically — there is no
 * DOM harness in this repo — so these pin the markup: an accessible SVG, the
 * size prop, the theme hooks (brand gradient, currentColor) and unique gradient
 * ids so two avatars on one page do not share (and break) one `<defs>`.
 */
describe('NabyAvatar', () => {
  it('renders an accessible svg named 나비', () => {
    const html = renderToStaticMarkup(<NabyAvatar />);
    expect(html.startsWith('<svg')).toBe(true);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="나비"');
    expect(html).toContain('data-naby-avatar');
    expect(html).toContain('viewBox="0 0 40 40"');
  });

  it.each([20, 28, 40])('takes its size in px (%i)', (size) => {
    const html = renderToStaticMarkup(<NabyAvatar size={size} />);
    expect(html).toContain(`width="${size}"`);
    expect(html).toContain(`height="${size}"`);
    expect(html).toContain(`width:${size}px;height:${size}px`);
  });

  it('defaults to 28 px', () => {
    expect(renderToStaticMarkup(<NabyAvatar />)).toContain('width="28"');
  });

  it('follows the theme: brand gradient wings and currentColor ink', () => {
    const html = renderToStaticMarkup(<NabyAvatar />);
    expect(html).toContain('stop-color:hsl(var(--brand, 252 100% 65%))');
    expect(html).toContain('stop-color:hsl(var(--brand-2, 255 100% 74%))');
    expect(html).toContain('stroke="currentColor"');
    expect(html).toContain('color:hsl(var(--violet-12');
  });

  it('draws a disc by default and none when bare', () => {
    const disc = 'hsl(var(--accent, 254 100% 96%))';
    expect(renderToStaticMarkup(<NabyAvatar />)).toContain(disc);
    expect(renderToStaticMarkup(<NabyAvatar bare />)).not.toContain(disc);
  });

  it('gives each instance its own gradient id, safe inside url(#…)', () => {
    const html = renderToStaticMarkup(
      <>
        <NabyAvatar />
        <NabyAvatar />
      </>,
    );
    const ids = [...html.matchAll(/<linearGradient id="([^"]+)"/g)].map((m) => m[1]!);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) {
      expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
      expect(html).toContain(`url(#${id})`);
    }
  });

  it('pulses when speaking, and passes title and className through', () => {
    const html = renderToStaticMarkup(<NabyAvatar speaking title="나비" className="mt-0.5" />);
    expect(html).toContain('participant-speaking');
    expect(html).toContain('<title>나비</title>');
    expect(html).toContain('mt-0.5');
    expect(renderToStaticMarkup(<NabyAvatar />)).not.toContain('participant-speaking');
  });

  it('is exported from the package index', () => {
    expect(sharedUi.NabyAvatar).toBe(NabyAvatar);
    expect(readFileSync(join(__dirname, 'index.ts'), 'utf8')).toContain("from './NabyAvatar'");
  });
});
