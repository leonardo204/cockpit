#!/usr/bin/env node
/**
 * Copy tree-sitter WASM grammars from node_modules into public/tree-sitter/.
 *
 * Sources:
 *   - node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-<lang>.wasm  (devDep, prebuilt grammars)
 *   - node_modules/web-tree-sitter/web-tree-sitter.wasm                  (runtime, regular dep)
 *
 * Destination: public/tree-sitter/
 *
 * Why @vscode/tree-sitter-wasm: it ships WASMs whose ABI matches modern
 * `web-tree-sitter` (0.25+). The previously-tried `tree-sitter-wasms` package
 * pinned `tree-sitter-cli@0.20.x` and produced WASMs without the dylink section
 * required by newer runtimes ("need dylink section" error).
 *
 * The list of grammars MUST stay in sync with `SUPPORTED_GRAMMARS` in
 * `src/lib/codeMap/languageMap.ts`. Add a name here and bump the WASM in.
 *
 * Behaviour:
 *   - Idempotent: skips files that already match by size + mtime.
 *   - Graceful: if the source package is missing (production install without
 *     devDeps), logs a notice and exits 0 — the WASMs are expected to be
 *     present from the published `public/` directory in that case.
 */

import { existsSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PROJECT_ROOT = join(SCRIPT_DIR, '..');

// Keep this list aligned with SUPPORTED_GRAMMARS in src/lib/codeMap/languageMap.ts.
const GRAMMARS = ['typescript', 'tsx', 'javascript', 'python', 'go', 'rust'];

function copyIfChanged(src, dst, label) {
  if (!existsSync(src)) {
    console.warn(`[copy-tree-sitter-wasms] missing source: ${label} (${src}) — skipping`);
    return false;
  }
  if (existsSync(dst)) {
    const a = statSync(src);
    const b = statSync(dst);
    if (a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 1000) return false;
  }
  copyFileSync(src, dst);
  console.log(`[copy-tree-sitter-wasms] ✓ ${label}`);
  return true;
}

/**
 * Copy WASMs into `<projectRoot>/public/tree-sitter/`. Idempotent:
 * skips files that already match by size + mtime.
 *
 * @param projectRoot Absolute project root. Defaults to the repo this
 *   script lives in. `bin/postinstall.mjs` passes the consuming
 *   project's root explicitly so the helper works from inside a
 *   nested node_modules tree.
 * @returns true if at least one file was copied (or warned about);
 *   false if everything was already up-to-date and nothing happened.
 */
export function copyTreeSitterWasms(projectRoot = SCRIPT_PROJECT_ROOT) {
  const destDir = join(projectRoot, 'public', 'tree-sitter');
  const grammarSrcDir = join(projectRoot, 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm');
  const runtimeSrc = join(projectRoot, 'node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm');

  mkdirSync(destDir, { recursive: true });

  if (!existsSync(grammarSrcDir)) {
    // Production install (no devDeps) — WASMs are already vendored in public/.
    // Verify and bail.
    const allPresent = GRAMMARS.every((g) =>
      existsSync(join(destDir, `tree-sitter-${g}.wasm`)),
    );
    if (!allPresent) {
      console.warn(
        '[copy-tree-sitter-wasms] @vscode/tree-sitter-wasm not installed and grammar files missing in public/tree-sitter/. ' +
          'Code Map symbol extraction will be unavailable. Install devDeps or vendor the WASMs.',
      );
    }
    return false;
  }

  let copied = 0;
  for (const g of GRAMMARS) {
    const src = join(grammarSrcDir, `tree-sitter-${g}.wasm`);
    const dst = join(destDir, `tree-sitter-${g}.wasm`);
    if (copyIfChanged(src, dst, `tree-sitter-${g}.wasm`)) copied++;
  }
  if (copyIfChanged(runtimeSrc, join(destDir, 'web-tree-sitter.wasm'), 'web-tree-sitter.wasm')) copied++;

  if (copied === 0) {
    console.log('[copy-tree-sitter-wasms] all WASMs already up to date');
  }
  return true;
}

// Run as CLI when invoked directly (`node scripts/copy-tree-sitter-wasms.mjs`).
// Detection: compare import.meta.url to the resolved argv[1] file URL. If
// imported as a module (e.g. by bin/postinstall.mjs), this branch is skipped
// and only the export above is exposed.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  copyTreeSitterWasms();
}
