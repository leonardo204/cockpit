/**
 * projectFolderStart.ts — where the project folder chooser opens, and the
 * command lines the web fallback launches it with.
 *
 * THE ORDER (VOC: "let me set a default folder, or at least start at the last
 * one"):
 *
 *   1. `projectFolderDefault`, when it is still an existing directory;
 *   2. otherwise the PARENT of `projectFolderLast` — the parent, not the folder
 *      itself, because the next project a user opens is usually a sibling of
 *      the last one, and starting inside the last project would put every
 *      sibling one level up;
 *   3. otherwise home.
 *
 * Every step is allowed to be wrong. settings.json is hand-editable and folders
 * get deleted, moved or unmounted between runs, so a value that is not a string,
 * not absolute, missing or not a directory falls through to the next step —
 * never an error. A chooser that refuses to open because the remembered folder
 * was on an unplugged drive would be worse than the home-directory default this
 * replaces.
 *
 * The same validation guards the start path a CALLER passes in
 * (`/api/pick-folder?defaultPath=`), because that value arrives over HTTP and
 * is fed to a native dialog. The Electron main process keeps its own copy of
 * the check (`electron/ipc.ts`): it is a separate build that cannot import this
 * tree.
 *
 * Kept stdlib-only and free of Effect, like `fsScope.ts`, so it unit-tests
 * without a runtime.
 */
import { statSync } from "fs"
import { homedir } from "os"
import { dirname, isAbsolute } from "path"
import {
  PROJECT_FOLDER_DEFAULT_KEY,
  PROJECT_FOLDER_FAVORITES_KEY,
  PROJECT_FOLDER_LAST_KEY,
  normalizeFavorites,
} from "@cockpit/shared-utils"

/** The candidate itself when it is an absolute path to an existing directory;
 *  null for anything else (wrong type, relative, missing, a file, unreadable). */
export function usableStartDir(candidate: unknown): string | null {
  if (typeof candidate !== "string" || candidate.length === 0) return null
  // A NUL byte makes `statSync` throw, and it can never be a real path anyway.
  if (candidate.includes("\0")) return null
  if (!isAbsolute(candidate)) return null
  try {
    return statSync(candidate).isDirectory() ? candidate : null
  } catch {
    return null
  }
}

/** The chooser's start folder for these settings — see the order above. */
export function resolveProjectFolderStart(
  settings: Record<string, unknown>,
  home: string = homedir()
): string {
  const configured = usableStartDir(settings[PROJECT_FOLDER_DEFAULT_KEY])
  if (configured) return configured

  const last = settings[PROJECT_FOLDER_LAST_KEY]
  // Checked for shape BEFORE taking its parent: `dirname("relative/x")` is
  // "relative", which the absolute check would catch anyway, but `dirname("")`
  // is ".", and that must not be stat-ed against the server's cwd.
  if (typeof last === "string" && isAbsolute(last)) {
    const parent = usableStartDir(dirname(last))
    if (parent) return parent
  }
  return home
}

/**
 * Everything the quick folder menu needs, in one answer.
 *
 * `favorites` and `last` carry only folders that EXIST right now. A favorite
 * that has gone stays in settings.json — it may be on a drive that is simply
 * unplugged — but the menu must not offer a folder the chooser cannot open, so
 * it is filtered here and Settings shows it as missing instead. `home` is sent
 * so the client can draw paths as `~/…` without guessing the server's home.
 */
export interface ProjectFolderChoices {
  startPath: string
  favorites: string[]
  last: string | null
  home: string
}

export function projectFolderChoices(
  settings: Record<string, unknown>,
  home: string = homedir()
): ProjectFolderChoices {
  const favorites = normalizeFavorites(settings[PROJECT_FOLDER_FAVORITES_KEY]).filter(
    (f) => usableStartDir(f) !== null
  )
  return {
    startPath: resolveProjectFolderStart(settings, home),
    favorites,
    last: usableStartDir(settings[PROJECT_FOLDER_LAST_KEY]),
    home,
  }
}

// ─────────────────────────────────────────────────────────
// the web fallback's dialog commands
// ─────────────────────────────────────────────────────────

/**
 * One way to launch a folder chooser: a binary and its argv, run WITHOUT a
 * shell (`execFileSync`).
 *
 * WHY ARGV AND NOT A COMMAND STRING. The old route interpolated the start
 * folder and the prompt into a shell line — inside an AppleScript string,
 * inside single quotes, inside a shell. Home directories never contain quotes,
 * so that held; a remembered project folder can (`/Users/me/it's mine`), and
 * then the dialog either failed to open or ran whatever followed the quote.
 * Here neither value is ever parsed as code: AppleScript receives both as
 * `argv` items, PowerShell reads them from environment variables, and zenity /
 * kdialog get them as discrete arguments.
 */
export interface PickerCommand {
  file: string
  args: string[]
  /** Extra environment for the child — how PowerShell receives its values. */
  env?: Record<string, string>
}

const APPLESCRIPT = [
  "on run argv",
  "POSIX path of (choose folder with prompt (item 1 of argv) default location (item 2 of argv as POSIX file))",
  "end run",
]

const POWERSHELL = [
  "Add-Type -AssemblyName System.Windows.Forms",
  "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
  "$d.Description = $env:NABY_PICK_PROMPT",
  "$d.SelectedPath = $env:NABY_PICK_START",
  "if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }",
].join("; ")

/**
 * The command(s) to try on this platform, in order. Linux has two: zenity
 * first, kdialog when zenity is not INSTALLED (the route only falls through on
 * a missing binary — a cancelled zenity must not pop a second dialog).
 */
export function pickerCommands(
  platform: NodeJS.Platform,
  prompt: string,
  startDir: string
): PickerCommand[] {
  if (platform === "darwin") {
    return [
      {
        file: "osascript",
        args: [...APPLESCRIPT.flatMap((line) => ["-e", line]), prompt, startDir],
      },
    ]
  }
  if (platform === "win32") {
    return [
      {
        file: "powershell",
        args: ["-NoProfile", "-Command", POWERSHELL],
        env: { NABY_PICK_PROMPT: prompt, NABY_PICK_START: startDir },
      },
    ]
  }
  // zenity treats `--filename` as a file to preselect; the trailing slash is
  // what makes it open INSIDE the directory rather than at its parent.
  const inside = startDir.endsWith("/") ? startDir : `${startDir}/`
  return [
    {
      file: "zenity",
      args: ["--file-selection", "--directory", `--title=${prompt}`, `--filename=${inside}`],
    },
    {
      file: "kdialog",
      args: ["--getexistingdirectory", startDir, "--title", prompt],
    },
  ]
}
