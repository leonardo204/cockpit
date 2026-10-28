'use client';

/**
 * SETTINGS › NABY › PARTICIPANTS (multi-agent-chat R5.1, §8.5, MAC-M3).
 *
 * Under naby's own card: the conversational agents naby hands work to. Each card
 * shows the avatar, the name and handle, the description naby routes on, and how
 * many sessions hold it, and — for an imported one — where it came from; per card
 * Edit · Duplicate · Export · Delete. The panel adds a participant or imports one
 * (MAC-M4, `ParticipantImportDialog`). The limits a round runs under are shown as
 * plain pills — they are settings, not mysteries.
 *
 * The registry goes through the `participant.*` actions only (MAC-M1): `agent.put`
 * would turn a participant into a custom agent and drop its profile. Every change
 * is announced (`announceParticipantsChanged`) so an open chat's roster, palette
 * and speaker cards re-read it.
 *
 * RECOMMENDATIONS (§8.13, MAC-M6). The "naby's participant suggestions" switch
 * (`participants.recommendations.enabled`) lives here. And a roster chip for a
 * NEW participant opens Settings on `recommendation:<id>`: this section takes
 * that request (`takeSettingsFocus`), reads the recommendation and opens the
 * editor prefilled from its draft (`formFromDraft`) under naby's banner.
 */

import { memo, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@cockpit/shared-ui';
import {
  ParticipantAvatar,
  RECOMMENDATION_ANCHOR_PREFIX,
  announceParticipantsChanged,
  participantInfosFrom,
  permissionIsRisky,
  permissionLabel,
  permissionValueFrom,
  recommendationIdFromAnchor,
  recommendationInfosFrom,
  type ParticipantInfo,
  type ParticipantPermissionValue,
  type RecommendationInfo,
} from '@cockpit/feature-agent';
import { ParticipantEditor } from './ParticipantEditor';
import { ParticipantImportDialog, originBadgeText } from './ParticipantImportDialog';
import { blankParticipantForm, formFromDraft, formFromParticipant, type ParticipantForm } from './participantForm';
import { SETTINGS_FOCUS_EVENT, takeSettingsFocus } from './settingsFocus';

/** The limits the section shows. Only the roster size is left: the speech and
 *  round-trip limits are gone (multi-agent-chat 0.7.0, §8.15 R11.1). */
type Limits = { maxPerSession: number };

type Reply = {
  ok: boolean;
  error?: string;
  participants?: unknown;
  recommendations?: unknown;
  participantSettings?: Partial<Limits> & { recommendationsEnabled?: boolean };
};

async function nabyPost(body: Record<string, unknown>): Promise<Reply> {
  try {
    const res = await fetch('/api/naby', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as Reply | null;
    if (!json) return { ok: false, error: `request failed (${res.status})` };
    return { ...json, ok: !!json.ok && res.ok };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Save one text file through the browser's own download (no server-side write
 *  path — the same reason AgentExportButton does it this way). */
function saveFile(name: string, content: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on the next tick: revoking synchronously can cancel the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

type ExportWire = {
  markdownName: string;
  markdown: string;
  sidecarName: string;
  sidecar: string;
  report: { knowledgeItems: number; secretsRedacted: number; promptLooksSecret: boolean };
};

const BTN = 'text-xs px-2 py-1 rounded-md border border-border text-foreground hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed';

export interface ParticipantCardProps {
  participant: ParticipantInfo;
  model?: string;
  /** The effective permission tier (§8.14), as `participant.list` resolved it. */
  permission?: ParticipantPermissionValue;
  busy: boolean;
  confirmingDelete: boolean;
  onEdit: () => void;
  onDuplicate: () => void;
  onExport: () => void;
  onDelete: () => void;
}

export const ParticipantCard = memo(function ParticipantCard({
  participant: p,
  model,
  permission,
  busy,
  confirmingDelete,
  onEdit,
  onDuplicate,
  onExport,
  onDelete,
}: ParticipantCardProps) {
  const { t } = useTranslation();
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-border bg-card p-3" data-participant-card={p.name}>
      <ParticipantAvatar avatar={p.avatar} color={p.color} size="lg" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[0.929rem] font-bold text-foreground">{p.displayName}</span>
          <span className="font-mono text-xs text-muted-foreground">@{p.name}</span>
          <span className="rounded-full bg-accent px-1.5 py-0.5 text-[0.714rem] font-medium text-brand">
            {t('agentManager.kindParticipant', { defaultValue: 'Participant' })}
          </span>
        </div>
        {p.description ? (
          <p className="mt-0.5 line-clamp-2 text-[0.786rem] leading-snug text-muted-foreground">{p.description}</p>
        ) : null}
        <div className="mt-1.5 flex flex-wrap gap-1">
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[0.714rem] text-muted-foreground" data-testid="participant-sessions">
            {t('participants.settings.sessions', {
              defaultValue: 'In {{count}} sessions',
              count: p.activeSessions ?? 0,
            })}
          </span>
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[0.714rem] text-muted-foreground">
            {model || t('participants.settings.modelSession', { defaultValue: 'Session model' })}
          </span>
          {permission ? (
            <span
              className={`rounded-full px-1.5 py-0.5 text-[0.714rem] font-medium ${
                permissionIsRisky(permission.level) ? 'bg-destructive/10 text-destructive' : 'bg-accent text-brand'
              }`}
              data-testid="participant-permission"
              data-level={permission.level}
            >
              {permissionLabel(permission, t)}
            </span>
          ) : null}
          {p.origin ? (
            <span
              className="rounded-full bg-accent px-1.5 py-0.5 text-[0.714rem] font-medium text-brand"
              data-testid="participant-origin"
              title={t('participants.settings.originTitle', {
                defaultValue: 'Imported from {{name}} (sha256 {{hash}})',
                name: p.origin.sourceName ?? '',
                hash: p.origin.sourceHash.slice(0, 8),
              })}
            >
              ⤓ {originBadgeText(t, p.origin)}
            </span>
          ) : null}
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <button type="button" onClick={onEdit} disabled={busy} className={BTN}>
            {t('participants.settings.edit', { defaultValue: 'Edit' })}
          </button>
          <button type="button" onClick={onDuplicate} disabled={busy} className={BTN}>
            {t('participants.settings.duplicate', { defaultValue: 'Duplicate' })}
          </button>
          <button
            type="button"
            onClick={onExport}
            disabled={busy}
            className={BTN}
            title={t('participants.settings.exportHint', {
              defaultValue: 'Download this participant as a Claude Code .md and a .naby.json sidecar.',
            })}
            data-testid="participant-export"
          >
            {t('participants.settings.export', { defaultValue: 'Export' })}
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={busy}
            className={`${BTN} text-destructive hover:border-destructive/40 hover:bg-destructive/10 ${
              confirmingDelete ? 'border-destructive/60 bg-destructive/10' : ''
            }`}
            data-testid="participant-delete"
          >
            {confirmingDelete
              ? t('participants.settings.removeConfirm', { defaultValue: 'Delete for good?' })
              : t('participants.settings.remove', { defaultValue: 'Delete' })}
          </button>
        </div>
      </div>
    </div>
  );
});

export interface ParticipantSectionViewProps {
  participants: readonly ParticipantInfo[];
  models: Readonly<Record<string, string | undefined>>;
  /** Per participant id: its effective permission tier (§8.14). */
  permissions?: Readonly<Record<string, ParticipantPermissionValue | undefined>>;
  limits: Limits;
  /** `participants.recommendations.enabled` (§8.13). */
  recommendationsEnabled?: boolean;
  onToggleRecommendations?: () => void;
  loading: boolean;
  busy: boolean;
  confirmingId: string | null;
  onAdd: () => void;
  onImport: () => void;
  onEdit: (id: string) => void;
  onDuplicate: (id: string) => void;
  onExport: (id: string) => void;
  onDelete: (id: string) => void;
}

/** The list half, pure props → markup (tested with static rendering). */
export const ParticipantSectionView = memo(function ParticipantSectionView({
  participants,
  models,
  permissions,
  limits,
  recommendationsEnabled = true,
  onToggleRecommendations,
  loading,
  busy,
  confirmingId,
  onAdd,
  onImport,
  onEdit,
  onDuplicate,
  onExport,
  onDelete,
}: ParticipantSectionViewProps) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2.5" data-testid="participant-section">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-[0.929rem] font-extrabold text-foreground">
            {t('participants.settings.title', { defaultValue: 'Participants' })}{' '}
            <span className="font-semibold text-muted-foreground">
              {t('participants.settings.count', { defaultValue: '{{count}}', count: participants.length })}
            </span>
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t('participants.settings.description', {
              defaultValue: 'Conversational agents naby hands work to after checking. Only naby speaks to participants.',
            })}
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {[
              t('participants.settings.limitPerSession', { defaultValue: '{{n}} per session', n: limits.maxPerSession }),
            ].map((label) => (
              <span key={label} className="rounded-full bg-muted px-1.5 py-0.5 text-[0.714rem] text-muted-foreground">
                {label}
              </span>
            ))}
          </div>
          <label className="mt-2 flex cursor-pointer items-start gap-2" data-testid="participant-recommendations-toggle">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={recommendationsEnabled}
              disabled={busy || !onToggleRecommendations}
              onChange={() => onToggleRecommendations?.()}
              aria-label={t('participants.recommend.toggle', { defaultValue: "naby's participant suggestions" })}
            />
            <span className="min-w-0">
              <span className="block text-xs font-semibold text-foreground">
                {t('participants.recommend.toggle', { defaultValue: "naby's participant suggestions" })}
              </span>
              <span className="block text-[0.714rem] text-muted-foreground">
                {t('participants.recommend.toggleHint', {
                  defaultValue:
                    'When the same specialised work keeps coming up in a conversation, naby suggests a participant for it. Reading the conversation costs one small model call every few messages.',
                })}
              </span>
            </span>
          </label>
        </div>
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={onAdd}
            disabled={busy}
            className="text-xs px-3 py-1.5 rounded-md border border-transparent bg-primary font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            data-testid="participant-add"
          >
            {t('participants.settings.add', { defaultValue: '+ Add' })}
          </button>
          <button
            type="button"
            onClick={onImport}
            disabled={busy}
            className="text-xs px-3 py-1.5 rounded-md border border-border text-foreground hover:bg-accent disabled:opacity-50"
            title={t('participants.settings.importHint', {
              defaultValue: 'Bring in a Claude Code subagent (.md), a naby export (.naby.json) or a character card (JSON or PNG).',
            })}
            data-testid="participant-import"
          >
            {t('participants.settings.import', { defaultValue: 'Import' })}
          </button>
        </div>
      </div>
      {loading ? (
        <p className="text-xs text-muted-foreground">{t('agentManager.loading', { defaultValue: 'Loading…' })}</p>
      ) : participants.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
          {t('participants.settings.empty', { defaultValue: 'No participants yet. Press Add to create one.' })}
        </p>
      ) : (
        <div className="grid gap-2 md:grid-cols-2">
          {participants.map((p) => (
            <ParticipantCard
              key={p.id}
              participant={p}
              model={models[p.id]}
              {...(permissions?.[p.id] ? { permission: permissions[p.id] } : {})}
              busy={busy}
              confirmingDelete={confirmingId === p.id}
              onEdit={() => onEdit(p.id)}
              onDuplicate={() => onDuplicate(p.id)}
              onExport={() => onExport(p.id)}
              onDelete={() => onDelete(p.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
});

/** The section, wired to `/api/naby`. */
export function ParticipantSection({ isOpen, cwd }: { isOpen: boolean; cwd?: string }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<unknown[]>([]);
  const [limits, setLimits] = useState<Limits>({ maxPerSession: 5 });
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<ParticipantForm | null>(null);
  const [recommendation, setRecommendation] = useState<RecommendationInfo | null>(null);
  const [recommendationsEnabled, setRecommendationsEnabled] = useState(true);
  const [importing, setImporting] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    const [list, conf] = await Promise.all([
      nabyPost({ action: 'participant.list' }),
      nabyPost({ action: 'participants.get' }),
    ]);
    if (list.ok && Array.isArray(list.participants)) setRows(list.participants);
    else if (!list.ok) toast(t('participants.settings.loadFailed', { defaultValue: 'Could not load participants.' }), 'error');
    if (conf.ok && conf.participantSettings) {
      const s = conf.participantSettings;
      setLimits((l) => ({
        maxPerSession: s.maxPerSession ?? l.maxPerSession,
      }));
      if (typeof s.recommendationsEnabled === 'boolean') setRecommendationsEnabled(s.recommendationsEnabled);
    }
    setLoading(false);
  }, [t]);

  useEffect(() => {
    if (isOpen) void reload();
  }, [isOpen, reload]);

  // A roster chip asked for the editor on one recommendation
  // (`recommendation:<id>`, §8.13). Taken on mount (the request was made before
  // this section rendered) or on the request event (Settings was already here).
  const openRecommendation = useCallback(
    async (anchor: string) => {
      const id = recommendationIdFromAnchor(anchor);
      if (!id) return;
      const res = await nabyPost({ action: 'session.recommendations.list', id });
      const rec = res.ok ? recommendationInfosFrom(res.recommendations).find((r) => r.id === id) : undefined;
      if (!rec || rec.kind !== 'new' || !rec.draft) {
        toast(
          t('participants.recommend.gone', { defaultValue: 'That suggestion is no longer waiting.' }),
          'info',
        );
        return;
      }
      setImporting(false);
      setRecommendation(rec);
      setEditing(formFromDraft(rec.draft));
    },
    [t],
  );
  useEffect(() => {
    if (!isOpen) return;
    const taken = takeSettingsFocus(RECOMMENDATION_ANCHOR_PREFIX);
    if (taken) void openRecommendation(taken);
    const onRequest = () => {
      const anchor = takeSettingsFocus(RECOMMENDATION_ANCHOR_PREFIX);
      if (anchor) void openRecommendation(anchor);
    };
    window.addEventListener(SETTINGS_FOCUS_EVENT, onRequest);
    return () => window.removeEventListener(SETTINGS_FOCUS_EVENT, onRequest);
  }, [isOpen, openRecommendation]);

  const onToggleRecommendations = useCallback(async () => {
    const next = !recommendationsEnabled;
    setRecommendationsEnabled(next);
    const res = await nabyPost({ action: 'participants.set', recommendationsEnabled: next });
    if (!res.ok) {
      setRecommendationsEnabled(!next);
      toast(t('participants.settings.actionFailed', { defaultValue: 'Could not do that: {{error}}', error: res.error ?? '' }), 'error');
      return;
    }
    if (typeof res.participantSettings?.recommendationsEnabled === 'boolean') {
      setRecommendationsEnabled(res.participantSettings.recommendationsEnabled);
    }
    announceParticipantsChanged();
  }, [recommendationsEnabled, t]);

  const participants = participantInfosFrom(rows);
  const models: Record<string, string | undefined> = {};
  const permissions: Record<string, ParticipantPermissionValue | undefined> = {};
  for (const r of rows) {
    if (r && typeof r === 'object') {
      const o = r as { id?: unknown; model?: unknown; permission?: unknown };
      if (typeof o.id === 'string') {
        models[o.id] = typeof o.model === 'string' ? o.model : undefined;
        permissions[o.id] = permissionValueFrom(o.permission);
      }
    }
  }

  const applyList = (reply: Reply) => {
    if (Array.isArray(reply.participants)) setRows(reply.participants);
  };

  const onDuplicate = useCallback(
    async (id: string) => {
      setBusy(true);
      const res = await nabyPost({ action: 'participant.duplicate', id });
      setBusy(false);
      if (!res.ok) {
        toast(t('participants.settings.actionFailed', { defaultValue: 'Could not do that: {{error}}', error: res.error ?? '' }), 'error');
        return;
      }
      applyList(res);
      announceParticipantsChanged();
      toast(t('participants.settings.duplicated', { defaultValue: 'Participant duplicated.' }), 'success');
    },
    [t],
  );

  const onDelete = useCallback(
    async (id: string) => {
      // Two presses: the first arms, the second deletes (it also leaves every
      // session that held it).
      if (confirmingId !== id) {
        setConfirmingId(id);
        return;
      }
      setConfirmingId(null);
      setBusy(true);
      const res = await nabyPost({ action: 'participant.remove', id });
      setBusy(false);
      if (!res.ok) {
        toast(t('participants.settings.actionFailed', { defaultValue: 'Could not do that: {{error}}', error: res.error ?? '' }), 'error');
        return;
      }
      applyList(res);
      announceParticipantsChanged();
      toast(t('participants.settings.removed', { defaultValue: 'Participant deleted.' }), 'success');
    },
    [confirmingId, t],
  );

  const onExport = useCallback(
    async (id: string) => {
      setBusy(true);
      let out: ExportWire | undefined;
      let error = '';
      try {
        const res = await fetch('/api/naby', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'participant.export', id }),
        });
        const json = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; participantExport?: ExportWire } | null;
        if (res.ok && json?.ok && json.participantExport) out = json.participantExport;
        else error = json?.error ?? `request failed (${res.status})`;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      setBusy(false);
      if (!out) {
        toast(t('participants.settings.exportFailed', { defaultValue: 'Could not export: {{error}}', error }), 'error');
        return;
      }
      saveFile(out.markdownName, out.markdown, 'text/markdown;charset=utf-8');
      saveFile(out.sidecarName, out.sidecar, 'application/json;charset=utf-8');
      // A participant carries nothing naby learned about the user, so there is no
      // consent step — but anything the export masked or flagged is said out loud.
      if (out.report.promptLooksSecret) {
        toast(
          t('participants.settings.exportPromptWarning', {
            defaultValue: 'Saved both files. The instructions look like they contain a credential — check them before sharing.',
          }),
          'info',
        );
      } else if (out.report.secretsRedacted > 0) {
        toast(
          t('participants.settings.exportedRedacted', {
            defaultValue: 'Saved both files. {{count}} credential-shaped value(s) were masked.',
            count: out.report.secretsRedacted,
          }),
          'success',
        );
      } else {
        toast(
          t('participants.settings.exported', { defaultValue: 'Saved {{md}} and {{json}}.', md: out.markdownName, json: out.sidecarName }),
          'success',
        );
      }
    },
    [t],
  );

  if (importing) {
    return (
      <ParticipantImportDialog
        {...(cwd ? { cwd } : {})}
        onCancel={() => setImporting(false)}
        onImported={(list) => {
          if (Array.isArray(list)) setRows(list);
          setImporting(false);
        }}
      />
    );
  }

  if (editing) {
    return (
      <ParticipantEditor
        // A fresh editor per recommendation: its form state starts from `initial`.
        key={recommendation?.id ?? editing.id ?? 'new'}
        initial={editing}
        {...(cwd ? { cwd } : {})}
        {...(recommendation ? { recommendation } : {})}
        onCancel={() => {
          setEditing(null);
          setRecommendation(null);
        }}
        onSaved={(list) => {
          if (Array.isArray(list)) setRows(list);
          setEditing(null);
          setRecommendation(null);
        }}
      />
    );
  }

  return (
    <ParticipantSectionView
      participants={participants}
      models={models}
      permissions={permissions}
      limits={limits}
      recommendationsEnabled={recommendationsEnabled}
      onToggleRecommendations={() => void onToggleRecommendations()}
      loading={loading}
      busy={busy}
      confirmingId={confirmingId}
      onAdd={() => {
        setRecommendation(null);
        setEditing(blankParticipantForm());
      }}
      onImport={() => setImporting(true)}
      onExport={(id) => void onExport(id)}
      onEdit={(id) => {
        const row = rows.find((r) => (r as { id?: unknown })?.id === id);
        if (row) {
          setRecommendation(null);
          setEditing(formFromParticipant(row));
        }
      }}
      onDuplicate={(id) => void onDuplicate(id)}
      onDelete={(id) => void onDelete(id)}
    />
  );
}
