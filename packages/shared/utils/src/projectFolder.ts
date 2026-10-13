/**
 * Where the "open / create a project" folder chooser starts.
 *
 * WHY THIS EXISTS. The chooser used to open at the home directory every time,
 * so a user whose projects all live in `~/work/clients/acme` walked the same
 * four folders on every open. Three settings.json fields fix it:
 *
 *   - `projectFolderDefault` — a folder the user chose in Settings. Wins when it
 *     is still an existing directory.
 *   - `projectFolderLast` — the folder most recently picked (or created). The
 *     chooser starts at its PARENT, so the sibling projects are one click away.
 *   - `projectFolderFavorites` — folders the user pinned. They (and the last
 *     folder) are offered in a small menu BEFORE the chooser opens, and picking
 *     one opens the chooser inside it.
 *
 * Only the names and the pure list rules live here: the client writes them and
 * the server reads them, and two spellings of a settings key fail silently (the
 * reader just sees "unset"). Anything that touches the filesystem lives
 * server-side in `src/lib/projectFolderStart.ts`.
 */

/** settings.json field: the user-configured start folder. `null` or absent =
 *  not set (the PUT route merges, so clearing writes `null`). */
export const PROJECT_FOLDER_DEFAULT_KEY = 'projectFolderDefault';

/** settings.json field: the folder most recently picked or created. */
export const PROJECT_FOLDER_LAST_KEY = 'projectFolderLast';

/** settings.json field: the favorite folders, in the order they were added. */
export const PROJECT_FOLDER_FAVORITES_KEY = 'projectFolderFavorites';

/**
 * How many favorites are kept. The quick menu is a list to glance at, not a
 * second file browser — past ten it stops being quicker than the chooser.
 */
export const PROJECT_FOLDER_FAVORITES_MAX = 10;

/**
 * A stored favorites value, made safe to use: strings only, no empties, no
 * duplicates (first occurrence wins, so insertion order holds), at most
 * `PROJECT_FOLDER_FAVORITES_MAX`. The file is hand-editable, so every reader
 * goes through this rather than trusting the shape.
 */
export function normalizeFavorites(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item || out.includes(item)) continue;
    out.push(item);
    if (out.length === PROJECT_FOLDER_FAVORITES_MAX) break;
  }
  return out;
}

/**
 * `favorites` with `folder` appended. Unchanged when it is already there (it
 * keeps its place) or when the list is full — a full list is the user's to
 * prune in Settings, not ours to evict from silently.
 */
export function addFavorite(favorites: unknown, folder: string): string[] {
  const list = normalizeFavorites(favorites);
  if (!folder || list.includes(folder) || list.length >= PROJECT_FOLDER_FAVORITES_MAX) return list;
  return [...list, folder];
}

/** `favorites` without `folder`. */
export function removeFavorite(favorites: unknown, folder: string): string[] {
  return normalizeFavorites(favorites).filter((f) => f !== folder);
}

/**
 * A path for DISPLAY, with the home directory shown as `~`. Never used to open
 * anything — callers keep the full path for that and for the tooltip. Either
 * separator counts, so a Windows home prefixes the same way.
 */
export function tildePath(path: string, home: string | null | undefined): string {
  if (!home) return path;
  const base = home.replace(/[/\\]+$/, '');
  if (!base) return path;
  if (path === base) return '~';
  const next = path.charAt(base.length);
  if (path.startsWith(base) && (next === '/' || next === '\\')) return `~${path.slice(base.length)}`;
  return path;
}
