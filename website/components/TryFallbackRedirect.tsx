/**
 * Used by app/try/page.tsx as a graceful fallback message when the
 * Cloudflare Pages Function isn't available (local `next dev`, or an
 * edge failure in production).
 *
 * In production with the Function deployed, this component is never
 * rendered because Cloudflare's _routes.json routes /try to the
 * Function before the static HTML is served. The component therefore
 * just explains what's happening — it does NOT redirect anywhere.
 *
 * (Earlier versions redirected to `https://e2b-nu.vercel.app/api/try`
 * — that Vercel deployment was retired when the demo handler moved to
 * `website/functions/try.ts`. Keeping a redirect to a dead URL was
 * worse than no redirect, so the bounce was removed.)
 */
export function TryFallbackRedirect() {
  return (
    <div className="text-muted-foreground text-sm space-y-2 max-w-md">
      <p>
        The Cockpit demo runs on a Cloudflare Pages Function that&apos;s
        only available on the deployed site.
      </p>
      <p>
        Open{' '}
        <a href="https://cocking.cc/try" className="text-brand underline">
          cocking.cc/try
        </a>{' '}
        to launch a sandbox, or run{' '}
        <code className="text-xs font-mono bg-secondary/40 px-1.5 py-0.5 rounded">
          npm run preview
        </code>{' '}
        in <code className="text-xs font-mono">website/</code> to emulate
        the Function locally via wrangler.
      </p>
    </div>
  );
}
