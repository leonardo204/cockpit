import type { Metadata } from 'next';
import { TryFallbackRedirect } from '@/components/TryFallbackRedirect';

export const metadata: Metadata = {
  title: 'Try Online',
  // Don't index — the canonical /try is the Cloudflare Pages Function
  robots: { index: false, follow: false },
};

/**
 * Static fallback for /try.
 *
 * Production (Cloudflare Pages):
 *   `functions/try.ts` intercepts /try via _routes.json BEFORE this static
 *   HTML is ever served. Visitors only see this page if the Function fails
 *   to deploy or runs into an unhandled error.
 *
 * Local dev (`npm run dev`):
 *   Next.js dev server doesn't run Pages Functions, so this page IS served.
 *   `TryFallbackRedirect` explains the situation — it no longer
 *   client-side-redirects to the legacy Vercel deployment because that
 *   deployment was retired (see `e2b/README.md`).
 *
 * To test the production flow locally, run:
 *   npm run build && npm run preview
 * which uses wrangler to emulate Cloudflare Pages including Functions.
 */
export default function TryPage() {
  return (
    <div className="min-h-screen flex items-center justify-center px-6 text-center">
      <TryFallbackRedirect />
    </div>
  );
}
