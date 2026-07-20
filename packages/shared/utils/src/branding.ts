/**
 * What this app calls itself, in one place.
 *
 * This is a FORK of OpenCockpit, and the fork ships as a different product. The
 * upstream name is still correct in places a user never sees — the npm package
 * is `@surething/cockpit`, the internal workspace packages are `@cockpit/*`, the
 * on-disk state directory is `~/.cockpit`, the `Cockpit-*` git trailers on
 * snapshot commits — and renaming any of those would be a large, permanently
 * conflicting diff against upstream in exchange for nothing a user can observe.
 *
 * So the rule is: rename what a user READS, leave what a machine reads. Every
 * user-visible surface (window title, HTML metadata, PWA manifest) imports from
 * here, so there is exactly one string to change when Alpha ends.
 */

/** The product name on its own. */
export const APP_NAME = 'Naby';

/**
 * The full title, including the release-stage marker.
 *
 * The "(Alpha version)" is deliberately part of the TITLE rather than tucked
 * into an about box: this build is pre-release, and the window title is the one
 * label a tester cannot fail to see when they file a bug or take a screenshot.
 */
export const APP_TITLE = 'Naby (Alpha version)';

/**
 * The window title. Always just the product name.
 *
 * The working directory used to be appended, on the reasoning that it is what
 * distinguishes two windows of the same app. In practice it read as if the app
 * were named after whatever project happened to be open, which is the identity
 * problem the rebrand was meant to fix. The current project is already visible
 * in the UI; the title bar does not need to repeat it.
 *
 * The `cwd` parameter is retained so callers do not have to change, and so the
 * decision lives in one place if per-window disambiguation is ever wanted back.
 */
export function appTitleForCwd(_cwd?: string | null): string {
  return APP_TITLE;
}

/** One sentence describing the product, for HTML metadata and the PWA manifest. */
export const APP_DESCRIPTION =
  'Naby is a personalized persona agent — a local-first desktop app for chatting with an AI ' +
  'that remembers your projects. Your keys and your history stay on your own machine.';
