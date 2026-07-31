/**
 * The theme that survives a restart.
 *
 * WHY THIS EXISTS. The desktop shell boots Next on an EPHEMERAL port
 * (`electron/next-server.ts` calls `server.listen(0)`), and `localStorage` is
 * scoped per ORIGIN — including the port. Every launch is therefore a brand new
 * origin with an empty store, so a theme kept only in `localStorage` is lost on
 * every restart and the app falls back to dark. Language never had the problem
 * because it goes through `PUT /api/settings` into a file under a stable
 * `COCKPIT_HOME`.
 *
 * So the theme is written to the same settings file, and the server injects it
 * into the inlined boot script (see `src/app/layout.tsx` + `public/boot.js`) as
 * the fallback used when `localStorage` has nothing. A `localStorage` value, if
 * present, still wins: within a session it is the newer of the two.
 *
 * Everything here is pure so it can be unit-tested; the file IO lives at the
 * call sites (the route reads/writes settings.json, the layout reads it).
 */

export type StoredTheme = 'light' | 'dark' | 'system';

/** Key used in `localStorage` and as the settings.json field name. */
export const THEME_STORAGE_KEY = 'theme';

/**
 * The last-resort theme. ONE constant, shared by `boot.js`, the layout's
 * server-side read and `ThemeProvider`'s initial state — those three used to
 * disagree ('dark' / 'dark' / 'system'), which is how the provider ended up
 * fighting the class the boot script had already applied.
 */
// `satisfies`, not a `: StoredTheme` annotation — the literal type is what lets
// it stand in for a resolved 'light' | 'dark' without a cast.
export const DEFAULT_THEME = 'dark' satisfies StoredTheme;

/**
 * Name of the global the server writes ahead of the boot script. Read by
 * `public/boot.js`; keep the two in sync through this constant only.
 */
export const SERVER_THEME_GLOBAL = '__cockpitServerTheme';

const THEMES: readonly StoredTheme[] = ['light', 'dark', 'system'];

/** Narrow an untrusted value (settings.json field, localStorage string). */
export function normalizeTheme(value: unknown): StoredTheme | undefined {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value)
    ? (value as StoredTheme)
    : undefined;
}

/**
 * Prefix the boot script with the server-persisted theme.
 *
 * The value is emitted from the WHITELIST above, never from raw file contents,
 * so a hand-edited settings.json cannot inject `</script>` into the inlined
 * tag. `undefined` emits `null`, which `boot.js` treats as "no server value".
 */
export function buildBootScript(
  bootSource: string,
  serverTheme: StoredTheme | undefined
): string {
  const literal = serverTheme ? JSON.stringify(serverTheme) : 'null';
  return `window.${SERVER_THEME_GLOBAL}=${literal};\n${bootSource}`;
}
