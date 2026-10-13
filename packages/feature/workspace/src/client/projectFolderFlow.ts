/**
 * The quick folder menu's decisions, without React.
 *
 * "Open project" (sidebar, home screen, session browser) and Create's "where
 * does it go" all ask the same question, and they ask it through ONE flow:
 *
 *   1. fetch the choices (favorites and last folder, existing ones only);
 *   2. nothing to offer → open the chooser straight away at the resolved start
 *      (configured default, else the last folder's parent, else home) — the
 *      behaviour before this menu existed;
 *   3. otherwise show the menu; a folder entry opens the chooser INSIDE that
 *      folder (on macOS "Open" then takes it as-is, or the user steps up), and
 *      "Browse other folder…" opens at the resolved start.
 *
 * Kept free of React and of the runtime so every branch is a plain unit test;
 * `ProjectFolderMenu.tsx` supplies the three effects.
 */
import type { ProjectFolderChoices } from './effect/workspaceClient';

export interface FolderMenuEntry {
  kind: 'favorite' | 'last';
  path: string;
}

/**
 * The entries, in display order: favorites as stored, then the last folder —
 * unless it IS a favorite, which would list one folder twice. The server has
 * already dropped folders that do not exist; duplicates are dropped again here
 * because the menu must not trust its input's shape any more than the server
 * trusts the file's.
 */
export function buildFolderMenu(choices: ProjectFolderChoices): FolderMenuEntry[] {
  const entries: FolderMenuEntry[] = [];
  for (const path of choices.favorites) {
    if (path && !entries.some((e) => e.path === path)) entries.push({ kind: 'favorite', path });
  }
  if (choices.last && !entries.some((e) => e.path === choices.last)) {
    entries.push({ kind: 'last', path: choices.last });
  }
  return entries;
}

/** What the user did with the menu: a folder, "browse", or dismissed (null). */
export type FolderMenuChoice = { kind: 'folder'; path: string } | { kind: 'browse' };

export interface FolderRequestDeps {
  loadChoices: () => Promise<ProjectFolderChoices>;
  /** Show the menu; resolves with the choice, or null when dismissed. */
  showMenu: (choices: ProjectFolderChoices) => Promise<FolderMenuChoice | null>;
  /** Open the native chooser at `startAt` (undefined = let it resolve); the
   *  picked folder or null on cancel. */
  pick: (startAt: string | undefined) => Promise<string | null>;
}

/** The whole flow above. Resolves with the picked folder, or null. */
export async function requestProjectFolder(deps: FolderRequestDeps): Promise<string | null> {
  const choices = await deps.loadChoices();
  if (buildFolderMenu(choices).length === 0) return deps.pick(choices.startPath);
  const choice = await deps.showMenu(choices);
  if (!choice) return null; // dismissed — nothing opens
  return deps.pick(choice.kind === 'folder' ? choice.path : choices.startPath);
}

/**
 * Roving focus for the menu's items: where `key` moves focus from `current`
 * among `count` items, or null when the key is not a navigation key. Arrows
 * wrap; Home/End jump. `current` of -1 (nothing focused yet) enters from the
 * matching end.
 */
export function nextMenuIndex(key: string, current: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowDown':
      return current < 0 ? 0 : (current + 1) % count;
    case 'ArrowUp':
      return current < 0 ? count - 1 : (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}
