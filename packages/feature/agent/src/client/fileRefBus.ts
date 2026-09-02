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

/**
 * A request made while NO input is registered, waiting for one to arrive.
 *
 * WHY THIS IS NEEDED AT ALL. The registration above is gated on `isActive` — a
 * ChatInput registers only while ITS tab is the one on screen. That is right for
 * the file browser, which is a panel beside a visible chat, and wrong for
 * anything that asks from a tab of its own: a diff tab IS the active tab, so by
 * construction no chat is active and there is nobody to insert into.
 *
 * The caller therefore switches to a chat tab and asks in the same breath, and
 * the switch has not rendered yet. Rather than poll for the registration, the
 * request waits here and the registration collects it.
 */
let pending: { text: string; at: number } | null = null

/**
 * How long a waiting request stays valid.
 *
 * A CAP, NOT A TIMEOUT FOR ITS OWN SAKE. The tab switch that follows takes one
 * render; anything approaching this means the switch never happened. Without the
 * cap a request that missed its moment would sit here and splice itself into
 * whatever conversation the user opened next — minutes later, with no idea where
 * the text came from.
 */
const PENDING_TTL_MS = 3000

/** The active ChatInput registers its caret-insertion function. Idempotent. */
export function setActiveFileRefInserter(fn: Inserter): void {
  activeInserter = fn
  // Collect a request that arrived while this input was still mounting.
  if (pending && Date.now() - pending.at <= PENDING_TTL_MS) {
    const { text } = pending
    pending = null
    fn(text)
    return
  }
  pending = null
}

/**
 * Insert `text` into the active chat input, or into the next one to register.
 *
 * The difference from `insertFileRef` below is only what happens when nothing is
 * registered: that one reports the miss, this one waits. Use this when you are
 * ALSO making a chat tab active — the caller knows an input is about to exist,
 * and reporting "no chat is open" in that moment would be false.
 */
export function insertFileRefWhenReady(text: string): void {
  if (activeInserter) {
    activeInserter(text)
    return
  }
  pending = { text, at: Date.now() }
}

/** Relinquish, but only if `fn` is still the registered inserter — avoids a
 *  tab-switch race where the newly-active input has already registered before
 *  the outgoing input's cleanup runs. */
export function clearActiveFileRefInserter(fn: Inserter): void {
  if (activeInserter === fn) activeInserter = null
}

/** Drop a waiting request — for a caller that decides not to ask after all. */
export function cancelPendingFileRef(): void {
  pending = null
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
