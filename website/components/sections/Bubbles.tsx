import type { Messages } from '@/content/messages';

const ICONS: Record<string, string> = {
  Browser: '🌐',
  浏览器: '🌐',
  PostgreSQL: '🐘',
  MySQL: '🐬',
  Redis: '🔴',
};

export function Bubbles({ t }: { t: Messages }) {
  return (
    <section className="bg-card/40">
      <div className="mx-auto max-w-6xl px-6 py-20 md:py-28">
        <div className="text-center">
          <h2 className="text-balance text-3xl font-semibold tracking-tight md:text-4xl">
            {t.bubbles.headline}
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-balance text-muted-foreground">{t.bubbles.desc}</p>
        </div>

        <div className="mt-12 grid grid-cols-2 gap-4 md:grid-cols-4">
          {t.bubbles.items.map((item) => (
            <div
              key={item.name}
              className="lift rounded-2xl border border-border bg-card p-5 hover:border-brand/40"
            >
              <div className="inline-flex size-11 items-center justify-center rounded-xl bg-brand/10 text-2xl">
                {ICONS[item.name] ?? '✨'}
              </div>
              <div className="mt-3 font-semibold">{item.name}</div>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{item.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
