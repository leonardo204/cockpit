import { CLAUDE2_DIR } from '@cockpit/shared-utils';
import { getSessionTitle } from '../state/globalState';
import { runSdkLoop, type BuildSdkOptions } from './shared/sdkLoop';
import { runPtyTurn } from './shared/ptyBranch';
import type { EngineSpec, RunCtx } from './types';

/** Build claude/claude2 SDK options for one attempt. claude2 overrides the config dir. */
function buildClaudeOptions(ctx: RunCtx): BuildSdkOptions {
  const { engine, permissionMode } = ctx.params;
  const isPlan = permissionMode === 'plan';
  return (abort, resume) => ({
    ...(resume && { resume }),
    ...(ctx.cwd && { cwd: ctx.cwd }),
    settingSources: ['user', 'project', 'local'] as Array<'user' | 'project' | 'local'>,
    // Permission mode: 'plan' (read-only) when requested, else skip all permission checks.
    permissionMode: (isPlan ? 'plan' : 'bypassPermissions') as 'plan' | 'bypassPermissions',
    // allowDangerouslySkipPermissions only applies to bypassPermissions.
    ...(!isPlan && { allowDangerouslySkipPermissions: true as const }),
    // Plan mode: intercept ExitPlanMode so the turn ends the first time the model presents its
    // plan (no in-session approval dialog exists; the user approves via the plan card → resend).
    ...(isPlan && {
      canUseTool: async (toolName: string, input: Record<string, unknown>) => {
        if (toolName === 'ExitPlanMode') {
          return {
            behavior: 'deny' as const,
            message:
              'Plan presented to the user. There is no approval dialog to click in this environment — the user approves by turning off Plan mode (via the plan card button) and resending, which then executes. Do not ask the user to confirm in a popup; stop here.',
            interrupt: true,
          };
        }
        return { behavior: 'allow' as const, updatedInput: input };
      },
    }),
    includePartialMessages: true,
    abortController: abort,
    // claude2 engine: override config directory to ~/.claude2.
    ...(engine === 'claude2' && { env: { ...process.env, CLAUDE_CONFIG_DIR: CLAUDE2_DIR } }),
  });
}

export const claudeSpec: EngineSpec = {
  name: 'claude',
  runner: {
    async run(ctx) {
      const { mode, engine } = ctx.params;
      // PTY mode (subscription billing) — claude/claude2 only.
      if (mode === 'pty' && (!engine || engine === 'claude' || engine === 'claude2')) {
        await runPtyTurn(ctx);
        return;
      }
      await runSdkLoop(ctx, buildClaudeOptions(ctx));
    },
    resolveTitle: (cwd, sessionId) => getSessionTitle(cwd, sessionId),
  },
};
