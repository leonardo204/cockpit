import type { TocHeading } from './toc';

/**
 * Right-hand "On this page" table of contents.
 *
 * Server component — the anchors are plain `#id` links, so no client JS is
 * needed (KISS: links jump natively, no scroll-spy). Lives as a flex sibling
 * of the `<article>` column in `[...slug]/page.tsx`; the left sidebar +
 * article + this TOC make the three columns of the docs layout.
 *
 * Hidden below `xl` so it never competes with the article for width on
 * narrow/medium screens, and suppressed entirely when there are too few
 * headings to be worth a TOC.
 */
export function DocsToc({ headings, label }: { headings: TocHeading[]; label: string }) {
  if (headings.length < 2) return null;

  return (
    <aside className="hidden xl:block w-56 shrink-0">
      <div className="sticky top-24 py-10 lg:py-12">
        <p className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
        <nav>
          <ul className="space-y-2 border-l border-border text-sm">
            {headings.map((h) => (
              <li key={h.id} className="pl-4">
                <a
                  href={`#${h.id}`}
                  className="block text-muted-foreground transition-colors hover:text-brand"
                >
                  {h.text}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </aside>
  );
}
