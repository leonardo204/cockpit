import type { ReactNode } from 'react';

/**
 * A macOS-style window chrome that frames product screenshots and the hero
 * video consistently across the site.
 *
 * Why it exists: the raw app screenshots are dense (full terminals, file trees)
 * and, dropped straight onto the page under a heavy `shadow-2xl`, read as noise.
 * Wrapping them in a titled window with a soft ring + shadow and a gentle
 * bottom fade makes them feel deliberate and "product shot"-like instead.
 *
 * The content sits inside a 16:9 box; pass an <img>/<video>/placeholder that
 * fills it (e.g. `absolute inset-0 w-full h-full object-cover`).
 */
export function BrowserFrame({
  children,
  label,
  fade = true,
}: {
  children: ReactNode;
  /** Optional monospace caption shown in the title bar (e.g. a route/path). */
  label?: string;
  /** Fade the bottom edge of the content into the frame. Default true. */
  fade?: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-lg ring-1 ring-white/[0.06]">
      {/* Title bar with the three traffic-light dots */}
      <div className="flex items-center gap-1.5 border-b border-border/70 bg-slate-2 px-3.5 py-2.5">
        <span className="size-2.5 rounded-full bg-slate-6" />
        <span className="size-2.5 rounded-full bg-slate-6" />
        <span className="size-2.5 rounded-full bg-slate-6" />
        {label ? (
          <span className="ml-3 truncate font-mono text-[11px] text-muted-foreground/70">
            {label}
          </span>
        ) : null}
      </div>

      {/* 16:9 content stage */}
      <div className="relative aspect-video">
        {children}
        {fade ? (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-card/70 to-transparent"
          />
        ) : null}
      </div>
    </div>
  );
}
