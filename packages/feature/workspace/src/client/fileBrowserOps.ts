/**
 * fileBrowserOps.ts — the decisions behind the file browser's right-click menu
 * and its refresh, as pure functions.
 *
 * WHY THEY LIVE OUTSIDE THE COMPONENT. This repo has no component-render
 * harness, so anything expressed only as JSX is untested by construction. The
 * parts of these operations that can be wrong in a way a user would notice —
 * which directory a "New File" lands in, what a rename actually asks the server
 * for, which part of a name is preselected for editing, how a file name reaches
 * an innerHTML confirm dialog, and which watcher messages are worth a refresh —
 * are decided here and pinned by fileBrowserOps.test.ts. The component is left
 * with wiring.
 */

/** One entry as the tree knows it. */
export interface FileEntry {
  name: string;
  isDir: boolean;
}

/** What the menu was opened on. `null` entry = the panel body, i.e. the root. */
export interface MenuTarget {
  /** cwd-relative path of the row; '' for the panel body. */
  rel: string;
  /** cwd-relative path of the row's parent directory; '' at the top level. */
  parentRel: string;
  name: string;
  isDir: boolean;
}

/**
 * Where a "New File" / "New Folder" chosen on this target should be created.
 *
 * A FOLDER row creates inside itself — that is what the row means. A FILE row
 * creates BESIDE itself, in its parent, which is what every file manager does
 * and what the user means by "new file here". The panel body is the root.
 */
export function createParentOf(target: MenuTarget): string {
  return target.isDir ? target.rel : target.parentRel;
}

/** Join a parent relative path with a child name (root parent = ''). */
export function childRel(parentRel: string, name: string): string {
  return parentRel ? `${parentRel}/${name}` : name;
}

/** The absolute path of a row, for "Copy Absolute Path". */
export function absolutePathOf(cwd: string, rel: string): string {
  if (!rel) return cwd;
  const base = cwd.endsWith('/') ? cwd.slice(0, -1) : cwd;
  return `${base}/${rel}`;
}

/**
 * The selection an inline rename opens with: the BASENAME, not the extension.
 *
 * Renaming `component.test.tsx` almost always means changing `component`, and
 * an editor that preselects the whole string makes the user re-type `.test.tsx`
 * or fight the selection. A dotfile (`.env`) has no basename to speak of, so
 * the whole name is selected.
 */
export function renameSelection(name: string): { start: number; end: number } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { start: 0, end: name.length };
  return { start: 0, end: dot };
}

/**
 * Is this rename worth sending? An unchanged or blank name is a no-op, and a
 * name carrying a separator is refused here as well as on the server — the
 * round trip would only produce an error toast for something we can already
 * see is wrong.
 */
export function isCommittableName(current: string, next: string): boolean {
  const trimmed = next.trim();
  if (!trimmed || trimmed === current) return false;
  if (trimmed === '.' || trimmed === '..') return false;
  if (trimmed.includes('/') || trimmed.includes('\\')) return false;
  return true;
}

/**
 * Escape a value that is about to be interpolated into a message rendered as
 * HTML.
 *
 * THIS IS NOT DECORATION. `confirm()` in @cockpit/shared-ui builds its dialog
 * with `innerHTML`, and the shared i18n instance is configured with
 * `escapeValue: false` — so a FILE NAME goes into that markup verbatim. A file
 * called `<img src=x onerror=…>` would execute inside the app's own origin,
 * which is the origin holding the session token. The name is escaped here,
 * before interpolation, so the dialog shows the file's real name as text.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Drop the `<file>` markers the delete-confirmation strings carry.
 *
 * Those keys were written for a `<Trans>` component, which turns the tag into a
 * styled span. This dialog is a string, so the tags are removed rather than
 * shipped to the user as literal angle brackets. Runs AFTER escaping, so a
 * file genuinely named `<file>` still reads as its own name.
 */
export function stripTransTags(message: string): string {
  return message.replace(/<\/?file>/g, '');
}

/**
 * The directories a `/ws/fs-watch` message says to refresh, or none.
 *
 * The panel bumps whatever comes back, so this is the only place that decides
 * what counts as a change message — a shape check the component would otherwise
 * do inline, where nothing could test it. Anything that is not an `fs-change`
 * carrying an array of strings yields `[]`, which is what the channel's other
 * messages (`fs-watch-ready`, `fs-watch-unavailable`) are meant to do here.
 *
 * The path filter is defence in depth, not the real guard: the server already
 * scopes every entry to the project and drops the ignored trees. It is here so
 * a malformed entry cannot become a refresh nonce keyed on a path the tree can
 * never render.
 */
export function fsChangeDirs(message: unknown): string[] {
  if (!message || typeof message !== 'object') return [];
  const msg = message as { type?: unknown; dirs?: unknown };
  if (msg.type !== 'fs-change' || !Array.isArray(msg.dirs)) return [];
  return msg.dirs.filter(
    (dir): dir is string =>
      typeof dir === 'string' &&
      !dir.startsWith('/') &&
      !dir.includes('\\') &&
      !dir.split('/').includes('..'),
  );
}

/** Which i18n key explains a failed `/api/fs-op` response. `exists` is the one
 *  a user hits by accident, so it gets its own sentence instead of the generic
 *  "could not". */
export function failureKey(
  action: 'create' | 'rename' | 'duplicate' | 'delete',
  reason: string | undefined,
): string {
  if (reason === 'exists') return 'fileBrowser.nameTaken';
  return `fileBrowser.${action}Error`;
}
