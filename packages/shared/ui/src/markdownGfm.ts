// packages/shared/ui/src/markdownGfm.ts
//
// GFM WITH STRIKETHROUGH ON `~~` ONLY.
//
// remark-gfm also treats a SINGLE tilde pair as strikethrough by default, so a
// reply that writes ranges the Korean way — "12/13~15, 16~18" — came out with
// "15, 16" struck through. The GFM spec only documents `~~text~~`; a lone `~`
// in prose is almost always a range or "about". Turning `singleTilde` off keeps
// real strikethrough and leaves ranges as written.

import remarkGfm from 'remark-gfm';
import type { Options } from 'remark-gfm';

/** A [plugin, options] tuple, as react-markdown's `remarkPlugins` takes it. */
export const REMARK_GFM: [typeof remarkGfm, Options] = [remarkGfm, { singleTilde: false }];
