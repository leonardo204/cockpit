// F1-03 acceptance test — the alternate-engine surface is UNMOUNTED.
//
// Naby is single-engine: every new tab runs the one Naby engine (nabySpec via
// /api/chat). The engine picker and the alternate engines (codex / kimi /
// ollama / deepseek) were removed. This test is the regression net that those
// surfaces stay gone.
//
// APPROACH — filesystem-level assertion (not a live HTTP harness).
//   Next.js App Router mounting is FILE-BASED: a route `/api/x` resolves to a
//   handler iff `src/app/api/x/route.ts` exists. So "GET /api/chat/codex returns
//   404 / is unmounted" is EXACTLY equivalent to "src/app/api/chat/codex/route.ts
//   does not exist". A full server harness (boot Next, fetch each path, assert
//   404) would add a heavy dependency for zero extra signal over the file check,
//   because the mount table IS the filesystem. We therefore assert the route
//   files / handler impls / client pickers are gone, that no bash/pty/terminal
//   route dir was ever mounted, and that the chrome-extension/ subproject is
//   absent — while a positive control confirms the surviving /api/chat mount is
//   still present (so the test can't pass by pointing at the wrong root).
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

// This file lives at <shellRoot>/src/removedEngineSurface.test.ts
const shellRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const at = (...p: string[]) => resolve(shellRoot, ...p);

const ALT_ENGINES = ['codex', 'kimi', 'ollama', 'deepseek'] as const;

describe('F1-03 — alternate-engine surface is unmounted', () => {
  it('positive control: the single surviving chat mount exists', () => {
    // Guards against a false pass from resolving the wrong root: if this ever
    // fails, the "absent" assertions below prove nothing.
    expect(existsSync(at('src/app/api/chat/route.ts'))).toBe(true);
  });

  it.each(ALT_ENGINES)('POST /api/chat/%s is not mounted (route file absent)', (engine) => {
    expect(existsSync(at('src/app/api/chat', engine, 'route.ts'))).toBe(false);
    expect(existsSync(at('src/app/api/chat', engine))).toBe(false);
  });

  it.each(ALT_ENGINES)('the /api/chat/%s handler impl is deleted', (engine) => {
    expect(
      existsSync(at('packages/feature/agent/src/server/api/chat', `${engine}.ts`)),
    ).toBe(false);
  });

  it('the ollama config/models/start routes + impls are unmounted', () => {
    for (const sub of ['config', 'models', 'start']) {
      expect(existsSync(at('src/app/api/ollama', sub, 'route.ts'))).toBe(false);
    }
    expect(existsSync(at('src/app/api/ollama'))).toBe(false);
    expect(existsSync(at('packages/feature/agent/src/server/api/ollama'))).toBe(false);
  });

  it('the deepseek credentials route + impl are unmounted', () => {
    expect(existsSync(at('src/app/api/deepseek/credentials/route.ts'))).toBe(false);
    expect(existsSync(at('src/app/api/deepseek'))).toBe(false);
    expect(existsSync(at('packages/feature/agent/src/server/api/deepseek'))).toBe(false);
  });

  it('no bash / pty / terminal chat route dir is mounted under /api', () => {
    for (const p of ['bash', 'pty', 'terminal']) {
      expect(existsSync(at('src/app/api', p))).toBe(false);
      expect(existsSync(at('src/app/api/chat', p))).toBe(false);
    }
  });

  it('the alt-engine client pickers are deleted', () => {
    expect(
      existsSync(at('packages/feature/agent/src/client/OllamaModelPicker.tsx')),
    ).toBe(false);
    expect(
      existsSync(at('packages/feature/agent/src/client/DeepseekConfigPicker.tsx')),
    ).toBe(false);
  });

  it('the chrome-extension/ subproject directory is absent', () => {
    expect(existsSync(at('chrome-extension'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// V5 — the vendor engine SPECS are unreachable from every product path.
// (harness-standalone §2.4: "cockpit 엔진 스펙들은 도달 불가가 된다. 코드 삭제는
// 후속 정리로 남긴다 — 도달 불가 확인 테스트만 둔다".)
// ---------------------------------------------------------------------------
//
// The spec FILES stay for now (deleting them is a separate cleanup, §5), so
// "unreachable" cannot be asserted by absence. It is asserted by IMPORT GRAPH:
// the only module that imports the vendor specs is the registry, and the only
// thing that read the registry was the scheduled-task dispatcher — which now
// names `nabySpec` directly. Nothing left in `packages/` or `src/` calls
// `getEngineSpec`, so no runtime value can ever be a vendor spec.
//
// A SOURCE ASSERTION, deliberately. There is no runtime moment at which one can
// observe "the vendor spec was not selected"; the property is about the shape of
// the code, and the shape is what a future edit would change. Both greps below
// EXCLUDE this file and the registry itself, and a positive control proves the
// scan actually reads files (a broken walk would otherwise "prove" everything).

const CODE_ROOTS = ['packages', 'src'];
const VENDOR_SPECS = ['claudeSpec', 'codexSpec', 'deepseekSpec', 'kimiSpec', 'ollamaSpec'] as const;

/** Source text with comments removed, so a spec named in PROSE (a comment
 *  explaining why the route no longer uses it) is not mistaken for a use. That
 *  is not hypothetical: `api/chat.ts` documents the fork change that pointed it
 *  away from `claudeSpec`, and a naive grep reads that as a dependency. */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Every .ts/.tsx file under the given roots, excluding the engine registry
 *  (which legitimately imports the specs) and this test. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const skipDirs = new Set(['node_modules', '.next', '.next-prod', 'dist']);
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (skipDirs.has(name)) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(name)) out.push(full);
    }
  };
  for (const root of CODE_ROOTS) walk(at(root));
  return out.filter(
    (f) =>
      !f.endsWith(join('server', 'engines', 'registry.ts')) &&
      !f.endsWith(join('src', 'removedEngineSurface.test.ts')),
  );
}

describe('V5 — no product path can dispatch a vendor engine spec', () => {
  it('positive control: the scan really reads source (it finds nabySpec)', () => {
    const users = sourceFiles().filter((f) => codeOf(f).includes('nabySpec'));
    expect(users.length).toBeGreaterThan(0);
  });

  it.each(VENDOR_SPECS)('%s is imported by nothing but the registry', (spec) => {
    const users = sourceFiles().filter((f) => {
      const text = codeOf(f);
      // The engine's OWN file declares it; that is not a use.
      if (text.includes(`export const ${spec}`)) return false;
      return text.includes(spec);
    });
    expect(users).toEqual([]);
  });

  it('getEngineSpec has no caller left — the registry is a dead end', () => {
    const callers = sourceFiles().filter((f) => codeOf(f).includes('getEngineSpec'));
    expect(callers).toEqual([]);
  });

  it('the scheduled-task dispatcher imports the naby spec directly', () => {
    // The one background dispatcher there is. If this ever goes back to a
    // name-keyed lookup, a task field on disk chooses the backend again.
    const src = codeOf(at('packages/feature/agent/src/server/scheduledTasks.ts'));
    expect(src).toContain("from './engines/naby'");
    expect(src).not.toContain('getEngineSpec');
  });
});

// ---------------------------------------------------------------------------
// V8 — the leftover vendor-directory readers/writers are gone.
// (harness-standalone §2.5.)
// ---------------------------------------------------------------------------

describe('V8 — no side path reads or writes a vendor harness directory', () => {
  it('/api/claude-stats is unmounted and its implementation is deleted', () => {
    // It scanned `~/.claude/projects` and `~/.claude2/projects` for every jsonl
    // the vendor CLI ever wrote. The usage modal has read `app.db` since the
    // stats re-backing, so this was dead — and dead code that reads a vendor
    // directory is still code that reads a vendor directory.
    expect(existsSync(at('src/app/api/claude-stats/route.ts'))).toBe(false);
    expect(existsSync(at('src/app/api/claude-stats'))).toBe(false);
    expect(existsSync(at('packages/feature/agent/src/server/api/claude-stats.ts'))).toBe(false);
    // Positive control: the surviving stats mount is still there.
    expect(existsSync(at('src/app/api/naby/stats/route.ts'))).toBe(true);
  });

  it('the dead client wrapper for it is deleted too', () => {
    const client = codeOf(at('packages/feature/agent/src/client/effect/agentClient.ts'));
    expect(client).not.toContain('loadClaudeStats');
    expect(client).not.toContain('/api/claude-stats');
    // Positive control: the wrapper that replaced it is still exported.
    expect(client).toContain('loadNabyStats');
  });

  it('the retention sweep names no vendor directory', () => {
    // The one background pass that DELETES files. Its root must stay inside the
    // app's own data dir; a vendor path here would make an unattended timer the
    // only thing in the product writing to another product's directory.
    const sweep = codeOf(at('packages/feature/agent/src/effect/sessionCleanupLive.ts'));
    for (const vendor of ['.claude', '.claude2', '.codex', '.kimi']) {
      expect(sweep).not.toContain(vendor);
    }
    expect(sweep).toContain('ollama-sessions');
  });
});
