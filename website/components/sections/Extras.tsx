import type { Messages } from '@/content/messages';

export function Extras({ t }: { t: Messages }) {
  const items = [
    {
      tag: '⏱ Automation',
      title: t.extras.schedule.title,
      desc: t.extras.schedule.desc,
    },
    {
      tag: t.extras.skills.tag,
      title: t.extras.skills.title,
      desc: t.extras.skills.desc,
    },
  ];

  return (
    <section className="bg-card/40">
      <div className="mx-auto max-w-5xl px-6 py-20 md:py-28">
        <div className="grid gap-6 md:grid-cols-2">
          {items.map((it) => (
            <div
              key={it.title}
              className="lift rounded-2xl border border-border bg-card p-7 text-center hover:border-brand/40"
            >
              <div className="font-mono text-xs uppercase tracking-wider text-brand">
                {it.tag}
              </div>
              <h3 className="mt-2 text-xl font-semibold">{it.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {it.desc}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
