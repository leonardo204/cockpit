/**
 * /api/pick-folder
 *
 * Launches the OS-native folder picker dialog. Returns `folder: null` on
 * failure or user cancellation.
 *
 * `?defaultPath=` is where the dialog starts (the client resolves it through
 * `/api/pick-folder/start`). It is validated here — absolute, existing, a
 * directory — and anything else silently starts at home, the old behaviour.
 * The dialogs are launched without a shell (see `pickerCommands`), so a start
 * folder or prompt containing quotes cannot break out of the command line.
 */
import { execFileSync } from "child_process"
import { homedir } from "os"
import { Effect } from "effect"
import { SETTINGS_FILE, readJsonFile } from "@cockpit/shared-utils"
import en from "@cockpit/shared-i18n/locales/en.json"
import ko from "@cockpit/shared-i18n/locales/ko.json"
import { handler, ok } from "@cockpit/effect-runtime/server"
import { pickerCommands, usableStartDir } from "../../../lib/projectFolderStart"

const locales: Record<string, typeof en> = { en, ko }

const pickFolder = (prompt: string, startDir: string): string => {
  const commands = pickerCommands(process.platform, prompt, startDir)
  for (const [i, cmd] of commands.entries()) {
    try {
      return execFileSync(cmd.file, cmd.args, {
        encoding: "utf8",
        timeout: 60000,
        // stderr dropped, as the old `2>/dev/null` did: zenity in particular
        // prints GTK warnings on every run.
        stdio: ["ignore", "pipe", "ignore"],
        ...(cmd.env ? { env: { ...process.env, ...cmd.env } } : {}),
      }).trim()
    } catch (err) {
      // Only a MISSING binary moves on to the next dialog (zenity → kdialog).
      // Anything else — a cancel is a non-zero exit — is the answer.
      const missing = (err as NodeJS.ErrnoException).code === "ENOENT"
      if (!missing || i === commands.length - 1) throw err
    }
  }
  return ""
}

export const GET = handler((req) =>
  Effect.gen(function* () {
    // Read settings (fall back to "en" on failure)
    const settings = yield* Effect.tryPromise({
      try: () => readJsonFile<{ language?: string }>(SETTINGS_FILE, {}),
      catch: () => null,
    }).pipe(Effect.orElseSucceed(() => ({} as { language?: string })))

    const locale =
      settings.language === "en" || settings.language === "ko"
        ? settings.language
        : "en"
    const prompt = locales[locale].api.pickFolderPrompt
    const requested = new URL(req.url).searchParams.get("defaultPath")
    const startDir = usableStartDir(requested) ?? homedir()

    // Dialog failure or user cancellation -> folder = null
    const result = yield* Effect.try({
      try: () => pickFolder(prompt, startDir),
      catch: () => null,
    }).pipe(Effect.orElseSucceed(() => ""))

    const folder = result ? result.replace(/[/\\]$/, "") : null
    return ok({ folder })
  })
)
