/**
 * File detail endpoint — symbol tree for the right-side function drawer.
 *
 * GET /api/projectGraph/file?cwd=<abs>&path=<rel>
 *
 * Returns the file's symbol tree (functions, classes, methods …) so the
 * Code Map canvas can render function-level children when the user expands
 * a file node, and so the drawer can list a file's symbols alongside the
 * code body of the one being viewed.
 *
 * Backed by the same code index as `/api/projectGraph`, so this is a cheap
 * projection from cached data after the first build for a given cwd.
 *
 * Status codes:
 *   200 — FileDetailResponse JSON
 *   400 — missing cwd / path
 *   404 — file is not in the index (unsupported language, beyond cap …)
 *   500 — build failed
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  fileDetailFromIndex,
  getCodeIndex,
  invalidateIndex,
} from '@/lib/codeMap/projectGraph/codeIndex';
import { validateCwd } from '@/lib/files/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const cwdParam = request.nextUrl.searchParams.get('cwd');
  const filePath = request.nextUrl.searchParams.get('path');
  const cwdCheck = await validateCwd(cwdParam);
  if (!cwdCheck.ok) {
    return NextResponse.json({ error: cwdCheck.reason }, { status: 400 });
  }
  const cwd = cwdCheck.abs;
  if (!filePath) {
    return NextResponse.json({ error: 'Missing path parameter' }, { status: 400 });
  }

  try {
    const index = await getCodeIndex(cwd);
    const detail = fileDetailFromIndex(index, filePath);
    if (!detail) {
      return NextResponse.json(
        {
          error: 'File not in index',
          hint: 'File may be an unsupported language or beyond the file cap.',
        },
        { status: 404 },
      );
    }
    return NextResponse.json(detail);
  } catch (err) {
    console.error('[projectGraph/file] failed:', err);
    invalidateIndex(cwd);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to load file detail' },
      { status: 500 },
    );
  }
}
