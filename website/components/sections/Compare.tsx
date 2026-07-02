import type { Messages } from '@/content/messages';

export function Compare({ t }: { t: Messages }) {
  const c = t.compare;
  return (
    <section className="bg-card/40">
      <div className="mx-auto max-w-6xl px-6 py-20 md:py-28">
        <h2 className="text-balance text-center text-3xl font-semibold tracking-tight md:text-4xl">
          {c.headline}
        </h2>
        <p className="mx-auto mt-3 max-w-2xl text-balance text-center text-muted-foreground">
          {c.sub}
        </p>
        <div className="mt-10 overflow-x-auto rounded-2xl border border-border bg-card">
          <table className="w-full min-w-[760px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="w-44 px-4 py-3" />
                {c.columns.map((col, i) => (
                  <th
                    key={col}
                    className={
                      i === 0
                        ? 'px-4 py-3 font-semibold text-brand'
                        : 'px-4 py-3 font-semibold'
                    }
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {c.rows.map((r) => (
                <tr key={r.dim} className="border-b border-border/60 last:border-0">
                  <th
                    scope="row"
                    className="px-4 py-3 text-left align-top font-medium text-muted-foreground"
                  >
                    {r.dim}
                  </th>
                  <td className="px-4 py-3 align-top">{r.us}</td>
                  <td className="px-4 py-3 align-top text-muted-foreground">{r.official}</td>
                  <td className="px-4 py-3 align-top text-muted-foreground">{r.opcode}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mx-auto mt-6 max-w-3xl space-y-1 text-center text-sm text-muted-foreground">
          {c.picks.map((p) => (
            <p key={p}>{p}</p>
          ))}
        </div>
      </div>
    </section>
  );
}
