import { visit } from 'unist-util-visit';
import type { Element, Root } from 'hast';
import {
  formatMissingImage,
  isWideImage,
  markdownImageUrl,
  planMarkdownImage,
} from './markdownPreviewOps';

/**
 * rehypeMarkdownImages — rewrite every `<img>` in a previewed document so its
 * bytes come from /api/fs-image, and so the box it will occupy is known before
 * a single byte is requested.
 *
 * IT WORKS ON THE TREE, NOT ON AN HTML STRING. The reference editor this port
 * follows does the same job with a regex over its rendered HTML and then
 * reassembles the tag, which is where most of its complexity — and its
 * attribute-quoting and entity hazards — comes from. We render with
 * react-markdown, so the images are already `Element` nodes with a parsed
 * `properties` map: setting `properties.src` is exact, cannot corrupt a
 * neighbouring attribute, and cannot be fooled by an `>` inside an `alt`.
 *
 * WHAT IT DOES, per image:
 *   - `data:` / `http:` / `https:` — nothing at all. Remote and inline images
 *     are the browser's problem; we neither proxy nor probe them.
 *   - a resolvable project-local image — `src` becomes a route URL, and unless
 *     the AUTHOR already sized it, it gains `loading="lazy" decoding="async"`
 *     plus intrinsic `width`/`height` when they are known.
 *   - anything else — the `<img>` becomes an inline diagnostic `<span>`.
 *
 * WHY LAZY + DIMENSIONS ARE ONE DECISION AND NOT TWO. `loading="lazy"` is what
 * makes a fifty-screenshot document cheap: offscreen images are never fetched
 * and never decoded. But a lazy image is zero pixels tall until it arrives, so
 * on its own it turns scrolling into a sequence of jumps. The injected
 * dimensions reserve the box in advance, which is what makes the laziness
 * invisible. Shipping either without the other is worse than shipping neither.
 *
 * THE AUTHOR ALWAYS WINS. If the source node already carries `width`, `height`
 * or `loading` — which in practice means someone wrote raw `<img>` HTML on
 * purpose — the `src` is still repointed (or the image would simply 404) and
 * nothing else is touched. A hand-sized badge stays hand-sized.
 */

export interface MarkdownImageSize {
  readonly width: number;
  readonly height: number;
}

/**
 * What the walk found, written back for the host component.
 *
 * A MUTABLE SINK RATHER THAN A CALLBACK, because this runs inside
 * ReactMarkdown's render: calling back into `setState` from here would be a
 * state update during another component's render, which React refuses. The host
 * holds this object in a ref, the plugin refills it from scratch on every run
 * (so it is idempotent under StrictMode's double render), and an effect reads
 * it after the commit.
 */
export interface MarkdownImageScan {
  /** Every distinct project-relative image path the document referenced. */
  rels: string[];
  /** How many images could not be resolved and became placeholders. */
  missing: number;
}

export interface MarkdownImageOptions {
  /** The project root, for the route URL. */
  readonly cwd: string;
  /** The document being rendered — images resolve relative to ITS directory. */
  readonly fromRel: string;
  /**
   * Probed intrinsic sizes by project-relative path. A `null` means "probed and
   * unknown"; an absent key means "not probed yet". Either way the image still
   * renders, just without a reserved box.
   */
  readonly sizes: Readonly<Record<string, MarkdownImageSize | null>>;
  /** Filled by the walk; see MarkdownImageScan. */
  readonly scan: MarkdownImageScan;
  /** Localised "Image not found" prefix for the placeholder sentence. */
  readonly missingPrefix: string;
}

/** Marks the images this plugin owns, so the renderer can size them by CSS
 *  instead of falling into its raw-HTML branch (which pins exact pixels). */
const OWNED = 'data-md-image';

export function rehypeMarkdownImages(options: MarkdownImageOptions) {
  return (tree: Root): void => {
    const { cwd, fromRel, sizes, scan, missingPrefix } = options;
    const seen = new Set<string>();
    scan.rels = [];
    scan.missing = 0;

    visit(tree, 'element', (node: Element) => {
      if (node.tagName !== 'img') return;
      const properties = node.properties ?? (node.properties = {});
      const src = typeof properties.src === 'string' ? properties.src : '';
      const plan = planMarkdownImage(fromRel, src);

      if (plan.kind === 'passthrough') return;

      if (plan.kind === 'missing') {
        scan.missing += 1;
        // MUTATED IN PLACE INTO A SPAN, not spliced into the parent: an image
        // lives inside a paragraph, so the replacement has to be INLINE — a
        // block element here would be un-nested by the HTML parser and split
        // the paragraph around it. Rewriting the node itself also means the
        // plugin never has to reason about parent indices mid-walk.
        node.tagName = 'span';
        node.children = [
          // A TEXT node. The filename and the attempted path come from the
          // document, so they are untrusted; carrying them as text is what
          // makes the DOM escape them instead of parsing them.
          { type: 'text', value: formatMissingImage(missingPrefix, plan.label, plan.attempted) },
        ];
        node.properties = { className: ['md-img-missing'], title: plan.attempted };
        return;
      }

      if (!seen.has(plan.rel)) {
        seen.add(plan.rel);
        scan.rels.push(plan.rel);
      }
      properties.src = markdownImageUrl(cwd, plan.rel);

      // The author sized or staged it themselves — repoint and leave.
      if (
        properties.width !== undefined ||
        properties.height !== undefined ||
        properties.loading !== undefined
      ) {
        return;
      }

      properties.loading = 'lazy';
      properties.decoding = 'async';

      const size = sizes[plan.rel];
      if (size) {
        properties.width = size.width;
        properties.height = size.height;
      }
      // The wide/normal verdict is taken HERE, from the probed width, rather
      // than in a `load` handler the way the reference editor does it — see
      // isWideImage. An unprobed image is never wide.
      properties[OWNED] = isWideImage(size?.width) ? 'wide' : 'doc';
    });
  };
}
