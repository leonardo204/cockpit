import { Metadata } from 'next';
import { Workspace } from '@cockpit/feature-workspace';
import { appTitleForCwd } from '@cockpit/shared-utils';

// Disable static pre-rendering; use dynamic rendering
export const dynamic = 'force-dynamic';

interface HomePageProps {
  searchParams: Promise<{ cwd?: string; sessionId?: string }>;
}

export async function generateMetadata({ searchParams }: HomePageProps): Promise<Metadata> {
  const params = await searchParams;
  // SSR title. Workspace re-applies the same function client-side on every
  // project switch, so the two never disagree.
  return { title: appTitleForCwd(params.cwd) };
}

export default async function Home({ searchParams }: HomePageProps) {
  const params = await searchParams;
  const { cwd, sessionId } = params;

  return <Workspace initialCwd={cwd} initialSessionId={sessionId} />;
}
