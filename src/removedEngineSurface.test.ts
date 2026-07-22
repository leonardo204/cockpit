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
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

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
