// A tiny same-window channel that lets the file-browser panel insert a path
// reference into the ACTIVE chat input.
//
// WHY A SINGLETON, NOT A window CustomEvent. Every open tab keeps its ChatInput
// mounted (only the active one is visible), so a broadcast would splice the same
// reference into every tab's textarea at once. Instead exactly ONE inserter is
// registered at a time — the active tab's ChatInput registers on activation and
// relinquishes on deactivation — so a modifier-click reference lands only where
// the user is looking. Drag-and-drop needs none of this: an HTML5 drop already
// targets the textarea the pointer is over.
//
// It lives in feature-agent (next to ChatInput, which registers) and is consumed
// by the workspace file-browser panel via the package's public client entry.

/** The custom drag MIME the file browser sets on a dragged row and ChatInput
 *  reads on drop. Distinct from `text/plain` so a normal text drag is untouched. */
export const FILE_REF_MIME = "application/x-naby-fileref"

type Inserter = (text: string) => void

let activeInserter: Inserter | null = null

/** The active ChatInput registers its caret-insertion function. Idempotent. */
export function setActiveFileRefInserter(fn: Inserter): void {
  activeInserter = fn
}

/** Relinquish, but only if `fn` is still the registered inserter — avoids a
 *  tab-switch race where the newly-active input has already registered before
 *  the outgoing input's cleanup runs. */
export function clearActiveFileRefInserter(fn: Inserter): void {
  if (activeInserter === fn) activeInserter = null
}

/** Insert `text` into the active chat input, if one is mounted. Returns whether
 *  an inserter handled it (false = no chat input is active right now). */
export function insertFileRef(text: string): boolean {
  if (!activeInserter) return false
  activeInserter(text)
  return true
}

// ---------------------------------------------------------------------------
// Composer REPLACE channel — "edit this message".
// ---------------------------------------------------------------------------
// Same singleton discipline as the inserter above (every tab keeps its
// ChatInput mounted; only the active one registers), but a different verb:
// the message-bubble Edit button REPLACES the composer's draft with the
// message being edited, rather than splicing at the caret. A separate channel
// because splicing an entire past message into the middle of a draft is never
// what "edit" means.

let activeComposerSetter: Inserter | null = null

/** The active ChatInput registers its whole-draft replacement function. */
export function setActiveComposerSetter(fn: Inserter): void {
  activeComposerSetter = fn
}

/** Relinquish, with the same still-the-registrant guard as the inserter. */
export function clearActiveComposerSetter(fn: Inserter): void {
  if (activeComposerSetter === fn) activeComposerSetter = null
}

/** Replace the active chat input's draft with `text` (caret to the end,
 *  focused). Returns whether a composer handled it. */
export function setComposerText(text: string): boolean {
  if (!activeComposerSetter) return false
  activeComposerSetter(text)
  return true
}

// ---------------------------------------------------------------------------
// OS drag-drop (Finder/Explorer) → absolute path.
// ---------------------------------------------------------------------------

/** The subset of the preload `window.naby` bridge this module uses. `File.path`
 *  was removed in Electron 32, so the absolute path of a dropped OS file comes
 *  only from `webUtils.getPathForFile`, exposed here by the preload (which now
 *  loads in the /project subframe too). */
type NabyPathBridge = { getPathForFile?: (file: File) => string }

/** Resolve an OS-dropped File to its absolute on-disk path, or null when not in
 *  Electron / the bridge is unavailable (e.g. the plain browser dev server). */
export function osFilePath(file: File): string | null {
  try {
    const bridge = (globalThis as unknown as { naby?: NabyPathBridge }).naby
    const p = bridge?.getPathForFile?.(file)
    return p && p.length > 0 ? p : null
  } catch {
    return null
  }
}

/** Wrap a path in double quotes when it contains whitespace, so it reads as one
 *  token in the prompt (an unquoted "/a b/c.ts" would look like two args). */
export function quotePath(p: string): string {
  return /\s/.test(p) ? `"${p}"` : p
}
