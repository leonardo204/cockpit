/**
 * The fonts that survive a restart — four knobs, and nothing else.
 *
 * WHY THIS FILE LOOKS LIKE `bootTheme.ts`. It is the same problem, one
 * preference later: the desktop shell boots Next on an EPHEMERAL PORT
 * (`electron/next-server.ts` calls `server.listen(0)`), so `localStorage` — which
 * is scoped per origin, port included — is empty on every launch. A font kept
 * only in the browser would be lost on every restart exactly as the theme was.
 * So the settings travel the same path: written to `settings.json` through
 * `PUT /api/settings`, read back server-side by the root layout, and injected
 * into the inlined boot script so the vars are on `<html>` BEFORE first paint.
 *
 * Everything here is pure, so it can be unit-tested; the IO lives at the call
 * sites (the route writes settings.json, the layout reads it, FontProvider
 * writes localStorage and the DOM).
 *
 * ── THE FOUR KNOBS, AND WHY THERE ARE ONLY FOUR ────────────────────────────
 *
 *   1. `uiFont`    — the UI family (presets + a custom family).
 *   2. `scale`     — a percentage on the ROOT font size, so every rem-based size
 *                    in the app moves together (WCAG 1.4.4's 200% resize).
 *   3. `chatScale` — a second percentage that applies ONLY to message content,
 *                    because "make what the agent says bigger" and "make the app
 *                    bigger" are genuinely different requests.
 *   4. `codeFont`  — the monospace family for code blocks and mono elements.
 *
 * PER-ROLE SPLITS ARE DELIBERATELY NOT EXPOSED. No surveyed app (ChatGPT,
 * Claude, VS Code, Slack, Discord, Telegram) offers "user text vs assistant text
 * vs UI description" as separate sizes, and every one of them would fragment the
 * single guarantee this feature owes: that ONE control resizes everything a
 * person reads, up to 200%, without any part of the layout being left behind.
 * Two scales is already the ceiling; a third that only covers half a conversation
 * would make the 200% claim untestable.
 *
 * NO FONT FILES ARE BUNDLED. The Pretendard / Noto Sans KR / JetBrains Mono /
 * Fira Code presets are PREFERENCES: the family is used if the machine has it
 * and the stack falls through to the system faces if it does not. That is why a
 * preset is a stack rather than a single name.
 */

export type UiFontPreset = 'system' | 'pretendard' | 'noto-sans-kr' | 'custom';
export type CodeFontPreset = 'system-mono' | 'jetbrains-mono' | 'fira-code' | 'custom';

export interface FontSettings {
  /** UI family preset. `custom` reads `uiFontCustom`. */
  uiFont: UiFontPreset;
  /** Free-text family, sanitized (see `sanitizeFontFamily`). '' = none given. */
  uiFontCustom: string;
  /** Root font-size scale, in percent. */
  scale: number;
  /** Message-content scale, in percent. Composes ON TOP of `scale` (em, not rem). */
  chatScale: number;
  /** Monospace family preset. `custom` reads `codeFontCustom`. */
  codeFont: CodeFontPreset;
  /** Free-text monospace family, sanitized. */
  codeFontCustom: string;
}

/** Field name in `settings.json` and key in `localStorage`. */
export const FONTS_STORAGE_KEY = 'fonts';

/**
 * Name of the global the server writes ahead of the boot script, holding the
 * DERIVED CSS variables (not the settings). Read by `public/boot.js`; keep the
 * two in sync through this constant only.
 *
 * Derived rather than raw ON PURPOSE: boot.js is hand-written ES5 that runs
 * before anything is bundled, and a copy of the font-stack table in there would
 * be a second answer to "what does `pretendard` mean" that nothing keeps honest.
 */
export const SERVER_FONT_VARS_GLOBAL = '__cockpitServerFontVars';

/** The offered root scales, in percent. 100 is today's size. */
export const UI_SCALES = [90, 100, 110, 125, 150] as const;
/** The offered chat scales, in percent. Tops out lower than the root scale:
 *  it multiplies with it, so 150 × 150 would be 225% of the base size. */
export const CHAT_SCALES = [90, 100, 110, 125] as const;

export const DEFAULT_FONT_SETTINGS: FontSettings = {
  uiFont: 'system',
  uiFontCustom: '',
  scale: 100,
  chatScale: 100,
  codeFont: 'system-mono',
  codeFontCustom: '',
};

/**
 * The stack the app has always used, minus the leading Inter.
 *
 * ORDER IS THE WHOLE POINT (the same reason `globals.css` documents it): the
 * Korean faces sit ahead of the Simplified-Chinese ones, because with SC first
 * Windows resolved Hangul to Microsoft YaHei — a face whose Korean coverage is a
 * fallback — and the UI read as slightly wrong and blurry there.
 */
const SYSTEM_SANS_TAIL =
  '-apple-system, "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "PingFang SC", "Microsoft YaHei", sans-serif';

/** The monospace stack the app has always used. System faces only. */
const SYSTEM_MONO_STACK =
  '"Maple Mono CN", "Maple Mono NF CN", "Sarasa Mono SC", var(--font-jetbrains-mono), ui-monospace, Menlo, Consolas, monospace';

/**
 * The UI stacks, by preset.
 *
 * `var(--font-inter)` is the Next-hosted Inter, declared by the font class the
 * root layout puts on `<html>` (it used to be on `<body>`; it had to move,
 * because these variables are declared on `:root` and a custom property is
 * substituted against the element it is declared on).
 */
export const UI_FONT_STACKS: Record<Exclude<UiFontPreset, 'custom'>, string> = {
  system: `var(--font-inter), ${SYSTEM_SANS_TAIL}`,
  // Prefer-if-installed. Pretendard is the de-facto Korean UI face; the stack
  // degrades to the system faces on a machine without it.
  pretendard:
    '"Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont, system-ui, Roboto, "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif',
  'noto-sans-kr':
    '"Noto Sans KR", "Apple SD Gothic Neo", "Malgun Gothic", -apple-system, BlinkMacSystemFont, system-ui, "PingFang SC", sans-serif',
};

export const CODE_FONT_STACKS: Record<Exclude<CodeFontPreset, 'custom'>, string> = {
  'system-mono': SYSTEM_MONO_STACK,
  'jetbrains-mono': `"JetBrains Mono", var(--font-jetbrains-mono), ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`,
  'fira-code': `"Fira Code", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`,
};

const UI_PRESETS: readonly UiFontPreset[] = ['system', 'pretendard', 'noto-sans-kr', 'custom'];
const CODE_PRESETS: readonly CodeFontPreset[] = [
  'system-mono',
  'jetbrains-mono',
  'fira-code',
  'custom',
];

/** Longest family name accepted. Real families are far shorter; the cap is what
 *  keeps a pasted document out of the inlined boot script. */
const MAX_FAMILY_LENGTH = 64;

/**
 * A user-typed family name, reduced to something that can only ever be a family
 * name.
 *
 * THE VALUE ENDS UP IN THREE PLACES a raw string must never reach: a CSS custom
 * property, an inline `style` attribute, and a `<script>` the server inlines
 * into the document head. So this is a WHITELIST, not a blacklist: letters
 * (including Hangul and CJK), digits, spaces, hyphen and underscore survive;
 * everything else — quotes, semicolons, braces, parentheses (and with them
 * `url(...)`), colons and slashes (and with them `http://…`), angle brackets
 * (and with them `</script>`), commas (which would smuggle in a second family),
 * backslashes and control characters — is dropped.
 *
 * The result is emitted QUOTED by the stack builders, which is also why stripping
 * quotes here is safe rather than lossy: `"My Font"` is the same family as
 * `My Font`, and a name that starts with a digit is only legal quoted anyway.
 */
export function sanitizeFontFamily(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[^\p{L}\p{N} _-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_FAMILY_LENGTH)
    .trim();
}

/** Narrow a percentage read from settings.json / localStorage. */
function normalizeScale(value: unknown, allowed: readonly number[], fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && allowed.includes(n) ? n : fallback;
}

/**
 * Narrow an untrusted value (a `settings.json` field, a `localStorage` string)
 * into a complete, renderable `FontSettings`.
 *
 * Always returns a value: a half-written or hand-edited object yields the
 * defaults for the fields it got wrong rather than an unusable app.
 */
export function normalizeFontSettings(value: unknown): FontSettings {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const uiFont = UI_PRESETS.includes(raw.uiFont as UiFontPreset)
    ? (raw.uiFont as UiFontPreset)
    : DEFAULT_FONT_SETTINGS.uiFont;
  const codeFont = CODE_PRESETS.includes(raw.codeFont as CodeFontPreset)
    ? (raw.codeFont as CodeFontPreset)
    : DEFAULT_FONT_SETTINGS.codeFont;
  return {
    uiFont,
    uiFontCustom: sanitizeFontFamily(raw.uiFontCustom),
    scale: normalizeScale(raw.scale, UI_SCALES, DEFAULT_FONT_SETTINGS.scale),
    chatScale: normalizeScale(raw.chatScale, CHAT_SCALES, DEFAULT_FONT_SETTINGS.chatScale),
    codeFont,
    codeFontCustom: sanitizeFontFamily(raw.codeFontCustom),
  };
}

/** The UI family stack for these settings. A `custom` family goes FIRST and the
 *  system stack stays behind it, so an unavailable name degrades instead of
 *  leaving the app in the browser's default serif. */
export function uiFontStack(settings: FontSettings): string {
  if (settings.uiFont === 'custom') {
    const family = sanitizeFontFamily(settings.uiFontCustom);
    if (!family) return UI_FONT_STACKS.system;
    return `"${family}", ${UI_FONT_STACKS.system}`;
  }
  return UI_FONT_STACKS[settings.uiFont];
}

/** The monospace stack for these settings, same rule. */
export function codeFontStack(settings: FontSettings): string {
  if (settings.codeFont === 'custom') {
    const family = sanitizeFontFamily(settings.codeFontCustom);
    if (!family) return CODE_FONT_STACKS['system-mono'];
    return `"${family}", ${CODE_FONT_STACKS['system-mono']}`;
  }
  return CODE_FONT_STACKS[settings.codeFont];
}

/** The variable names, in one place: `globals.css` declares the defaults,
 *  `boot.js` applies these before first paint, `FontProvider` re-applies them on
 *  every change. Three readers, one list. */
export const FONT_CSS_VARS = [
  '--app-font-sans',
  '--app-font-mono',
  '--app-font-scale',
  '--chat-text-scale',
] as const;

export type FontCssVars = Record<(typeof FONT_CSS_VARS)[number], string>;

/**
 * The settings as the four CSS custom properties that actually do the work.
 *
 * The two scales are emitted as UNITLESS MULTIPLIERS, not sizes:
 *   `--app-font-scale`  multiplies the root font size, so every rem in the app
 *                       (which is every Tailwind `text-*` class) follows it.
 *   `--chat-text-scale` multiplies the message wrapper's `em`, so it COMPOSES
 *                       with the root scale rather than fighting it: at 125%
 *                       global and 110% chat, message text is 1.375× base.
 */
export function fontCssVars(settings: FontSettings): FontCssVars {
  return {
    '--app-font-sans': uiFontStack(settings),
    '--app-font-mono': codeFontStack(settings),
    '--app-font-scale': String(settings.scale / 100),
    '--chat-text-scale': String(settings.chatScale / 100),
  };
}

/**
 * What `localStorage` holds under `fonts`: the settings AND the vars derived
 * from them.
 *
 * Both halves, because they have different readers. `boot.js` needs the VARS and
 * must not carry a copy of the stack table to derive them; `FontProvider` needs
 * the SETTINGS, to show which preset is selected. Storing one and recomputing
 * the other would put the derivation in ES5 boot code (a second source of truth)
 * or make the pre-paint write depend on React having mounted (a flash).
 */
export interface StoredFontState {
  v: 1;
  settings: FontSettings;
  vars: FontCssVars;
}

export function serializeFontState(settings: FontSettings): string {
  const state: StoredFontState = { v: 1, settings, vars: fontCssVars(settings) };
  return JSON.stringify(state);
}

/** Read back what `serializeFontState` wrote. Undefined for absent/corrupt
 *  storage, so callers can fall through to the server-persisted value. */
export function parseFontState(raw: string | null | undefined): FontSettings | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { settings?: unknown } | null;
    if (!parsed || typeof parsed !== 'object' || !('settings' in parsed)) return undefined;
    return normalizeFontSettings(parsed.settings);
  } catch {
    return undefined;
  }
}

/**
 * The `window.__cockpitServerFontVars = {…}` line the root layout prefixes onto
 * the boot script.
 *
 * The object is built from THIS module's whitelisted presets and the sanitizer
 * above, never from raw file contents, so a hand-edited settings.json cannot
 * inject `</script>` into the inlined tag. The `<` escape is belt-and-braces for
 * the same reason `bootTheme` emits from a whitelist.
 */
export function buildFontVarsScript(vars: FontCssVars): string {
  const literal = JSON.stringify(vars)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return `window.${SERVER_FONT_VARS_GLOBAL}=${literal};`;
}
