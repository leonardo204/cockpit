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
// The one answer to "is this markdown?" — see markdownFile.ts on why it is not
// re-derived at each call site.
export * from './markdownFile';
export * from './platform';
export * from './paths';
export * from './ollamaEnv';
