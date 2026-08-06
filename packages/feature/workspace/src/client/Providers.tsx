'use client';

import { Effect } from 'effect';
import { I18nProvider } from './I18nProvider';
import { FontProvider, ThemeProvider } from '@cockpit/shared-ui';
import { TooltipProvider } from '@cockpit/shared-ui';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import type { FontSettings, StoredTheme } from '@cockpit/shared-utils';
import { saveSettings } from './effect/workspaceClient';

interface ProvidersProps {
  children: React.ReactNode;
  /**
   * The theme the server has on file, read by the root layout. Passed through
   * so the first client render agrees with the class boot.js already applied.
   */
  initialTheme?: StoredTheme;
  /**
   * The fonts the server has on file, same read, same reason: boot.js has
   * already written the derived variables onto <html>, and the first client
   * render has to agree with them rather than flipping back to the defaults.
   */
  initialFonts?: FontSettings;
}

/**
 * Write the theme to `settings.json`, the same file the language preference
 * lives in. Fire-and-forget, exactly like `handleLanguageChange` — a failed
 * preference write must never interrupt the UI, and `localStorage` has already
 * taken the change for this origin.
 *
 * Defined at module scope so its identity is stable: it is a dependency of
 * ThemeProvider's `setTheme`, which every consumer of the context holds.
 */
const persistTheme = (theme: StoredTheme): void => {
  BrowserRuntime.runFork(
    saveSettings({ theme }).pipe(Effect.orElse(() => Effect.void))
  );
};

/**
 * Write the fonts to `settings.json` — the same file, the same fire-and-forget
 * shape and the same module scope as `persistTheme` above, for the same three
 * reasons: a failed preference write must never interrupt the UI, `localStorage`
 * has already taken the change for this origin, and a stable identity keeps the
 * provider's `setFonts` from re-rendering every panel under it.
 */
const persistFonts = (fonts: FontSettings): void => {
  BrowserRuntime.runFork(
    saveSettings({ fonts }).pipe(Effect.orElse(() => Effect.void))
  );
};

export function Providers({ children, initialTheme, initialFonts }: ProvidersProps) {
  return (
    <I18nProvider>
      <ThemeProvider initialTheme={initialTheme} persistTheme={persistTheme}>
        <FontProvider initialFonts={initialFonts} persistFonts={persistFonts}>
          {children}
          {/* Single global popover for every `data-tooltip` attribute,
              including those forwarded by the <Tooltip> wrapper. Lives
              outside any panel so its `position: fixed` stays viewport-
              relative under panel `translateX` transforms. */}
          <TooltipProvider />
          {/* No ToastProvider: `toast()` is imperative and mounts its own
              singleton container on document.body. The provider that used to
              wrap this tree rendered a second, unreachable toast stack. */}
        </FontProvider>
      </ThemeProvider>
    </I18nProvider>
  );
}
