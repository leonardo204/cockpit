// @cockpit/shared-utils — cross-feature reusable pure functions / types

// Types
export type { ImageMediaType, ImageInfo, MessageImage } from './types';

// Utilities
export * from './branding';
export * from './bootTheme';
// The four font knobs: presets, sanitizer, and the CSS-variable derivation the
// boot script, the provider and globals.css all read. See fontSettings.ts.
export * from './fontSettings';
export * from './shortId';
// The default name of a session nobody has named — `MMDD-HHmm-animal`. One
// module because the tab strip, the session lists and Telegram must produce the
// SAME string for the same session; see sessionName.ts.
export * from './sessionName';
// The one answer to "is this markdown?" — see markdownFile.ts on why it is not
// re-derived at each call site.
export * from './markdownFile';
// The ONE image-format whitelist. The markdown rewriter and /api/fs-image both
// import it; two copies would break images silently. See imageFile.ts.
export * from './imageFile';
export * from './platform';
export * from './paths';
export * from './ollamaEnv';
