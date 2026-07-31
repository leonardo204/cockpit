'use client';

import { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react';
import {
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  normalizeTheme,
  type StoredTheme,
} from '@cockpit/shared-utils';

type Theme = StoredTheme;

interface ThemeContextValue {
  theme: Theme;
  resolvedTheme: 'light' | 'dark';
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}

interface ThemeProviderProps {
  children: React.ReactNode;
  /**
   * The theme the SERVER has on file (`settings.json`), passed down by the root
   * layout. This is what makes the preference survive a restart: the desktop
   * shell boots Next on an ephemeral port, so `localStorage` — which is scoped
   * per origin, port included — is empty on every launch. See
   * `@cockpit/shared-utils/bootTheme`.
   *
   * It is also what keeps hydration honest: the same value renders on the
   * server and in the client's first render, so nothing flips after paint.
   */
  initialTheme?: Theme;
  /**
   * Persist a theme change beyond this origin. Optional and injected, because
   * this provider lives in the shared UI layer and must not know about HTTP
   * routes; the app wires it to `PUT /api/settings` (see Providers.tsx).
   */
  persistTheme?: (theme: Theme) => void;
}

/**
 * What the boot script already decided, read back off the DOM.
 *
 * Last-resort input for the case where this provider is mounted without
 * `initialTheme` (any host other than our root layout) but `public/boot.js` has
 * still applied a class. Adopting it beats re-asserting a hardcoded default:
 * that is precisely how the provider used to fight the boot script and snap a
 * light-theme user back to dark one frame after paint.
 */
function readDomTheme(): 'light' | 'dark' | undefined {
  if (typeof document === 'undefined') return undefined;
  const classes = document.documentElement.classList;
  if (classes.contains('dark')) return 'dark';
  if (classes.contains('light')) return 'light';
  return undefined;
}

export function ThemeProvider({ children, initialTheme, persistTheme }: ThemeProviderProps) {
  // Deterministic on both sides of hydration: the server-persisted value if we
  // have one, else the single shared default that boot.js also falls back to.
  // (This used to initialise to 'system' while boot.js had already written
  // 'dark' onto <html> — two answers to one question.)
  const [theme, setThemeState] = useState<Theme>(initialTheme ?? DEFAULT_THEME);
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>(
    // 'system' cannot be resolved before the client runs, and matchMedia during
    // the first render would desync SSR; the effect below corrects it.
    initialTheme && initialTheme !== 'system' ? initialTheme : DEFAULT_THEME
  );

  // Get system theme
  const getSystemTheme = useCallback((): 'light' | 'dark' => {
    if (typeof window === 'undefined') return 'light';
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }, []);

  // Apply theme to DOM
  const applyTheme = useCallback((resolved: 'light' | 'dark') => {
    const root = document.documentElement;
    root.classList.remove('light', 'dark');
    root.classList.add(resolved);
    setResolvedTheme(resolved);

    // Update PWA title bar color
    const themeColorMeta = document.querySelector('meta[name="theme-color"]');
    const color = resolved === 'dark' ? '#111113' : '#f9f9fb';
    if (themeColorMeta) {
      themeColorMeta.setAttribute('content', color);
    }
  }, []);

  // Set theme
  const setTheme = useCallback((newTheme: Theme) => {
    setThemeState(newTheme);
    // localStorage is the synchronous fast path — it is what boot.js reads on
    // the next navigation within this same origin. The durable copy is written
    // by persistTheme (a file, via /api/settings), because this origin's port
    // dies with the process.
    try {
      localStorage.setItem(THEME_STORAGE_KEY, newTheme);
    } catch { /* private mode / storage disabled — the server copy still holds */ }
    persistTheme?.(newTheme);

    const resolved = newTheme === 'system' ? getSystemTheme() : newTheme;
    applyTheme(resolved);

    // Notify all child iframes to update theme
    const iframes = document.querySelectorAll('iframe');
    iframes.forEach((iframe) => {
      iframe.contentWindow?.postMessage({ type: 'THEME_CHANGE', theme: newTheme }, '*');
    });
  }, [getSystemTheme, applyTheme, persistTheme]);

  // Initialize theme. Precedence: localStorage (newest within this session) →
  // the server's persisted value → whatever boot.js put on <html> → default.
  useEffect(() => {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(THEME_STORAGE_KEY);
    } catch { /* storage disabled; fall through to the server value */ }
    const initial =
      normalizeTheme(raw) ?? initialTheme ?? readDomTheme() ?? DEFAULT_THEME;
    queueMicrotask(() => {
      setThemeState(initial);
      const resolved = initial === 'system' ? getSystemTheme() : initial;
      applyTheme(resolved);
    });
  }, [getSystemTheme, applyTheme, initialTheme]);

  // Listen for system theme changes
  useEffect(() => {
    if (theme !== 'system') return;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => {
      applyTheme(e.matches ? 'dark' : 'light');
    };

    mediaQuery.addEventListener('change', handler);
    return () => mediaQuery.removeEventListener('change', handler);
  }, [theme, applyTheme]);

  // Listen for theme change messages from parent window (iframe scenario)
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'THEME_CHANGE') {
        const newTheme = normalizeTheme(event.data.theme);
        if (!newTheme) return;
        setThemeState(newTheme);
        // Mirror into this frame's storage only. NOT persisted to the server:
        // the frame that originated the change already did that, and a second
        // PUT of the same value is pure noise.
        try {
          localStorage.setItem(THEME_STORAGE_KEY, newTheme);
        } catch { /* ignore */ }
        const resolved = newTheme === 'system' ? getSystemTheme() : newTheme;
        applyTheme(resolved);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [getSystemTheme, applyTheme]);

  // Memoised: this context sits above every panel, and a fresh object on each
  // render would re-render all of them (see the perf conventions in CLAUDE.md).
  const value = useMemo(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
