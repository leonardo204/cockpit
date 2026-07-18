/**
 * Server-only shell helpers for the cockpit.bash channel.
 *
 * These live here (not in @cockpit/shared-utils/platform.ts) on purpose:
 * platform.ts is isomorphic (the browser bundle imports modKey from it), so it
 * must not import node `fs`/`child_process`. This module is only imported from
 * server code (src/lib/effect/*), so it can.
 */
import { existsSync } from "fs"
import { execSync, spawn, type ChildProcess } from "child_process"
import { isWindows, getDefaultShell } from "@cockpit/shared-utils"

let bashCache: string | null | undefined

/**
 * Resolve the bash executable used to run `cockpit.bash` commands with
 * `["--login", "-c", cmd]`.
 *  - posix: the user's login shell (bash/zsh both accept `--login -c`).
 *  - Windows: Git Bash (MSYS2, handles `C:\` cwd + paths) preferred, then a
 *    `bash` on PATH (may be WSL). Returns null when none is installed — the
 *    caller surfaces a clear "install Git Bash/WSL" error instead of spawning
 *    `cmd --login -c` (which would misbehave).
 */
export function resolveBashShell(): string | null {
  if (!isWindows) return getDefaultShell()
  if (bashCache !== undefined) return bashCache

  const envShell = process.env.SHELL
  const candidates = [
    ...(envShell && /bash(\.exe)?$/i.test(envShell) ? [envShell] : []),
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    ...(process.env.ProgramFiles ? [`${process.env.ProgramFiles}\\Git\\bin\\bash.exe`] : []),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return (bashCache = c)
  }
  // Last resort: a `bash` on PATH (often WSL's System32\bash.exe).
  try {
    const found = execSync("where bash", { encoding: "utf-8", timeout: 3000 })
      .trim()
      .split(/\r?\n/)[0]
    if (found && existsSync(found)) return (bashCache = found)
  } catch {
    /* not on PATH */
  }
  // Don't cache a null result: the user may install Git Bash/WSL later and we
  // shouldn't keep reporting "not found" until the process restarts.
  return null
}

/**
 * Kill a spawned command's whole process tree, cross-platform.
 *  - Windows: `taskkill /T /F` (posix process-group signals don't exist).
 *  - posix: SIGTERM the process group (negative pid), SIGKILL survivors.
 *
 * Takes the ChildProcess (not a bare pid) so the delayed SIGKILL can be
 * cancelled the instant the child exits, and only escalates while the child is
 * still running — otherwise a `-pid` SIGKILL 1s later could hit an unrelated
 * process group that the OS assigned the recycled pid to (pid-reuse TOCTOU).
 */
export function killProcessTree(child: ChildProcess): void {
  const pid = child.pid
  if (!pid) return
  if (isWindows) {
    try {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" })
    } catch {
      /* already gone */
    }
    return
  }
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig)
    } catch {
      try {
        process.kill(pid, sig)
      } catch {
        /* already exited */
      }
    }
  }
  signal("SIGTERM")
  const timer = setTimeout(() => {
    // Only escalate if THIS child is still running. Once it has exited, exitCode
    // is set — signalling the (possibly recycled) pid then would be a misfire.
    if (child.exitCode === null && child.signalCode === null) signal("SIGKILL")
  }, 1000)
  if (typeof timer.unref === "function") timer.unref()
  child.once("exit", () => clearTimeout(timer))
}
