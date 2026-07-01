import type { Messages } from '@/content/messages';

const STACK = [
  'Next.js 16',
  'React 19',
  'TypeScript',
  'TailwindCSS',
  'xterm.js',
  'node-pty',
  'Shiki',
  'tree-sitter (WASM)',
  'Claude Agent SDK',
  'Vercel AI SDK',
];

export function BuiltOn({ t }: { t: Messages }) {
  return (
    <section>
      <div className="mx-auto max-w-6xl px-6 py-20 text-center md:py-28">
        <h2 className="text-balance text-3xl font-semibold tracking-tight md:text-4xl">{t.builtOn.headline}</h2>
        <p className="mx-auto mt-3 max-w-2xl text-balance text-muted-foreground">{t.builtOn.desc}</p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-2">
          {STACK.map((s) => (
            <span
              key={s}
              className="rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-brand/40 hover:text-foreground"
            >
              {s}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
