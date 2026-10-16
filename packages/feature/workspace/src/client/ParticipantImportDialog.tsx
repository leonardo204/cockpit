'use client';

/**
 * IMPORTING A PARTICIPANT (multi-agent-chat R4, R5.3, §8.5; agent-import-adapters
 * §2–§4, MAC-M4).
 *
 * Two steps, the same as the agent import (agent-export §7.4): pick a file → the
 * server PARSES it and answers with a plan, writing nothing → the user sees what
 * comes in, what does not, and the safety facts, fixes the description naby will
 * route on if it needs fixing → Import writes it.
 *
 * What the preview shows, in order:
 *   * safety badges — always a participant (the path decides the kind, never the
 *     file), secrets masked, a rename, tools granted, the source hash;
 *   * the decisions — display name, handle, description (editable);
 *   * the mapping table — what each part of the participant will be;
 *   * the loss report — every field that did not come in as-is, with an icon per
 *     action (kept / merged / dropped / defaulted). A silent drop would leave the
 *     user believing everything came in (agent-import-adapters §1.2).
 *
 * Drawn inline in the participants section (like the editor), not as a modal on
 * top of the Settings modal.
 */

import { memo, useCallback, useRef, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@cockpit/shared-ui';
import { ParticipantAvatar, announceParticipantsChanged } from '@cockpit/feature-agent';

type TFunction = ReturnType<typeof useTranslation>['t'];

// ---------------------------------------------------------------------------
// Wire shapes (`participant.import`) — declared locally: this panel is an HTTP
// client, like the rest of this package.
// ---------------------------------------------------------------------------

export type ImportLossWire = {
  field: string;
  action: 'kept-in-extensions' | 'merged' | 'dropped' | 'defaulted';
  into?: string;
  note: string;
  value?: string;
};

export type ImportAvatarWire = { kind: 'emoji'; value: string } | { kind: 'image'; dataUrl: string };

export type ImportWire = {
  format: string;
  agent: {
    name: string;
    description?: string;
    systemPrompt: string;
    model?: string;
    toolRefs: string[];
    memoryScope: string;
    profile: {
      displayName: string;
      avatar: ImportAvatarWire;
      color: string;
      greeting?: string;
      examples?: { user: string; assistant: string }[];
      knowledge: { id: string; title: string; inject: 'always' | 'on-demand' }[];
      guardrails: { policy?: string; permissionMode?: 'default' | 'plan' };
      mcpServers: string[];
      skills: string[];
      origin?: { format: string; importedAt: number; sourceHash: string; sourceName?: string };
    };
  };
  losses: ImportLossWire[];
  warnings: string[];
  report: { renamedFrom?: string; sourceHash: string; secretsRedacted: number };
  applied: boolean;
};

export type ImportDecisions = { name: string; displayName: string; description: string };

// ---------------------------------------------------------------------------
// Pure helpers (shared with the participant card's origin badge)
// ---------------------------------------------------------------------------

export function importFormatLabel(t: TFunction, format: string): string {
  const fallback: Record<string, string> = {
    'claude-agent-md': 'Claude Code subagent',
    'naby-sidecar': 'naby export',
    'character-card-v2': 'Character card V2',
    'character-card-v3': 'Character card V3',
  };
  return t(`participantImport.format.${format}`, { defaultValue: fallback[format] ?? format });
}

/** `YYYY-MM-DD` in local time — the day the user imported it. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** "Character card V2 · 2026-10-16" */
export function originBadgeText(t: TFunction, origin: { format: string; importedAt: number }): string {
  return t('participants.settings.origin', {
    defaultValue: '{{format}} · {{date}}',
    format: importFormatLabel(t, origin.format),
    date: localDay(origin.importedAt),
  });
}

/** The server's `error` (problems joined by `; `) as translated sentences. */
export function importProblemText(t: TFunction, error: string): string {
  const KEYS = [
    'unrecognized format',
    'charx not supported yet',
    'png-no-card',
    'card-unreadable',
    'card-no-name',
    'empty-instructions',
    'not-json',
    'not-a-naby-export',
    'newer-format',
    'no-name',
    'profile-invalid',
  ];
  return error
    .split('; ')
    .map((p) => {
      const key = KEYS.find((k) => p === k || p.startsWith(`${k}:`));
      return key ? t(`participantImport.problem.${key}`, { defaultValue: p }) : p;
    })
    .join(' ');
}

const ACTION_ICON: Record<ImportLossWire['action'], string> = {
  'kept-in-extensions': '📦',
  merged: '🔀',
  dropped: '✂️',
  defaulted: '↺',
};

const ACTION_TONE: Record<ImportLossWire['action'], string> = {
  'kept-in-extensions': 'text-muted-foreground',
  merged: 'text-brand',
  dropped: 'text-destructive',
  defaulted: 'text-warning',
};

const FIELD = 'text-xs px-2 py-1.5 rounded-md border border-border bg-background text-foreground';
const LABEL = 'text-[0.714rem] font-semibold text-muted-foreground';
const BADGE = 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.714rem] font-semibold';

// ---------------------------------------------------------------------------
// The preview (pure props → markup; rendered statically in tests)
// ---------------------------------------------------------------------------

export interface ParticipantImportPreviewProps {
  fileName: string;
  preview: ImportWire;
  decisions: ImportDecisions;
  busy: boolean;
  onDecisions: (d: ImportDecisions) => void;
  onConfirm: () => void;
  onCancel: () => void;
  onAnother: () => void;
}

export const ParticipantImportPreview = memo(function ParticipantImportPreview({
  fileName,
  preview,
  decisions,
  busy,
  onDecisions,
  onConfirm,
  onCancel,
  onAnother,
}: ParticipantImportPreviewProps) {
  const { t } = useTranslation();
  const { agent, losses, warnings, report } = preview;
  const p = agent.profile;
  const always = p.knowledge.filter((k) => k.inject === 'always').length;
  const none = t('participantImport.value.none', { defaultValue: '—' });
  const list = (xs: string[]) => (xs.length > 0 ? xs.join(', ') : none);

  const rows: [string, string][] = [
    [
      t('participantImport.row.instructions', { defaultValue: 'Instructions' }),
      t('participantImport.value.chars', { defaultValue: '{{count}} characters', count: agent.systemPrompt.length }),
    ],
    [t('participantImport.row.greeting', { defaultValue: 'Greeting' }), p.greeting ?? none],
    [
      t('participantImport.row.examples', { defaultValue: 'Examples' }),
      p.examples?.length ? t('participantImport.value.count', { defaultValue: '{{count}}', count: p.examples.length }) : none,
    ],
    [
      t('participantImport.row.knowledge', { defaultValue: 'Knowledge' }),
      p.knowledge.length > 0
        ? t('participantImport.value.knowledge', {
            defaultValue: '{{count}} ({{always}} always, {{onDemand}} on demand)',
            count: p.knowledge.length,
            always,
            onDemand: p.knowledge.length - always,
          })
        : none,
    ],
    [t('participantImport.row.policy', { defaultValue: 'Guardrail policy' }), p.guardrails.policy ?? none],
    [t('participantImport.row.permissionMode', { defaultValue: 'Permission mode' }), p.guardrails.permissionMode ?? 'default'],
    [t('participantImport.row.tools', { defaultValue: 'Tools' }), list(agent.toolRefs)],
    [t('participantImport.row.mcpServers', { defaultValue: 'MCP servers' }), list(p.mcpServers)],
    [t('participantImport.row.skills', { defaultValue: 'Skills' }), list(p.skills)],
    [
      t('participantImport.row.model', { defaultValue: 'Model' }),
      agent.model ?? t('participantImport.value.sessionModel', { defaultValue: 'Session model' }),
    ],
    [
      t('participantImport.row.memory', { defaultValue: 'Memory' }),
      t('participantImport.value.memorySession', { defaultValue: 'This conversation only' }),
    ],
  ];

  const promptSecret = warnings.includes('prompt-looks-secret');
  const hint = warnings.filter((w) => w !== 'prompt-looks-secret');

  return (
    <div className="space-y-3.5 rounded-xl border border-brand/40 bg-card p-4 shadow-card" data-testid="participant-import-preview">
      <div className="flex items-start gap-3">
        <ParticipantAvatar avatar={p.avatar} color={p.color} size="lg" />
        <div className="min-w-0 flex-1">
          <h3 className="text-[1rem] font-extrabold text-foreground">
            {t('participantImport.title', { defaultValue: 'Import a participant' })}
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            <span className="font-mono">{fileName}</span> · {importFormatLabel(t, preview.format)}
          </p>
        </div>
        <button type="button" onClick={onAnother} disabled={busy} className="shrink-0 text-xs text-brand hover:underline disabled:opacity-50">
          {t('participantImport.another', { defaultValue: 'Choose another file' })}
        </button>
      </div>

      {/* Safety facts, before anything else. */}
      <div className="flex flex-wrap gap-1.5" data-testid="import-badges">
        <span className={`${BADGE} bg-accent text-brand`} data-badge="participant">
          🦋 {t('participantImport.badge.participant', { defaultValue: 'Added as a participant' })}
        </span>
        {report.secretsRedacted > 0 ? (
          <span className={`${BADGE} bg-warning/10 text-warning`} data-badge="secrets">
            🔒 {t('participantImport.badge.secrets', { defaultValue: '{{count}} secret(s) masked', count: report.secretsRedacted })}
          </span>
        ) : (
          <span className={`${BADGE} bg-success/10 text-success`} data-badge="no-secrets">
            🔒 {t('participantImport.badge.noSecrets', { defaultValue: 'No secrets found' })}
          </span>
        )}
        {promptSecret ? (
          <span className={`${BADGE} bg-destructive/10 text-destructive`} data-badge="prompt-secret">
            ⚠️ {t('participantImport.badge.promptSecret', { defaultValue: 'Instructions look like they hold a credential' })}
          </span>
        ) : null}
        {report.renamedFrom ? (
          <span className={`${BADGE} bg-warning/10 text-warning`} data-badge="renamed">
            ✏️ {t('participantImport.badge.renamed', { defaultValue: 'Renamed from @{{from}}', from: report.renamedFrom })}
          </span>
        ) : null}
        <span className={`${BADGE} bg-muted text-muted-foreground`} data-badge="tools">
          🛠{' '}
          {agent.toolRefs.length === 0
            ? t('participantImport.badge.noTools', { defaultValue: 'No tools' })
            : t('participantImport.badge.tools', { defaultValue: '{{count}} tool(s)', count: agent.toolRefs.length })}
        </span>
        <span className={`${BADGE} bg-muted font-mono text-muted-foreground`} data-badge="hash" title={report.sourceHash}>
          {t('participantImport.badge.hash', { defaultValue: 'sha256 {{hash}}', hash: report.sourceHash.slice(0, 8) })}
        </span>
      </div>

      {promptSecret || hint.length > 0 ? (
        <ul className="space-y-1 border-l-2 border-warning/60 pl-2.5 text-[0.786rem] leading-relaxed text-foreground">
          {promptSecret ? (
            <li className="text-destructive">
              {t('participantImport.warning.prompt-looks-secret', {
                defaultValue: 'The instructions look like they contain a credential. They are not changed — read them before importing.',
              })}
            </li>
          ) : null}
          {hint.map((w) => (
            <li key={w} data-warning={w}>
              {t(`participantImport.warning.${w}`, { defaultValue: w })}
            </li>
          ))}
        </ul>
      ) : null}

      {/* The user's decisions. */}
      <div className="space-y-2">
        <div className="text-[0.786rem] font-bold text-foreground">
          {t('participantImport.decisions', { defaultValue: 'Before it comes in' })}
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className={LABEL}>{t('participantImport.displayName', { defaultValue: 'Display name' })}</span>
            <input
              value={decisions.displayName}
              onChange={(e) => onDecisions({ ...decisions, displayName: e.target.value })}
              className={FIELD}
              data-testid="import-display-name"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className={LABEL}>{t('participantImport.name', { defaultValue: 'Handle' })}</span>
            <div className="flex items-center gap-1">
              <span className="text-xs text-muted-foreground">@</span>
              <input
                value={decisions.name}
                onChange={(e) => onDecisions({ ...decisions, name: e.target.value })}
                className={`${FIELD} flex-1 font-mono`}
                data-testid="import-name"
              />
            </div>
          </label>
        </div>
        <label className="flex flex-col gap-1">
          <span className={LABEL}>{t('participantImport.description', { defaultValue: 'Description' })}</span>
          <textarea
            value={decisions.description}
            onChange={(e) => onDecisions({ ...decisions, description: e.target.value })}
            rows={2}
            className={`${FIELD} resize-y leading-relaxed`}
            data-testid="import-description"
          />
          <span className="text-[0.714rem] text-muted-foreground">
            {t('participantImport.descriptionHint', {
              defaultValue: "💡 naby reads this sentence to decide when to hand work over. Fix it if the file's is not about that.",
            })}
          </span>
        </label>
      </div>

      {/* What comes in. */}
      <div>
        <div className="mb-1 text-[0.786rem] font-bold text-foreground">
          {t('participantImport.mapping', { defaultValue: 'What comes in' })}
        </div>
        <table className="w-full text-[0.786rem]" data-testid="import-mapping">
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k} className="border-t border-border first:border-t-0 align-top">
                <th scope="row" className="w-36 py-1 pr-2 text-left font-semibold text-muted-foreground">
                  {k}
                </th>
                <td className="py-1 text-foreground">
                  <span className="line-clamp-2 break-words">{v}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* The loss report. */}
      <div data-testid="import-losses">
        <div className="mb-1 text-[0.786rem] font-bold text-foreground">
          {losses.length > 0
            ? t('participantImport.losses', { defaultValue: 'Not carried over as-is ({{count}})', count: losses.length })
            : t('participantImport.noLosses', { defaultValue: 'Everything in the file came in.' })}
        </div>
        {losses.length > 0 ? (
          <ul className="space-y-1">
            {losses.map((l, i) => (
              <li key={`${l.field}-${l.note}-${i}`} className="flex items-start gap-2 text-[0.786rem]" data-loss-action={l.action} data-loss-note={l.note}>
                <span aria-hidden="true" className="w-4 shrink-0 text-center">
                  {ACTION_ICON[l.action]}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`font-semibold ${ACTION_TONE[l.action]}`}>
                    {t(`participantImport.action.${l.action}`, { defaultValue: l.action })}
                  </span>{' '}
                  <span className="font-mono text-[0.714rem] text-foreground">{l.field}</span>
                  {l.value ? <span className="ml-1 font-mono text-[0.714rem] text-muted-foreground">({l.value})</span> : null}
                  <span className="block text-muted-foreground">
                    {t(`participantImport.loss.${l.note}`, { defaultValue: l.note })}
                    {l.into ? <span className="ml-1 font-mono text-[0.714rem]">{t('participantImport.into', { defaultValue: '→ {{into}}', into: l.into })}</span> : null}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="flex justify-end gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="text-xs px-3 py-1.5 rounded-md border border-border text-foreground hover:bg-accent disabled:opacity-50"
        >
          {t('participantImport.cancel', { defaultValue: 'Cancel' })}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy || !decisions.name.trim() || !decisions.displayName.trim()}
          className="text-xs px-3 py-1.5 rounded-md border border-transparent bg-primary font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          data-testid="import-confirm"
        >
          {t('participantImport.confirm', { defaultValue: 'Import' })}
        </button>
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// The picker (pure)
// ---------------------------------------------------------------------------

export const ParticipantImportPicker = memo(function ParticipantImportPicker({
  reading,
  onFile,
  onCancel,
}: {
  reading?: string;
  onFile: (file: File) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) onFile(f);
  };
  return (
    <div className="space-y-3 rounded-xl border border-brand/40 bg-card p-4 shadow-card" data-testid="participant-import-picker">
      <div>
        <h3 className="text-[1rem] font-extrabold text-foreground">
          {t('participantImport.title', { defaultValue: 'Import a participant' })}
        </h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t('participantImport.intro', {
            defaultValue: 'The file is read first and nothing is saved until you press Import. What could not come in is listed below.',
          })}
        </p>
      </div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={`flex flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed px-4 py-8 text-center text-xs ${
          over ? 'border-brand bg-accent' : 'border-border'
        }`}
        data-testid="import-dropzone"
      >
        {reading ? (
          <span className="text-muted-foreground">{t('participantImport.reading', { defaultValue: 'Reading {{name}}…', name: reading })}</span>
        ) : (
          <>
            <span className="text-foreground">
              {t('participantImport.drop', { defaultValue: 'Drop a file here, or' })}{' '}
              <button type="button" onClick={() => inputRef.current?.click()} className="font-semibold text-brand hover:underline">
                {t('participantImport.pick', { defaultValue: 'choose a file' })}
              </button>
            </span>
            <span className="text-[0.714rem] text-muted-foreground">
              {t('participantImport.formats', {
                defaultValue: 'Claude Code subagent .md · naby .naby.json (v1, v2) · character card V2/V3 (.json, .png)',
              })}
            </span>
          </>
        )}
        <input
          ref={inputRef}
          type="file"
          accept=".md,.markdown,.json,.png,.charx"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) onFile(f);
          }}
        />
      </div>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="text-xs px-3 py-1.5 rounded-md border border-border text-foreground hover:bg-accent"
        >
          {t('participantImport.cancel', { defaultValue: 'Cancel' })}
        </button>
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// The dialog, wired to `/api/naby`
// ---------------------------------------------------------------------------

/** Mirrors the server's cap (lib/participantImport.ts) so a huge file is refused
 *  before it is read and sent. */
const MAX_IMPORT_BYTES = 8 * 1024 * 1024;

async function fileToBase64(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  return btoa(bin);
}

type Reply = { ok?: boolean; error?: string; participantImport?: ImportWire; participants?: unknown };

async function postImport(body: Record<string, unknown>): Promise<Reply> {
  try {
    const res = await fetch('/api/naby', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'participant.import', ...body }),
    });
    const json = (await res.json().catch(() => null)) as Reply | null;
    if (!json) return { ok: false, error: `request failed (${res.status})` };
    return { ...json, ok: !!json.ok && res.ok };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function ParticipantImportDialog({
  cwd,
  onCancel,
  onImported,
}: {
  cwd?: string;
  onCancel: () => void;
  /** Called with the server's participant list after a successful import. */
  onImported: (participants: unknown) => void;
}) {
  const { t } = useTranslation();
  const [file, setFile] = useState<{ name: string; base64: string } | null>(null);
  const [reading, setReading] = useState<string | undefined>();
  const [preview, setPreview] = useState<ImportWire | null>(null);
  const [decisions, setDecisions] = useState<ImportDecisions>({ name: '', displayName: '', description: '' });
  const [busy, setBusy] = useState(false);

  const onFile = useCallback(
    async (f: File) => {
      if (f.size > MAX_IMPORT_BYTES) {
        toast(t('participantImport.tooLarge', { defaultValue: 'That file is too large to import.' }), 'error');
        return;
      }
      setReading(f.name);
      let base64: string;
      try {
        base64 = await fileToBase64(f);
      } catch (e) {
        setReading(undefined);
        toast(
          t('participantImport.failed', {
            defaultValue: 'That file could not be imported: {{error}}',
            error: e instanceof Error ? e.message : String(e),
          }),
          'error',
        );
        return;
      }
      const res = await postImport({ fileName: f.name, bytesBase64: base64, ...(cwd ? { cwd } : {}) });
      setReading(undefined);
      if (!res.ok || !res.participantImport) {
        toast(
          t('participantImport.failed', {
            defaultValue: 'That file could not be imported: {{error}}',
            error: importProblemText(t, res.error ?? ''),
          }),
          'error',
        );
        return;
      }
      const plan = res.participantImport;
      setFile({ name: f.name, base64 });
      setPreview(plan);
      setDecisions({
        name: plan.agent.name,
        displayName: plan.agent.profile.displayName,
        description: plan.agent.description ?? '',
      });
    },
    [cwd, t],
  );

  const confirm = useCallback(async () => {
    if (!file || !preview) return;
    setBusy(true);
    const res = await postImport({
      fileName: file.name,
      bytesBase64: file.base64,
      // The format the preview was made with — the apply must read the file the
      // same way the user just saw it.
      format: preview.format,
      apply: true,
      decisions: {
        name: decisions.name.trim().replace(/^@/, ''),
        displayName: decisions.displayName.trim(),
        description: decisions.description,
      },
      ...(cwd ? { cwd } : {}),
    });
    setBusy(false);
    if (!res.ok) {
      toast(
        t('participantImport.failed', {
          defaultValue: 'That file could not be imported: {{error}}',
          error: importProblemText(t, res.error ?? ''),
        }),
        'error',
      );
      return;
    }
    announceParticipantsChanged();
    toast(
      t('participantImport.done', {
        defaultValue: '@{{name}} joined your participants.',
        name: res.participantImport?.agent.name ?? decisions.name,
      }),
      'success',
    );
    onImported(res.participants);
  }, [cwd, decisions, file, onImported, preview, t]);

  if (!preview || !file) {
    return <ParticipantImportPicker {...(reading ? { reading } : {})} onFile={(f) => void onFile(f)} onCancel={onCancel} />;
  }
  return (
    <ParticipantImportPreview
      fileName={file.name}
      preview={preview}
      decisions={decisions}
      busy={busy}
      onDecisions={setDecisions}
      onConfirm={() => void confirm()}
      onCancel={onCancel}
      onAnother={() => {
        setPreview(null);
        setFile(null);
      }}
    />
  );
}
