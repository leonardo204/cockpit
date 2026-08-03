import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The toast's shape, asserted against the source.
 *
 * Source assertions rather than rendering ones, following the
 * `settingsLayout` / `toolCallSurface` precedent: every fact here is layout,
 * animation or class naming, and jsdom has no layout engine — a mounted test
 * would happily "see" a toast the browser paints in the wrong corner, at the
 * wrong width, with no shadow.
 *
 * WHAT THIS FILE DEFENDS. The toast used to be a SOLID COLORED BANNER: a
 * `bg-green-9` / `bg-red-9` / `bg-brand` fill with white text, pinned to the top
 * center, gone after 3s with no way to dismiss it and no cap on the stack. It
 * read as an alert bar bolted onto the app rather than as part of it. The
 * contract that replaced it:
 *
 *   1. The surface is the same card every other floating panel uses —
 *      `bg-popover` + `border-border` + `rounded-lg` — and the message is
 *      `text-foreground`. Status is carried by the ICON ALONE. No fill, no
 *      white-on-color.
 *   2. It lives in the bottom-right corner and stacks upward, capped at 3.
 *   3. The message is written as TEXT. It is regularly an interpolated server
 *      error and the i18n singleton runs with `escapeValue: false`, so
 *      `innerHTML` was a markup-injection path.
 *   4. Hover pauses the auto-dismiss.
 *
 * Rule 1 is the one that will rot: "make the error one red" is a one-line diff
 * and the class names are still in the stylesheet. Rule 3 is the one that
 * matters most, so it is asserted twice — that the message goes through
 * `textContent`, and that no template placeholder is left inside an
 * `innerHTML` string.
 */

const DIR = __dirname;

/**
 * A source file with its comments removed.
 *
 * Every assertion here is about class names and API calls, and this file's
 * subject explains at length which class names were TAKEN AWAY — so a naive
 * scan reads `bg-green-9` in a comment and fails the test that checks there is
 * no green fill. Block comments and whole-line `//` comments are dropped;
 * trailing `//` is left alone so a URL is never truncated.
 */
const read = (f: string) =>
  readFileSync(join(DIR, f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

/** Just the `toast()` function — the confirm dialog above it is a separate surface. */
const toastFn = () => {
  const src = read('Toast.tsx');
  const start = src.indexOf('export function toast(');
  expect(start).toBeGreaterThan(-1);
  return src.slice(start);
};

describe('toast surface', () => {
  it('draws the shared popover card, not a solid status fill', () => {
    const src = toastFn();
    expect(src).toContain('bg-popover');
    expect(src).toContain('border border-border');
    expect(src).toContain('rounded-lg');
    expect(src).toContain('text-foreground');
  });

  it('has no solid color fill and no white-on-color text', () => {
    const src = read('Toast.tsx');
    const start = src.indexOf('export function toast(');
    // The confirm() dialog's buttons legitimately use bg-red-9 / text-white, so
    // the scan is scoped to the toast half of the file.
    const toastHalf = src.slice(start);
    expect(toastHalf).not.toContain('bg-green-9');
    expect(toastHalf).not.toContain('bg-red-9');
    expect(toastHalf).not.toContain('text-white');
    // The status colors that remain are on the ICON only.
    expect(toastHalf).not.toMatch(/class[^"']*=\s*["'][^"']*\bbg-brand\b/);
  });

  it('carries status on the icon alone, one per type', () => {
    const src = read('Toast.tsx');
    expect(src).toMatch(/success:\s*\{\s*className: 'text-brand'/);
    expect(src).toMatch(/error:\s*\{\s*className: 'text-destructive'/);
    expect(src).toMatch(/info:\s*\{\s*className: 'text-muted-foreground'/);
    // 18px leading icon, per the target spec.
    expect(toastFn()).toContain('w-[18px] h-[18px]');
  });

  it('anchors the stack bottom-right and grows upward', () => {
    const src = read('Toast.tsx');
    expect(src).toContain('fixed bottom-6 right-6');
    expect(src).toContain('flex-col-reverse');
    // Newest nearest the corner: with flex-col-reverse that means prepend.
    expect(src).toContain('container.prepend(el)');
    // The old anchor must be gone.
    expect(src).not.toContain('top-4 left-1/2');
  });

  it('keeps the container a click-through body singleton at z-[100]', () => {
    const src = read('Toast.tsx');
    expect(src).toContain('z-[100]');
    expect(src).toContain('pointer-events-none');
    expect(src).toContain('document.body.appendChild(toastContainer)');
    // Cards themselves must still take the pointer — hover-pause and the close
    // button depend on it.
    expect(toastFn()).toContain('pointer-events-auto');
  });

  it('writes the message as text, never as markup', () => {
    const src = toastFn();
    expect(src).toContain(
      `el.querySelector('[data-slot="message"]')!.textContent = message`
    );
    // No interpolation of caller data into any innerHTML string in this file.
    const innerHtmlAssignments = read('Toast.tsx').match(
      /innerHTML\s*=\s*`[\s\S]*?`/g
    );
    for (const block of innerHtmlAssignments ?? []) {
      expect(block).not.toContain('${message}');
      expect(block).not.toContain('${title}');
      expect(block).not.toContain('${confirmText}');
      expect(block).not.toContain('${cancelText}');
    }
  });

  it('pauses on hover and offers a close button', () => {
    const src = toastFn();
    expect(src).toContain(`addEventListener('mouseenter'`);
    expect(src).toContain(`addEventListener('mouseleave'`);
    expect(src).toContain('clearTimeout(timer)');
    // Subtle: revealed on hover, muted, never a permanent chrome element.
    expect(src).toContain('opacity-0');
    expect(src).toContain('group-hover:opacity-100');
    expect(src).toContain('text-muted-foreground');
  });

  it('caps the stack at three and dismisses the oldest immediately', () => {
    const src = read('Toast.tsx');
    expect(src).toMatch(/MAX_VISIBLE_TOASTS\s*=\s*3/);
    expect(src).toContain('while (stack.length > MAX_VISIBLE_TOASTS)');
  });

  it('uses the bottom-anchored animation pair, at the durations the CSS declares', () => {
    const src = read('Toast.tsx');
    expect(src).toMatch(/TOAST_DURATION_MS\s*=\s*4000/);
    expect(src).toMatch(/TOAST_ENTER_MS\s*=\s*350/);
    expect(src).toMatch(/TOAST_EXIT_MS\s*=\s*200/);
    expect(src).toContain('toastIn ');
    expect(src).toContain('toastOut ');
    // The top-edge keyframes are gone from the stylesheet; nothing may ask for them.
    expect(src).not.toContain('slideIn ');
    expect(src).not.toContain('slideOut ');
    expect(src).not.toContain('animate-slide-in');
  });

  it('gives every toast a unique id without leaning on the clock', () => {
    const src = read('Toast.tsx');
    expect(src).toContain('++toastSeq');
    expect(src).not.toContain('toast-${Date.now()}');
  });

  it('no longer ships the unused React provider', () => {
    const src = read('Toast.tsx');
    expect(src).not.toContain('ToastProvider');
    expect(src).not.toContain('useToast');
    expect(read('index.ts')).not.toContain('ToastProvider');
  });
});

describe('toast stylesheet', () => {
  const css = readFileSync(
    join(DIR, '../../../../src/app/globals.css'),
    'utf8'
  );

  it('declares the keyframes the component names', () => {
    expect(css).toContain('@keyframes toastIn');
    expect(css).toContain('@keyframes toastOut');
    expect(css).not.toContain('@keyframes slideIn {');
    expect(css).not.toContain('@keyframes slideOut {');
  });

  it('keeps slideInLeft, which belongs to SessionCompleteToast', () => {
    expect(css).toContain('@keyframes slideInLeft');
  });

  it('themes the one hardcoded value — the shadow — in both modes', () => {
    expect(css).toContain('.toast-surface');
    expect(css).toContain('.dark .toast-surface');
  });
});
