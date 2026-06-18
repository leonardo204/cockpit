import Link from 'next/link';
import type { Locale } from '@/lib/i18n';
import type { Messages } from '@/content/messages';

export function Modes({ locale, t }: { locale: Locale; t: Messages }) {
  const wf = t.modes.workflow;
  const exampleLines = wf.example.split('\n');

  return (
    <section className="border-b border-border bg-card/30">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <div className="text-center">
          <div className="text-xs font-mono uppercase tracking-wider text-brand">
            ⌘ Slash Modes
          </div>
          <h2 className="mt-2 text-3xl md:text-4xl font-semibold tracking-tight">
            {t.modes.headline}
          </h2>
          <p className="mt-3 text-muted-foreground max-w-2xl mx-auto">
            {t.modes.desc}
          </p>
        </div>

        <div className="mt-12 grid grid-cols-1 md:grid-cols-2 gap-4">
          {t.modes.items.map((item) => (
            <div
              key={item.cmd}
              className="rounded-xl border border-border bg-card p-5 hover:border-brand/40 transition-colors"
            >
              <div className="flex items-baseline gap-3">
                <code className="font-mono text-base text-brand bg-brand/10 px-2 py-0.5 rounded">
                  {item.cmd}
                </code>
                <span className="font-semibold text-sm text-foreground">
                  {item.name}
                </span>
              </div>
              <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
                {item.desc}
              </p>
            </div>
          ))}
        </div>

        <p className="mt-8 text-center text-xs text-muted-foreground font-mono">
          {t.modes.customHint}
        </p>

        {/* Workflow chaining: multiple /-and-@ command lines become one ordered run */}
        <div className="mt-10 rounded-xl border border-brand/30 bg-brand/5 p-6 md:p-8">
          <div className="md:flex md:items-start md:gap-10">
            <div className="md:flex-1">
              <div className="text-xs font-mono uppercase tracking-wider text-brand">
                {wf.tag}
              </div>
              <h3 className="mt-2 text-xl md:text-2xl font-semibold tracking-tight">
                {wf.headline}
              </h3>
              <p className="mt-3 text-sm text-muted-foreground leading-relaxed max-w-xl">
                {wf.desc}
              </p>
              <ul className="mt-4 space-y-2 text-sm">
                <li className="flex items-baseline gap-2">
                  <code className="font-mono text-brand bg-brand/10 px-1.5 py-0.5 rounded">
                    /
                  </code>
                  <span className="text-muted-foreground">{wf.mainText}</span>
                </li>
                <li className="flex items-baseline gap-2">
                  <code className="font-mono text-brand bg-brand/10 px-1.5 py-0.5 rounded">
                    @
                  </code>
                  <span className="text-muted-foreground">{wf.subText}</span>
                </li>
              </ul>
              <Link
                href={`/${locale}/docs/agent/workflows/`}
                className="mt-5 inline-block text-sm font-medium text-brand hover:underline"
              >
                {wf.link}
              </Link>
            </div>

            <div className="mt-6 md:mt-0 md:w-80 shrink-0">
              <pre className="rounded-lg border border-border bg-card p-4 font-mono text-sm leading-relaxed overflow-x-auto">
                {exampleLines.map((line, i) => {
                  const isCommand = /^[/@]/.test(line);
                  return (
                    <div
                      key={i}
                      className={isCommand ? 'text-brand' : 'text-muted-foreground'}
                    >
                      {line}
                    </div>
                  );
                })}
              </pre>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
