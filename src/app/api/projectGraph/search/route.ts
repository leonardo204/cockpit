/**
 * Search endpoint — Cmd+K palette in the architecture map.
 *
 * GET /api/projectGraph/search?cwd=<abs>&q=<query>&limit=<int>
 *
 * Returns categorized hits (modules, files, symbols) with navigation targets
 * the client can plug straight into the drill state machine. Backed by the
 * cached project code index, so first hit may be slow (full project parse)
 * but subsequent searches are <10ms regardless of project size.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCodeIndex, searchIndex } from '@/lib/codeMap/projectGraph/codeIndex';
import { validateCwd } from '@/lib/files/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const cwdParam = request.nextUrl.searchParams.get('cwd');
  const q = request.nextUrl.searchParams.get('q') ?? '';
  const limit = Math.min(
    Math.max(parseInt(request.nextUrl.searchParams.get('limit') ?? '15', 10) || 15, 1),
    100,
  );
  const cwdCheck = await validateCwd(cwdParam);
  if (!cwdCheck.ok) {
    return NextResponse.json({ error: cwdCheck.reason }, { status: 400 });
  }
  const cwd = cwdCheck.abs;
  if (q.trim().length < 1) {
    return NextResponse.json({ modules: [], files: [], symbols: [] });
  }

  try {
    const index = await getCodeIndex(cwd);
    return NextResponse.json(searchIndex(index, q, limit));
  } catch (err) {
    console.error('[projectGraph/search] failed:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Search failed' },
      { status: 500 },
    );
  }
}
