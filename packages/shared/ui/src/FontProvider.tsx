'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_FONT_SETTINGS,
  FONTS_STORAGE_KEY,
  fontCssVars,
  normalizeFontSettings,
  parseFontState,
  serializeFontState,
  type FontSettings,
} from '@cockpit/shared-utils';

/**
 * THE FOUR FONT KNOBS, applied live and remembered across restarts.
 *
 * Written as a sibling of `ThemeProvider`, deliberately and almost line for
 * line: same persistence path (`settings.json` via an injected writer, plus
 * `localStorage` as the synchronous fast path), same pre-paint story (the root
 * layout injects the derived variables into `public/boot.js`), same cross-frame
 * broadcast (a `postMessage` to every iframe, mirrored without re-persisting).
 * Two appearance preferences that behaved differently would be two sets of bugs.
 *
 * WHAT IT DOES NOT DO: it does not read HTTP. The provider lives in the shared
 * UI layer and must not know about routes, so the app injects `persistFonts`
 * (see `Providers.tsx`, which wires it to `PUT /api/settings`).
 */

interface FontContextValue {
  fonts: FontSettings;
  /** Merge-update: the panel changes one knob at a time. */
  setFonts: (patch: Partial<FontSettings>) => void;
  /** Back to `DEFAULT_FONT_SETTINGS` — the "기본값으로" button. */
  resetFonts: () => void;
}

const FontContext = createContext<FontContextValue | null>(null);

export function useFonts() {
  const context = useContext(FontContext);
  if (!context) {
    throw new Error('useFonts must be used within a FontProvider');
  }
  return context;
}

interface FontProviderProps {
  children: React.ReactNode;
  /**
   * What the SERVER has on file (`settings.json`), passed down by the root
   * layout. This is what makes the preference survive a restart — the desktop
   * shell boots Next on an ephemeral port, so `localStorage` is empty on every
   * launch — and it keeps hydration honest, because the same value renders on
   * the server and in the client's first render.
   */
  initialFonts?: FontSettings;
  /** Persist beyond this origin. Injected; see the file header. */
  persistFonts?: (fonts: FontSettings) => void;
}

/** Write the four variables onto <html>, where `boot.js` already put them. */
function applyFontVars(fonts: FontSettings): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const vars = fontCssVars(fonts);
  for (const [name, value] of Object.entries(vars)) {
    root.style.setProperty(name, value);
  }
}

export function FontProvider({ children, initialFonts, persistFonts }: FontProviderProps) {
  // Deterministic on both sides of hydration: the server-persisted value if we
  // have one, else the same defaults `globals.css` declares.
  const [fonts, setFontsState] = useState<FontSettings>(
    initialFonts ?? DEFAULT_FONT_SETTINGS
  );

  // `setFonts` is a dependency of every consumer's callbacks, so it must not
  // change identity when the settings do — hence the ref rather than `fonts` in
  // the dependency list. (Same reason as the callbacks in shell/CLAUDE.md's
  // referential-stability rule: SettingsModal sits above the whole pane.)
  const current = useRef(fonts);
  current.current = fonts;

  /** Apply + remember, and tell every child frame. The one path all changes take. */
  const commit = useCallback(
    (next: FontSettings) => {
      setFontsState(next);
      applyFontVars(next);
      // localStorage is the synchronous fast path — it is what boot.js reads on
      // the next navigation within this same origin, and it carries the DERIVED
      // vars alongside the settings so that read needs no font table of its own.
      // The durable copy is written by persistFonts (a file, via /api/settings),
      // because this origin's port dies with the process.
      try {
        localStorage.setItem(FONTS_STORAGE_KEY, serializeFontState(next));
      } catch {
        /* private mode / storage disabled — the server copy still holds */
      }
      persistFonts?.(next);

      // Every project panel is an iframe with its own document, so the variables
      // this frame just set do not reach them. Same broadcast the theme uses.
      const iframes = document.querySelectorAll('iframe');
      iframes.forEach((iframe) => {
        iframe.contentWindow?.postMessage({ type: 'FONT_CHANGE', fonts: next }, '*');
      });
    },
    [persistFonts]
  );

  const setFonts = useCallback(
    (patch: Partial<FontSettings>) => {
      // Normalised on the way in, not just on the way out: a value that never
      // becomes state cannot be persisted, broadcast or rendered.
      commit(normalizeFontSettings({ ...current.current, ...patch }));
    },
    [commit]
  );

  const resetFonts = useCallback(() => commit(DEFAULT_FONT_SETTINGS), [commit]);

  // Initialise. Precedence mirrors the theme's: localStorage (the newer write
  // within this session) → the server's persisted value → the defaults.
  useEffect(() => {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(FONTS_STORAGE_KEY);
    } catch {
      /* storage disabled; fall through to the server value */
    }
    const initial = parseFontState(raw) ?? initialFonts ?? DEFAULT_FONT_SETTINGS;
    queueMicrotask(() => {
      setFontsState(initial);
      applyFontVars(initial);
    });
  }, [initialFonts]);

  // A change made in the top window, arriving in a project iframe.
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type !== 'FONT_CHANGE') return;
      const next = normalizeFontSettings(event.data.fonts);
      setFontsState(next);
      applyFontVars(next);
      // Mirror into this frame's storage only. NOT persisted to the server: the
      // frame that originated the change already did that, and a second PUT of
      // the same value is pure noise.
      try {
        localStorage.setItem(FONTS_STORAGE_KEY, serializeFontState(next));
      } catch {
        /* ignore */
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  // Memoised: this context sits above every panel, and a fresh object on each
  // render would re-render all of them (shell/CLAUDE.md's perf conventions).
  const value = useMemo(
    () => ({ fonts, setFonts, resetFonts }),
    [fonts, setFonts, resetFonts]
  );

  return <FontContext.Provider value={value}>{children}</FontContext.Provider>;
}
