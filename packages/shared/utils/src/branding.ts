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

/** Separator between the product name and the working directory. An em dash
 *  rather than a hyphen so a project literally named "x - y" stays readable. */
export const APP_TITLE_SEPARATOR = ' — ';

/**
 * The window title for a given working directory.
 *
 * The directory is kept because it is the only thing distinguishing two windows
 * of the same app, but it comes SECOND — a title bar that reads "anomaly-agent"
 * with no product name is how the pre-fork build lost its identity.
 */
export function appTitleForCwd(cwd?: string | null): string {
  const dirName = cwd?.split('/').filter(Boolean).pop();
  return dirName ? `${APP_TITLE}${APP_TITLE_SEPARATOR}${dirName}` : APP_TITLE;
}

/** One sentence describing the product, for HTML metadata and the PWA manifest. */
export const APP_DESCRIPTION =
  'Naby is a personalized persona agent — a local-first desktop app for chatting with an AI ' +
  'that remembers your projects. Your keys and your history stay on your own machine.';
