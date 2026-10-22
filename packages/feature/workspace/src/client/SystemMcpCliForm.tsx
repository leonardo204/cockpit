/**
 * A LOCAL-CLI System MCP preset's controls (skill-hub-builtin §2.8) — today the
 * Aside browser (`aside mcp` over stdio).
 *
 * There is nothing to type: the preset has no fields. What the user needs to
 * know is which of three states the machine is in, and the one button that
 * moves it forward:
 *
 *   CLI missing → install guidance + "Check again" (Connect disabled)
 *   Ready       → Connect (creates the entry, enabled)
 *   Connected   → Disconnect (deletes the entry)
 *
 * PRESENTATIONAL ONLY. The posts live with the caller (NabyProviderSetup.tsx),
 * so the three states can be pinned with `renderToStaticMarkup` and no network.
 * Chosen by the preset's `cli` flag, never by its name.
 */
import { useTranslation } from 'react-i18next';
import type { SystemMcpPresetView, SystemMcpStatus } from './systemMcpPresets';

export type SystemMcpCliPhase = 'checking' | 'missing' | 'ready' | 'connected';

/** Which state the card is in. A configured entry is connected whatever the CLI
 *  probe says — an entry the user added by hand before the preset existed counts
 *  too, so it is never offered a second time. */
export function systemMcpCliPhase(
  state: SystemMcpStatus,
  cliFound: boolean | undefined,
): SystemMcpCliPhase {
  if (state.configured) return 'connected';
  if (cliFound === undefined) return 'checking';
  return cliFound ? 'ready' : 'missing';
}

const primaryButton =
  'shrink-0 px-3 py-1.5 text-xs font-medium rounded bg-brand text-white disabled:opacity-40';
const secondaryButton =
  'shrink-0 px-2 py-1.5 text-xs rounded border border-border text-muted-foreground hover:text-foreground disabled:opacity-40';

export function SystemMcpCliControls({
  preset,
  state,
  cliFound,
  busy,
  note,
  onConnect,
  onDisconnect,
  onCheck,
}: {
  preset: SystemMcpPresetView;
  state: SystemMcpStatus;
  /** Whether the CLI resolved, as last reported; undefined = not known yet. */
  cliFound: boolean | undefined;
  busy: boolean;
  note: { text: string; ok: boolean } | null;
  onConnect: () => void;
  onDisconnect: () => void;
  onCheck: () => void;
}) {
  const { t } = useTranslation();
  const phase = systemMcpCliPhase(state, cliFound);

  return (
    <div
      className="space-y-1.5"
      data-testid={`system-mcp-cli-${preset.name}`}
      data-phase={phase}
    >
      {phase === 'connected' && (
        <>
          <p className="text-xs text-muted-foreground">{t('systemMcp.cli.connectedNote')}</p>
          <div className="flex items-center gap-2">
            <button onClick={onDisconnect} disabled={busy} className={secondaryButton}>
              {t('systemMcp.cli.disconnect')}
            </button>
          </div>
        </>
      )}

      {phase === 'missing' && (
        <>
          <p className="text-xs text-warning">{t('systemMcp.cli.missing')}</p>
          <p className="text-xs text-muted-foreground">{t('systemMcp.cli.installHint')}</p>
          <div className="flex items-center gap-2">
            <button disabled className={primaryButton}>
              {t('systemMcp.connect')}
            </button>
            <button onClick={onCheck} disabled={busy} className={secondaryButton}>
              {t('systemMcp.cli.checkAgain')}
            </button>
          </div>
        </>
      )}

      {(phase === 'ready' || phase === 'checking') && (
        <>
          <p className="text-xs text-muted-foreground">
            {t(phase === 'ready' ? 'systemMcp.cli.ready' : 'systemMcp.cli.checking')}
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={onConnect}
              disabled={busy || phase !== 'ready'}
              className={primaryButton}
            >
              {busy ? t('systemMcp.connecting') : t('systemMcp.connect')}
            </button>
          </div>
        </>
      )}

      <p className="text-xs text-muted-foreground">{t('systemMcp.cli.remoteHint')}</p>
      {note && (
        <p className={`text-xs ${note.ok ? 'text-success' : 'text-destructive'}`}>{note.text}</p>
      )}
    </div>
  );
}
