import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_THEME,
  SERVER_THEME_GLOBAL,
  THEME_STORAGE_KEY,
  buildBootScript,
  normalizeTheme,
} from './bootTheme';

/**
 * The theme has to survive a restart of the desktop shell, which serves the app
 * from a NEW PORT every launch — and therefore from a new localStorage origin.
 * These tests pin the pure half of the chain: what the server is allowed to
 * inject, and what boot.js does with it. The wiring (layout reads settings.json,
 * ThemeProvider takes the value as a prop) is asserted against the sources
 * below, because there is no DOM here to render it into.
 */

describe('normalizeTheme', () => {
  it('accepts the three real themes', () => {
    expect(normalizeTheme('light')).toBe('light');
    expect(normalizeTheme('dark')).toBe('dark');
    expect(normalizeTheme('system')).toBe('system');
  });

  it('rejects anything else — settings.json is hand-editable', () => {
    for (const bad of ['', 'Dark', 'blue', null, undefined, 42, {}, ['dark']]) {
      expect(normalizeTheme(bad)).toBeUndefined();
    }
  });
});

describe('buildBootScript', () => {
  it('prefixes the boot source with the server theme', () => {
    const out = buildBootScript('BOOT();', 'light');
    expect(out).toBe(`window.${SERVER_THEME_GLOBAL}="light";\nBOOT();`);
  });

  it('emits null when the server has no stored theme', () => {
    expect(buildBootScript('BOOT();', undefined)).toContain(
      `window.${SERVER_THEME_GLOBAL}=null;`
    );
  });

  it('keeps the boot source verbatim', () => {
    const source = readFileSync(bootJsPath(), 'utf8');
    expect(buildBootScript(source, 'dark').endsWith(source)).toBe(true);
  });

  it('cannot break out of the inlined <script> tag', () => {
    // The value is emitted from the whitelist, never from raw file contents, so
    // a settings.json containing `</script>` in `theme` yields `null` here.
    const hostile = normalizeTheme('</script><script>alert(1)</script>');
    const out = buildBootScript('BOOT();', hostile);
    expect(out).not.toContain('</script>');
  });
});

function bootJsPath(): string {
  return join(__dirname, '..', '..', '..', '..', 'public', 'boot.js');
}

describe('boot.js honours the injected value', () => {
  const src = readFileSync(bootJsPath(), 'utf8');

  it('reads the global the server writes', () => {
    expect(src).toContain(`window.${SERVER_THEME_GLOBAL}`);
  });

  it('still lets localStorage win, then falls back to the default', () => {
    // `stored || window.__cockpitServerTheme || 'dark'` — order is the contract:
    // localStorage is the newer write within a session, the server value is what
    // survives the port change, and the literal is the last resort.
    const chain = /var theme = stored \|\| window\.__cockpitServerTheme \|\| '([a-z]+)';/.exec(src);
    expect(chain, 'boot.js theme precedence chain not found — did it change?').not.toBeNull();
    expect(chain?.[1]).toBe(DEFAULT_THEME);
  });

  it('reads the same storage key the provider writes', () => {
    expect(src).toContain(`localStorage.getItem('${THEME_STORAGE_KEY}')`);
  });
});

describe('the persistence chain is actually wired', () => {
  const root = join(__dirname, '..', '..', '..', '..');

  it('the root layout reads settings.json server-side and injects it', () => {
    const layout = readFileSync(join(root, 'src', 'app', 'layout.tsx'), 'utf8');
    // Reads the FILE, not its own HTTP route: a server component fetching itself
    // during render is a deadlock risk on a single-threaded dev server.
    expect(layout).toContain('SETTINGS_FILE');
    expect(layout).not.toMatch(/fetch\(["'`][^"'`]*\/api\/settings/);
    expect(layout).toContain('buildBootScript(bootSource, storedTheme)');
    // …and hands the same value to React, so the first render agrees with the
    // class boot.js just applied instead of flipping it back.
    expect(layout).toContain('initialTheme={storedTheme}');
  });

  it('theme changes are written to the settings file, not just localStorage', () => {
    const providers = readFileSync(
      join(root, 'packages', 'feature', 'workspace', 'src', 'client', 'Providers.tsx'),
      'utf8'
    );
    expect(providers).toContain('saveSettings({ theme })');
    expect(providers).toContain('persistTheme={persistTheme}');
  });

  it('the provider keeps localStorage as the synchronous fast path', () => {
    const provider = readFileSync(
      join(root, 'packages', 'shared', 'ui', 'src', 'ThemeProvider.tsx'),
      'utf8'
    );
    expect(provider).toContain('localStorage.setItem(THEME_STORAGE_KEY, newTheme)');
    // Precedence on mount: localStorage → server value → whatever boot.js put on
    // <html> → default. The old code forced 'dark' here and fought boot.js.
    expect(provider).toContain(
      'normalizeTheme(raw) ?? initialTheme ?? readDomTheme() ?? DEFAULT_THEME'
    );
  });
});
