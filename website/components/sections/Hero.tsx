import type { Messages } from '@/content/messages';
import type { Locale } from '@/lib/i18n';
import { CopyableCommand } from '../CopyableCommand';
import { BrowserFrame } from '../BrowserFrame';

const TRY_ONLINE_URL = '/try';
const GITHUB_URL = 'https://github.com/Surething-io/cockpit';
const VIDEO_URL =
  'https://github.com/user-attachments/assets/18f1a5dc-64f3-4ff6-b9fc-9cd08181fbb8';

export function Hero({ locale, t }: { locale: Locale; t: Messages }) {
  return (
    <section className="hero-bg relative overflow-hidden">
      {/* Faint tech grid, masked to fade out toward the edges */}
      <div aria-hidden className="hero-grid pointer-events-none absolute inset-0" />

      <div className="relative mx-auto max-w-6xl px-6 pt-16 pb-20 md:pt-24 md:pb-28 text-center">
        {/* Badge */}
        <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card/70 px-3.5 py-1.5 text-xs text-muted-foreground shadow-sm backdrop-blur-sm">
          <span className="size-1.5 rounded-full bg-brand animate-pulse" />
          <span>{t.hero.badge}</span>
        </div>

        {/* Headline */}
        <h1 className="mx-auto mt-6 max-w-4xl text-balance text-4xl font-bold leading-[1.08] tracking-tight md:text-6xl">
          {t.hero.headline}
        </h1>
        <p className="mt-4 text-xl font-medium text-muted-foreground md:text-2xl">
          {t.hero.subheadline}
        </p>
        <p className="mx-auto mt-5 max-w-2xl text-balance text-base leading-relaxed text-muted-foreground md:text-lg">
          {t.hero.lead}
        </p>

        {/* CTA row */}
        <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <CopyableCommand command="npm i -g @surething/cockpit" />
          <a
            href={TRY_ONLINE_URL}
            target="_blank"
            rel="noreferrer"
            className="lift inline-flex items-center gap-2 rounded-lg bg-brand px-5 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-teal-10"
          >
            {t.hero.tryOnline}
            <span aria-hidden>↗</span>
          </a>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="lift inline-flex items-center gap-2 rounded-lg border border-border bg-card px-5 py-2.5 text-sm font-medium text-foreground hover:border-brand/50"
          >
            ★ {t.hero.githubStar}
          </a>
        </div>

        {/* Video */}
        <div className="mx-auto mt-16 max-w-4xl">
          <BrowserFrame label="cockpit — the cockpit that drives AI" fade={false}>
            <video
              src={VIDEO_URL}
              controls
              playsInline
              preload="metadata"
              className="absolute inset-0 h-full w-full bg-slate-2 object-cover"
              aria-label={t.hero.videoNotice}
            />
          </BrowserFrame>
          <p className="mt-3 text-xs text-muted-foreground">{t.hero.videoNotice}</p>
        </div>
      </div>

      {/* anchor: locale unused but kept for future per-locale UTM tags */}
      <span data-locale={locale} className="sr-only" />
    </section>
  );
}
