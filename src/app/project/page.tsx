import { Metadata } from 'next';
import { TabManager } from '@cockpit/feature-workspace';
import { appTitleForCwd } from '@cockpit/shared-utils';

// Disable static pre-rendering; use dynamic rendering (fixes SSR hooks issues)
export const dynamic = 'force-dynamic';

interface ProjectPageProps {
  searchParams: Promise<{ cwd?: string; sessionId?: string }>;
}

export async function generateMetadata({ searchParams }: ProjectPageProps): Promise<Metadata> {
  const params = await searchParams;
  // This page renders INSIDE the workspace iframe, so its title is not what the
  // OS window shows (the parent's is). Kept correct anyway: it is what a
  // developer sees when opening /project directly.
  return { title: appTitleForCwd(params.cwd) };
}

export default async function ProjectPage({ searchParams }: ProjectPageProps) {
  const params = await searchParams;
  const { cwd, sessionId } = params;

  return <TabManager initialCwd={cwd} initialSessionId={sessionId} />;
}
