'use client';

import { useEffect } from 'react';
import posthog from 'posthog-js';

/**
 * Product analytics (PostHog, US cloud). Initialized only in production
 * builds so `npm run dev` / `npm run preview` stay clean — same philosophy
 * as the env-gated Plausible script in `app/layout.tsx`.
 *
 * The `phc_` key is a public write-only token; committing it is safe and
 * expected (it ships in the client bundle either way).
 *
 * `defaults: '2025-05-24'` opts into history-change pageview capture, so
 * client-side route transitions (App Router <Link> navigations) are tracked
 * as `$pageview` without manual instrumentation.
 */
const POSTHOG_KEY = 'phc_DpdpgKHnzfkDzBvVtGEE6oa8sPH6Q9M8FZ9Bmk7mbeed';
const POSTHOG_HOST = 'https://us.i.posthog.com';

export function PostHogAnalytics() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    posthog.init(POSTHOG_KEY, {
      api_host: POSTHOG_HOST,
      defaults: '2025-05-24',
    });
  }, []);

  return null;
}
