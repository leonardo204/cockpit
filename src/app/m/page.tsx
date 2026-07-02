import { Metadata } from 'next';
import { getGlobalSessionsSnapshot } from '@cockpit/feature-agent/server/state/globalState';
import MobileClient from './MobileClient';

// Disable static pre-rendering; use dynamic rendering (mirrors the root page).
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Cockpit',
};

interface MobilePageProps {
  searchParams: Promise<{ cwd?: string; sessionId?: string }>;
}

export default async function MobilePage({ searchParams }: MobilePageProps) {
  const { cwd, sessionId } = await searchParams;
  // SSR the session-list snapshot (local file reads, <50ms) so the list paints
  // with the HTML instead of waiting for JS + hydration + the WS handshake —
  // over a tunnel (ngrok) that wait is ~2s. Best-effort: on failure the list
  // simply falls back to the WS-only path it always had.
  const initialSessions = await getGlobalSessionsSnapshot().catch(() => undefined);
  return <MobileClient initialCwd={cwd} initialSessionId={sessionId} initialSessions={initialSessions} />;
}
