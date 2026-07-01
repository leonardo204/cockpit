import type { Messages } from '@/content/messages';

export function ValueProp({ t }: { t: Messages }) {
  return (
    <section className="bg-card/40">
      <div className="mx-auto max-w-6xl px-6 py-20 md:py-28">
        <h2 className="text-balance text-center text-3xl font-semibold tracking-tight md:text-4xl">
          {t.valueProp.headline}
        </h2>
        <div className="mt-12 grid grid-cols-1 gap-6 md:grid-cols-3">
          {t.valueProp.points.map((p) => (
            <div
              key={p.title}
              className="lift rounded-2xl border border-border bg-card p-6 hover:border-brand/40"
            >
              <div className="text-base font-semibold">{p.title}</div>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{p.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
