import { PlainImg } from '../PlainImg';
import { BrowserFrame } from '../BrowserFrame';

export function PanelSection({
  tag,
  name,
  title,
  bullets,
  screenshot,
  align = 'left',
  tint = false,
}: {
  tag: string;
  name: string;
  title: string;
  bullets: readonly string[];
  screenshot: string;
  align?: 'left' | 'right';
  /** Give the section the subtle tinted band background (page alternates it). */
  tint?: boolean;
}) {
  const textOrder = align === 'left' ? 'md:order-1' : 'md:order-2';
  const imgOrder = align === 'left' ? 'md:order-2' : 'md:order-1';

  return (
    <section className={tint ? 'bg-card/40' : undefined}>
      <div className="mx-auto grid max-w-6xl grid-cols-1 items-center gap-12 px-6 py-20 md:grid-cols-2 md:py-28">
        <div className={textOrder}>
          <div className="inline-flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-brand">
            <span className="size-1 rounded-full bg-brand" />
            {tag} · {name}
          </div>
          <h2 className="mt-3 text-balance text-3xl font-semibold tracking-tight md:text-4xl">
            {title}
          </h2>
          <ul className="mt-6 space-y-2.5">
            {bullets.map((b) => (
              <li key={b} className="flex gap-3 text-sm leading-relaxed text-muted-foreground">
                <span className="mt-2 size-1 shrink-0 rounded-full bg-brand/70" />
                <span>{b}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className={imgOrder}>
          <ScreenshotFrame src={screenshot} alt={name} />
        </div>
      </div>
    </section>
  );
}

/**
 * Screenshot frame with built-in placeholder. Renders an <img> that gracefully
 * falls back to a styled placeholder card if the file is missing — so we can
 * ship the layout before final screenshots are ready.
 */
function ScreenshotFrame({ src, alt }: { src: string; alt: string }) {
  return (
    <BrowserFrame label={alt}>
      {/* Decorative gradient backdrop (always visible behind image) */}
      <div
        className="absolute inset-0 bg-gradient-to-br from-teal-3 via-card to-card opacity-80"
        aria-hidden
      />

      {/* Placeholder content (visible until real img loads on top) */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="text-center">
          <div className="text-2xl font-semibold tracking-tight text-brand/80">{alt}</div>
          <div className="mt-1 font-mono text-[11px] uppercase tracking-wider text-muted-foreground/60">
            Screenshot coming soon
          </div>
        </div>
      </div>

      {/* Real screenshot — hides itself if the file is missing */}
      <PlainImg src={src} alt={alt} className="absolute inset-0 h-full w-full object-cover" />
    </BrowserFrame>
  );
}
