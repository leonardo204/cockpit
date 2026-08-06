import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  CHAT_SCALES,
  CODE_FONT_STACKS,
  DEFAULT_FONT_SETTINGS,
  FONTS_STORAGE_KEY,
  FONT_CSS_VARS,
  SERVER_FONT_VARS_GLOBAL,
  UI_FONT_STACKS,
  UI_SCALES,
  buildFontVarsScript,
  codeFontStack,
  fontCssVars,
  normalizeFontSettings,
  parseFontState,
  sanitizeFontFamily,
  serializeFontState,
  uiFontStack,
  type FontSettings,
} from './fontSettings';
import { buildBootScript } from './bootTheme';

/**
 * THE FOUR FONT KNOBS, pinned where they can actually be pinned.
 *
 * Same split as `bootTheme.test.ts`, and for the same reason: the derivation is
 * pure and gets real assertions, while the WIRING (a layout that reads
 * settings.json, a provider that writes localStorage, a bubble that carries the
 * scaling class) is asserted against the sources — there is no DOM here, and a
 * jsdom render has no layout engine to measure a font size with anyway.
 */

const ROOT = join(__dirname, '..', '..', '..', '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');

describe('sanitizeFontFamily', () => {
  it('keeps a real family name, in any script', () => {
    expect(sanitizeFontFamily('Pretendard Variable')).toBe('Pretendard Variable');
    expect(sanitizeFontFamily('나눔고딕')).toBe('나눔고딕');
    expect(sanitizeFontFamily('IBM Plex Sans KR')).toBe('IBM Plex Sans KR');
    expect(sanitizeFontFamily('SF_Mono-2')).toBe('SF_Mono-2');
  });

  it('strips the quotes and semicolons that would end the declaration', () => {
    // The value is interpolated into a CSS custom property; a surviving `;`
    // would let the input add a declaration of its own.
    expect(sanitizeFontFamily('"Inter"')).toBe('Inter');
    expect(sanitizeFontFamily("'Inter'")).toBe('Inter');
    expect(sanitizeFontFamily('Inter; color: red')).toBe('Inter color red');
    expect(sanitizeFontFamily('Inter}')).toBe('Inter');
  });

  it('strips URLs, so a family name can never fetch anything', () => {
    // Both halves: the parentheses that make `url()` a function, and the
    // punctuation that makes a URL a URL.
    expect(sanitizeFontFamily('url(http://evil.example/x.woff)')).toBe(
      'url http evil example x woff'
    );
    expect(sanitizeFontFamily('https://evil.example/f.css')).toBe('https evil example f css');
    for (const out of [
      sanitizeFontFamily('url(http://evil.example/x.woff)'),
      sanitizeFontFamily('https://evil.example/f.css'),
    ]) {
      expect(out).not.toContain('(');
      expect(out).not.toContain(':');
      expect(out).not.toContain('/');
    }
  });

  it('strips the angle brackets that could close the inlined <script>', () => {
    const out = sanitizeFontFamily('</script><script>alert(1)</script>');
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
  });

  it('strips commas, so one field cannot smuggle in a second family', () => {
    // Without this, "X, monospace" would silently prepend two families and the
    // "custom family first, system stack behind it" contract would be a lie.
    expect(sanitizeFontFamily('Inter, monospace')).toBe('Inter monospace');
  });

  it('caps the length and rejects non-strings', () => {
    expect(sanitizeFontFamily('a'.repeat(200))).toHaveLength(64);
    for (const bad of [null, undefined, 42, {}, ['Inter']]) {
      expect(sanitizeFontFamily(bad)).toBe('');
    }
  });
});

describe('normalizeFontSettings', () => {
  it('fills every field from the defaults when there is nothing stored', () => {
    expect(normalizeFontSettings(undefined)).toEqual(DEFAULT_FONT_SETTINGS);
    expect(normalizeFontSettings(null)).toEqual(DEFAULT_FONT_SETTINGS);
    expect(normalizeFontSettings('dark')).toEqual(DEFAULT_FONT_SETTINGS);
  });

  it('repairs a half-written or hand-edited object field by field', () => {
    // settings.json is hand-editable, so one bad field must not cost the others.
    const out = normalizeFontSettings({
      uiFont: 'pretendard',
      scale: 999,
      chatScale: 110,
      codeFont: 'comic-sans',
    });
    expect(out.uiFont).toBe('pretendard');
    expect(out.scale).toBe(DEFAULT_FONT_SETTINGS.scale);
    expect(out.chatScale).toBe(110);
    expect(out.codeFont).toBe(DEFAULT_FONT_SETTINGS.codeFont);
  });

  it('accepts exactly the offered scales, and nothing between them', () => {
    for (const s of UI_SCALES) expect(normalizeFontSettings({ scale: s }).scale).toBe(s);
    for (const s of CHAT_SCALES) expect(normalizeFontSettings({ chatScale: s }).chatScale).toBe(s);
    // 105 is not offered by the UI, so it can only come from a hand edit.
    expect(normalizeFontSettings({ scale: 105 }).scale).toBe(100);
    // …and the chat scale deliberately stops below the global one: the two
    // multiply, so 150 × 150 would be 225% of the base size.
    expect(CHAT_SCALES).not.toContain(150);
  });

  it('sanitizes the custom families on the way in', () => {
    expect(normalizeFontSettings({ uiFontCustom: '"Inter"; x' }).uiFontCustom).toBe('Inter x');
  });
});

describe('the stacks fall back rather than failing', () => {
  it('puts a custom family FIRST and keeps the system stack behind it', () => {
    // No font files are bundled and a typo is likelier than a hit, so an
    // unavailable name must degrade to the system faces rather than to the
    // browser's default serif.
    const stack = uiFontStack({ ...DEFAULT_FONT_SETTINGS, uiFont: 'custom', uiFontCustom: 'My Face' });
    expect(stack.startsWith('"My Face", ')).toBe(true);
    expect(stack.endsWith(UI_FONT_STACKS.system)).toBe(true);
  });

  it('ignores a custom preset with nothing typed into it yet', () => {
    const settings: FontSettings = { ...DEFAULT_FONT_SETTINGS, uiFont: 'custom', uiFontCustom: '' };
    expect(uiFontStack(settings)).toBe(UI_FONT_STACKS.system);
    expect(codeFontStack({ ...settings, codeFont: 'custom', codeFontCustom: '   ' })).toBe(
      CODE_FONT_STACKS['system-mono']
    );
  });

  it('offers the prefer-if-installed presets as STACKS, never as one name', () => {
    // The whole "we bundle nothing" promise lives in these tails.
    expect(UI_FONT_STACKS.pretendard).toContain('Pretendard');
    expect(UI_FONT_STACKS.pretendard).toContain('sans-serif');
    expect(UI_FONT_STACKS['noto-sans-kr']).toContain('"Noto Sans KR"');
    expect(UI_FONT_STACKS['noto-sans-kr']).toContain('sans-serif');
    expect(CODE_FONT_STACKS['jetbrains-mono']).toContain('monospace');
    expect(CODE_FONT_STACKS['fira-code']).toContain('monospace');
  });
});

describe('fontCssVars', () => {
  it('emits the four variables and nothing else', () => {
    expect(Object.keys(fontCssVars(DEFAULT_FONT_SETTINGS)).sort()).toEqual([...FONT_CSS_VARS].sort());
  });

  it('emits the scales as UNITLESS MULTIPLIERS', () => {
    // Not sizes: one multiplies the root font-size (so every rem in the app
    // follows), the other multiplies an em inside the message wrapper.
    const vars = fontCssVars({ ...DEFAULT_FONT_SETTINGS, scale: 125, chatScale: 110 });
    expect(vars['--app-font-scale']).toBe('1.25');
    expect(vars['--chat-text-scale']).toBe('1.1');
    expect(vars['--app-font-scale']).not.toMatch(/[a-z%]/);
    expect(vars['--chat-text-scale']).not.toMatch(/[a-z%]/);
  });

  it('leaves the chat scale INDEPENDENT of the global one', () => {
    // THE COMPOSITION CONTRACT, in the only place it can be asserted without a
    // layout engine: changing the global scale must not change the chat
    // variable, because the multiplication happens in CSS (`calc(1em * …)` on a
    // wrapper that has already inherited the scaled root). If this file ever
    // pre-multiplied them, a user who set chat to 110% would find it jumping to
    // 137% the moment they touched the global control.
    const at100 = fontCssVars({ ...DEFAULT_FONT_SETTINGS, scale: 100, chatScale: 110 });
    const at150 = fontCssVars({ ...DEFAULT_FONT_SETTINGS, scale: 150, chatScale: 110 });
    expect(at100['--chat-text-scale']).toBe(at150['--chat-text-scale']);
    expect(at150['--app-font-scale']).toBe('1.5');
  });

  it('is what globals.css multiplies, in both places', () => {
    const css = read('src', 'app', 'globals.css');
    // The root scale, applied to the ONE font-size everything else is relative to.
    expect(css).toContain('font-size: calc(14px * var(--app-font-scale, 1));');
    // The chat scale, in em so it composes with the root scale above.
    expect(css).toContain('.chat-content {');
    expect(css).toContain('font-size: calc(1em * var(--chat-text-scale, 1));');
    // The families reach the app through Tailwind's own theme, so `font-sans` /
    // `font-mono` (and its preflight on code/pre/kbd/samp) follow the setting.
    expect(css).toContain('--font-sans: var(--app-font-sans);');
    expect(css).toContain('--font-mono: var(--app-font-mono);');
    expect(css).toContain('font-family: var(--app-font-sans);');
    // The defaults declared in CSS have to agree with the defaults in TS, or the
    // app renders one thing before the boot script runs and another after.
    for (const name of FONT_CSS_VARS) expect(css).toContain(`${name}:`);
  });
});

describe('the settings survive a round trip', () => {
  const settings: FontSettings = {
    uiFont: 'custom',
    uiFontCustom: 'Apple SD Gothic Neo',
    scale: 125,
    chatScale: 90,
    codeFont: 'fira-code',
    codeFontCustom: '',
  };

  it('through settings.json, which is the copy that survives a restart', () => {
    // The shell boots on a new port every launch, so localStorage is empty and
    // this is the only copy left. JSON in, JSON out, same object.
    const file = JSON.parse(JSON.stringify({ [FONTS_STORAGE_KEY]: settings })) as Record<
      string,
      unknown
    >;
    expect(normalizeFontSettings(file[FONTS_STORAGE_KEY])).toEqual(settings);
  });

  it('through localStorage, which also carries the derived vars', () => {
    // Both halves, because they have different readers: boot.js needs the vars
    // (and must not carry a font table to derive them), the provider needs the
    // settings.
    const raw = serializeFontState(settings);
    expect(parseFontState(raw)).toEqual(settings);
    const parsed = JSON.parse(raw) as { vars: Record<string, string> };
    expect(parsed.vars).toEqual(fontCssVars(settings));
  });

  it('and returns nothing at all for absent or corrupt storage', () => {
    // Undefined, not the defaults: the caller falls through to the SERVER value,
    // which is the one that outlives the origin.
    expect(parseFontState(null)).toBeUndefined();
    expect(parseFontState('')).toBeUndefined();
    expect(parseFontState('{oops')).toBeUndefined();
    expect(parseFontState('{"v":1}')).toBeUndefined();
  });
});

describe('the boot script injection', () => {
  it('writes the derived vars into the global boot.js reads', () => {
    const script = buildFontVarsScript(fontCssVars(DEFAULT_FONT_SETTINGS));
    expect(script.startsWith(`window.${SERVER_FONT_VARS_GLOBAL}=`)).toBe(true);
    expect(script).toContain('--app-font-sans');
  });

  it('cannot break out of the inlined <script> tag', () => {
    // Two layers: the sanitizer drops `<` from a hand-edited family name, and
    // the emitter escapes it anyway.
    const hostile = normalizeFontSettings({
      uiFont: 'custom',
      uiFontCustom: '</script><script>alert(1)</script>',
    });
    const out = buildBootScript('BOOT();', 'dark', fontCssVars(hostile));
    expect(out).not.toContain('</script>');
    expect(out).not.toContain('<script');
  });

  it('rides along with the theme, and adds nothing when there is nothing to add', () => {
    const out = buildBootScript('BOOT();', 'light', fontCssVars(DEFAULT_FONT_SETTINGS));
    expect(out).toContain('window.__cockpitServerTheme="light";');
    expect(out).toContain(`window.${SERVER_FONT_VARS_GLOBAL}=`);
    expect(out.endsWith('BOOT();')).toBe(true);
    // A caller with no font state emits the one-line prefix it always did.
    expect(buildBootScript('BOOT();', 'light')).toBe('window.__cockpitServerTheme="light";\nBOOT();');
  });

  it('boot.js applies them before first paint, from a whitelist', () => {
    const boot = read('public', 'boot.js');
    expect(boot).toContain(`window.${SERVER_FONT_VARS_GLOBAL}`);
    expect(boot).toContain(`localStorage.getItem('${FONTS_STORAGE_KEY}')`);
    expect(boot).toContain('document.documentElement.style.setProperty');
    // Named properties only: a corrupt storage entry cannot set an arbitrary one.
    for (const name of FONT_CSS_VARS) expect(boot).toContain(`'${name}'`);
  });
});

describe('the persistence chain is actually wired', () => {
  it('the root layout reads settings.json server-side and injects both', () => {
    const layout = read('src', 'app', 'layout.tsx');
    expect(layout).toContain('normalizeFontSettings(parsed[FONTS_STORAGE_KEY])');
    expect(layout).toContain('fontCssVars(storedFonts)');
    // …and hands the same value to React, so the first render agrees with what
    // boot.js already wrote onto <html>.
    expect(layout).toContain('initialFonts={storedFonts}');
    // THE FONT VARIABLES HAVE TO BE ON <html>. `--app-font-sans` is declared on
    // `:root` and references `--font-inter`; a custom property is substituted
    // against the element it is declared on, so with the Next font class left on
    // <body> the whole UI font-family would resolve to nothing.
    const htmlTag = layout.slice(layout.indexOf('<html'), layout.indexOf('<head'));
    expect(htmlTag).toContain('inter.variable');
    expect(htmlTag).toContain('jetbrainsMono.variable');
  });

  it('font changes are written to the settings file, not just localStorage', () => {
    const providers = read('packages', 'feature', 'workspace', 'src', 'client', 'Providers.tsx');
    expect(providers).toContain('saveSettings({ fonts })');
    expect(providers).toContain('persistFonts={persistFonts}');
    expect(providers).toContain('initialFonts={initialFonts}');
  });

  it('the provider keeps localStorage as the synchronous fast path', () => {
    const provider = read('packages', 'shared', 'ui', 'src', 'FontProvider.tsx');
    expect(provider).toContain('localStorage.setItem(FONTS_STORAGE_KEY, serializeFontState(next))');
    // Precedence on mount, same as the theme's: localStorage → server → defaults.
    expect(provider).toContain('parseFontState(raw) ?? initialFonts ?? DEFAULT_FONT_SETTINGS');
  });

  it('reaches the project iframes the way the theme does', () => {
    // Panels are iframes with their own documents, so variables set on this
    // frame's <html> do not reach them. Mirrored on receipt, never re-persisted:
    // the originating frame already wrote the file.
    const provider = read('packages', 'shared', 'ui', 'src', 'FontProvider.tsx');
    expect(provider).toContain("postMessage({ type: 'FONT_CHANGE', fonts: next }, '*')");
    expect(provider).toContain("event.data?.type !== 'FONT_CHANGE'");
    const handler = provider.slice(provider.indexOf("event.data?.type !== 'FONT_CHANGE'"));
    expect(handler).not.toContain('persistFonts');
  });
});

/**
 * THE GLOBAL SCALE'S ONE BLIND SPOT, closed and kept closed.
 *
 * The size knob works by multiplying the ROOT font size, which reaches every
 * Tailwind `text-*` class because those are all rem-based. It does not reach an
 * ARBITRARY PX VALUE — `text-[10px]` is 10px at 90% and 10px at 150% — and the
 * audit for this feature found 184 of them across 33 client files, almost all
 * the micro-captions on settings panels, growth rows and tool bubbles. At 150%
 * that is a hundred labels staying put while the text around them grows, i.e.
 * exactly the "some of it resizes" failure that makes a 200% claim untrue.
 *
 * They were converted to their rem equivalents at the app's 14px root
 * (10px → 0.714rem = 9.996px, 11px → 0.786rem, and so on), so nothing moved at
 * 100% and everything moves together everywhere else. This test is the guard: a
 * new `text-[13px]` is a control the size setting silently does not cover.
 */
describe('no arbitrary px type size escapes the global scale', () => {
  const CLIENT_ROOTS = [join(ROOT, 'packages'), join(ROOT, 'src')];

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  /**
   * THE BUG THIS FEATURE WALKED INTO, and the reason the rule above can be
   * trusted at all.
   *
   * `MarkdownRenderer.tsx` masked code blocks with a sentinel built from a RAW
   * NUL BYTE, so every byte-oriented tool classified the file as binary: git
   * printed `Bin` instead of a diff, grep silently matched nothing in it, and —
   * the expensive one — Tailwind's class extractor skipped it entirely. The
   * `text-[1.25em]` sizes added here for the chat scale were therefore never
   * generated, and the chat headings quietly collapsed to a single size. The
   * sentinel is now written as a `\u0000` escape: identical to the runtime, plain text on
   * disk.
   */
  it('and no component file is invisible to the class extractor', () => {
    // `.tsx` only: those are the files that carry class names, and a server-side
    // `.ts` that masks strings with a NUL costs nothing at build time. (One such
    // fixture exists in the harness importer's tests and is left alone.)
    const binary: string[] = [];
    for (const root of CLIENT_ROOTS) {
      for (const file of walk(root)) {
        if (!file.endsWith('.tsx')) continue;
        if (readFileSync(file).includes(0)) binary.push(file.slice(ROOT.length + 1));
      }
    }
    expect(binary, 'a NUL byte makes Tailwind (and git, and grep) skip the file').toEqual([]);
  });

  it('finds none in any client source', () => {
    const offenders: string[] = [];
    for (const root of CLIENT_ROOTS) {
      for (const file of walk(root)) {
        const src = readFileSync(file, 'utf8');
        // Only THIS file may name the pattern — it has to, to test for it.
        if (file === __filename) continue;
        const hits = src.match(/text-\[\d+(?:\.\d+)?px\]/g);
        if (hits) offenders.push(`${file.slice(ROOT.length + 1)}: ${hits.join(', ')}`);
      }
    }
    expect(offenders, `use rem so the size setting reaches these:\n  ${offenders.join('\n  ')}`).toEqual(
      []
    );
  });
});

describe('the chat scale actually covers a message', () => {
  const BUBBLE = read('packages', 'feature', 'agent', 'src', 'client', 'MessageBubble.tsx');
  const MARKDOWN = read('packages', 'shared', 'ui', 'src', 'MarkdownRenderer.tsx');

  it('is mounted on the wrapper around EVERY branch of the renderer', () => {
    // One class on the wrapper covers markdown, the plain-text user branch and
    // the streamed tail — rather than three classes that can drift apart.
    expect(BUBBLE).toContain('className="break-words chat-content"');
  });

  it('does not leak onto the chrome around a message', () => {
    // Tool rows, timestamps and the copy buttons are UI, and UI follows the
    // GLOBAL scale. Two bubbles' worth of content carry the class: the message
    // itself and the plan card (which is prose the agent wrote).
    // Counted on the CLASS ATTRIBUTES, not on the word: the file also explains
    // itself in prose, and a comment must not be able to satisfy this.
    expect(BUBBLE.match(/className="[^"]*\bchat-content\b/g) ?? []).toHaveLength(2);
  });

  it('leaves no rem-based type size inside the message to ignore it', () => {
    // A rem is measured against the root, so any `text-*` class in here would
    // stay put while the paragraphs around it grew — the exact way a message
    // reflows into nonsense at 125%.
    expect(MARKDOWN).not.toMatch(/className="[^"]*\btext-(?:xs|sm|base|lg|xl|2xl)\b/);
    expect(MARKDOWN).toContain('text-[1.25em]');
    expect(MARKDOWN).toContain('text-[1.125em]');
    expect(MARKDOWN).toContain('text-[0.875em]');
    expect(MARKDOWN).not.toMatch(/fontSize: '[\d.]+rem'/);
    // The code block's family follows the code-font knob even though the Prism
    // theme object ships a fontFamily of its own.
    expect(MARKDOWN).toContain("fontFamily: 'var(--app-font-mono)'");
  });
});
