'use client';

/**
 * Phase 3 (P3-M1) — the naby AGENT layer panel, rendered in SettingsModal.
 *
 * This is naby's own agent layer: the built-in PERSONA (the agent that learns
 * the user and, once wired in P3-M2+, acts on their behalf) plus any custom
 * agents the user adds. Agents are addressed by `@name` in the composer. This
 * panel is CRUD over `store.listAgents/putAgent/removeAgent` via `/api/naby`.
 *
 * The persona is BUILT-IN AND READ-ONLY (kind='persona'): naby owns its prompt,
 * scope and autonomy, the store refuses both a delete and an edit, and this panel
 * offers neither button for it. What stays available on a persona row is
 * everything that only READS it — the growth panel and the export — because those
 * are how the user inspects an agent they cannot rewrite.
 */

import { memo, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@cockpit/shared-ui';
import type { Agent } from '../../../../../../dist/naby-runtime.mjs';
import { GrowthPanel } from './GrowthPanel';
import { AgentExportButton } from './AgentExportButton';
import { AgentImportButton } from './AgentImportButton';

type Escalation = 'inline' | 'telegram' | 'both';
type MemoryScope = 'session' | 'project' | 'user' | 'org';

async function agentAction(body: Record<string, unknown>): Promise<
  { ok: true; agents?: Agent[]; agent?: Agent } | { ok: false; error: string }
> {
  try {
    const res = await fetch('/api/naby', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as
      | { ok: boolean; agents?: Agent[]; agent?: Agent; error?: string }
      | null;
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? `request failed (${res.status})` };
    return { ok: true, agents: json.agents, agent: json.agent };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** The persona's DELEGATION settings (P3-M9, G1) — the user's answer to "how much
 *  do I hand this agent", stored in settings rather than on the read-only row. */
type PersonaAutonomy = { escalation: Escalation; maxSteps: number };

async function personaAutonomyAction(
  body: Record<string, unknown>,
): Promise<
  { ok: true; personaAutonomy?: PersonaAutonomy; autonomyStepCap?: number } | { ok: false; error: string }
> {
  try {
    const res = await fetch('/api/naby', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as
      | { ok: boolean; personaAutonomy?: PersonaAutonomy; autonomyStepCap?: number; error?: string }
      | null;
    if (!res.ok || !json?.ok) {
      return { ok: false, error: json?.error ?? `request failed (${res.status})` };
    }
    return {
      ok: true,
      ...(json.personaAutonomy ? { personaAutonomy: json.personaAutonomy } : {}),
      ...(json.autonomyStepCap !== undefined ? { autonomyStepCap: json.autonomyStepCap } : {}),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * The persona card's DELEGATION SETTINGS (P3-M9, G1).
 *
 * The identity above it stays read-only, and this section is not a way around
 * that — it is a different question. The row says WHO the agent is (naby owns
 * that, and the store refuses to let anyone rewrite it); this says HOW MUCH OF
 * YOUR WORK YOU HAND IT, which is the delegating user's call and nobody else's.
 * The copy has to carry that distinction, because two edit controls on a card
 * labelled "cannot be edited" otherwise read as a contradiction.
 *
 * Saves land immediately (no separate Save button): each control is one
 * independent setting, and `personaAutonomy.set` takes them one at a time. The
 * server answers with the CLAMPED values and those are what the fields then show,
 * so a typed 999 visibly becomes 20 rather than being silently downgraded at run
 * time.
 */
const PersonaDelegation = memo(function PersonaDelegation() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<PersonaAutonomy | null>(null);
  const [cap, setCap] = useState(20);
  const [saving, setSaving] = useState(false);
  // Held separately from `settings` so the field can be mid-edit (or empty)
  // without the committed value flickering under the cursor.
  const [stepsDraft, setStepsDraft] = useState('');

  useEffect(() => {
    let alive = true;
    void (async () => {
      const res = await personaAutonomyAction({ action: 'personaAutonomy.get' });
      if (!alive || !res.ok || !res.personaAutonomy) return;
      setSettings(res.personaAutonomy);
      setStepsDraft(String(res.personaAutonomy.maxSteps));
      if (res.autonomyStepCap !== undefined) setCap(res.autonomyStepCap);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const save = useCallback(
    async (patch: { escalation?: Escalation; maxSteps?: number }) => {
      setSaving(true);
      const res = await personaAutonomyAction({ action: 'personaAutonomy.set', ...patch });
      setSaving(false);
      if (res.ok && res.personaAutonomy) {
        setSettings(res.personaAutonomy);
        setStepsDraft(String(res.personaAutonomy.maxSteps));
        return;
      }
      toast(
        (!res.ok && res.error) ||
          t('agentManager.delegationError', { defaultValue: 'Could not save the delegation settings.' }),
        'error',
      );
    },
    [t],
  );

  if (!settings) return null;

  return (
    // An INSET DIVIDER inside the agent row, not a box. The row is already the
    // one border this list is allowed (a repeated list item); a second bordered
    // panel inside it is card-in-card, and the divider says the same thing —
    // "a different question starts here" — with a line instead of a rectangle.
    <div className="mt-2.5 border-t border-border pt-2.5">
      <p className="text-[11px] font-medium text-foreground">
        {t('agentManager.delegationTitle', { defaultValue: 'How you delegate' })}
      </p>
      <p className="mt-0.5 text-[10px] text-muted-foreground leading-relaxed">
        {t('agentManager.delegationHint', {
          defaultValue:
            'These are your settings, not the persona’s. You are not editing who it is — you are choosing how much of your work it may carry on its own, and where it reaches you when something critical comes up.',
        })}
      </p>

      <div className="mt-2 flex gap-2 flex-wrap">
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] text-muted-foreground">
            {t('agentManager.delegationEscalation', { defaultValue: 'Reach me via' })}
          </span>
          <select
            value={settings.escalation}
            disabled={saving}
            onChange={(e) => void save({ escalation: e.target.value as Escalation })}
            className="text-xs px-2 py-1 rounded border border-border bg-background text-foreground disabled:opacity-50"
          >
            <option value="inline">{t('agentManager.esc_inline', { defaultValue: 'Ask inline' })}</option>
            <option value="telegram">{t('agentManager.esc_telegram', { defaultValue: 'Telegram' })}</option>
            <option value="both">{t('agentManager.esc_both', { defaultValue: 'Inline + Telegram' })}</option>
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] text-muted-foreground">
            {t('agentManager.delegationMaxSteps', { defaultValue: 'Steps it may take alone' })}
          </span>
          <input
            value={stepsDraft}
            disabled={saving}
            onChange={(e) => setStepsDraft(e.target.value.replace(/[^0-9]/g, ''))}
            onBlur={() => {
              const n = Number(stepsDraft);
              // An emptied field means "off", which is 1 — not "unchanged", or the
              // user could never turn autonomy back off by clearing the box.
              void save({ maxSteps: stepsDraft.trim() === '' || !Number.isFinite(n) ? 1 : n });
            }}
            className="text-xs px-2 py-1 rounded border border-border bg-background text-foreground w-28 disabled:opacity-50"
          />
        </label>
      </div>

      <p className="mt-1.5 text-[10px] text-muted-foreground leading-relaxed">
        {t('agentManager.delegationStepsHint', {
          cap,
          defaultValue:
            '1 = one turn per message (off). 2+ lets it keep working on its own, up to {{cap}} steps; it stops when it reports done, uses no tool, or spends the budget.',
        })}
      </p>
    </div>
  );
});

/** Blank form for a new custom agent. */
type Form = {
  id?: string;
  name: string;
  description: string;
  systemPrompt: string;
  model: string;
  memoryScope: MemoryScope;
  escalation: Escalation;
  maxSteps: string;
};

const BLANK: Form = {
  name: '',
  description: '',
  systemPrompt: '',
  model: '',
  memoryScope: 'user',
  escalation: 'inline',
  maxSteps: '',
};

function toForm(a: Agent): Form {
  return {
    id: a.id,
    name: a.name,
    description: a.description ?? '',
    systemPrompt: a.systemPrompt,
    model: a.model ?? '',
    memoryScope: a.memoryScope,
    escalation: a.autonomy.escalation,
    maxSteps: a.autonomy.maxSteps != null ? String(a.autonomy.maxSteps) : '',
  };
}

const AgentRow = memo(function AgentRow({
  agent,
  busy,
  cwd,
  onEdit,
  onRemove,
}: {
  agent: Agent;
  busy: boolean;
  /** Lets an export also carry this project's memory scope. */
  cwd?: string;
  onEdit: (a: Agent) => void;
  onRemove: (a: Agent) => void;
}) {
  const { t } = useTranslation();
  const isPersona = agent.kind === 'persona';
  // Collapsed by default, and MOUNTED ONLY WHEN OPEN: each panel is one
  // `growth.get` that reads the agent's ledger, so an unopened row costs nothing.
  const [showGrowth, setShowGrowth] = useState(false);
  return (
    <div className="rounded-lg border border-border p-2.5">
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-foreground truncate" title={agent.name}>
            @{agent.name}
          </span>
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
              isPersona
                ? 'bg-brand/15 text-brand'
                : 'bg-muted text-muted-foreground'
            }`}
          >
            {isPersona
              ? t('agentManager.kindPersona', { defaultValue: 'Persona' })
              : t('agentManager.kindCustom', { defaultValue: 'Custom' })}
          </span>
        </div>
        {agent.description ? (
          <p className="mt-0.5 text-[11px] text-muted-foreground line-clamp-2">{agent.description}</p>
        ) : null}
        {/* Says WHY there are no Edit/Remove buttons on this row. Without it the
            persona just looks like an agent whose controls failed to render. */}
        {isPersona ? (
          <p className="mt-1 text-[10px] text-muted-foreground italic">
            {t('agentManager.personaReadOnly', {
              defaultValue:
                'Built in to naby — it cannot be edited or removed. It grows by learning from you, not by being rewritten.',
            })}
          </p>
        ) : null}
      </div>
      <div className="flex gap-1.5 shrink-0">
        <button
          onClick={() => setShowGrowth((v) => !v)}
          className="text-xs px-2 py-1 rounded border border-border hover:bg-brand/10 hover:border-brand/40 text-foreground"
          aria-expanded={showGrowth}
        >
          {t('agentManager.growth', { defaultValue: 'Growth' })}
        </button>
        {/* Both write actions are hidden for the built-in persona — the store
            refuses either one, so showing a button that can only fail would be a
            promise the product does not keep. */}
        {!isPersona ? (
          <>
            <button
              onClick={() => onEdit(agent)}
              disabled={busy}
              className="text-xs px-2 py-1 rounded border border-border hover:bg-brand/10 hover:border-brand/40 text-foreground disabled:opacity-50"
            >
              {t('agentManager.edit', { defaultValue: 'Edit' })}
            </button>
            <button
              onClick={() => onRemove(agent)}
              disabled={busy}
              className="text-xs px-2 py-1 rounded border border-border hover:bg-red-500/10 hover:border-red-500/40 text-red-600 dark:text-red-400 disabled:opacity-50"
            >
              {t('agentManager.remove', { defaultValue: 'Remove' })}
            </button>
          </>
        ) : null}
      </div>
    </div>
    {/* P3-M9 (G1): the persona's identity is read-only, but how much the USER
        delegates to it is the user's own setting — see PersonaDelegation. Only
        on the persona row: a custom agent's autonomy lives on its (editable) row
        and is set in the editor above. */}
    {isPersona ? <PersonaDelegation /> : null}
    {/* `cwd` reaches the panel for the SAME reason the export button gets it
        (P3-M8c): it decides whether project-scope memory is counted in the
        learning block. The trust reading itself ignores it. */}
    {showGrowth ? <GrowthPanel agentId={agent.id} {...(cwd ? { cwd } : {})} /> : null}
    {/* Its own line: the confirm step expands into a panel, which would break the
        header's flex row. */}
    <div className="mt-2">
      <AgentExportButton agentId={agent.id} {...(cwd ? { cwd } : {})} />
    </div>
    </div>
  );
});

export function NabyAgentManager({ isOpen, cwd }: { isOpen: boolean; cwd?: string }) {
  const { t } = useTranslation();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<Form | null>(null);

  // NOTE: there is deliberately no "editing the persona" state any more. The
  // editor only ever opens on a custom agent, because the persona row offers no
  // Edit button and `agent.put` refuses it even if something else asked.

  const reload = useCallback(async () => {
    setLoading(true);
    const res = await agentAction({ action: 'agent.list' });
    if (res.ok) setAgents(res.agents ?? []);
    else toast(t('agentManager.error', { defaultValue: 'Could not load agents.' }), 'error');
    setLoading(false);
  }, [t]);

  useEffect(() => {
    if (isOpen) void reload();
  }, [isOpen, reload]);

  const save = useCallback(async () => {
    if (!form) return;
    const name = form.name.trim();
    const systemPrompt = form.systemPrompt.trim();
    if (!name || !systemPrompt) {
      toast(t('agentManager.needNamePrompt', { defaultValue: 'Name and instructions are required.' }), 'error');
      return;
    }
    setBusy(true);
    const res = await agentAction({
      action: 'agent.put',
      ...(form.id ? { id: form.id } : {}),
      name,
      description: form.description.trim(),
      systemPrompt,
      model: form.model.trim(),
      memoryScope: form.memoryScope,
      escalation: form.escalation,
      ...(form.maxSteps.trim() ? { maxSteps: Number(form.maxSteps) } : {}),
    });
    setBusy(false);
    if (res.ok) {
      setAgents(res.agents ?? []);
      setForm(null);
      toast(t('agentManager.saved', { defaultValue: 'Agent saved.' }), 'success');
    } else {
      toast(res.error || t('agentManager.error', { defaultValue: 'Could not save the agent.' }), 'error');
    }
  }, [form, t]);

  const remove = useCallback(
    async (a: Agent) => {
      setBusy(true);
      const res = await agentAction({ action: 'agent.remove', id: a.id });
      setBusy(false);
      if (res.ok) setAgents(res.agents ?? []);
      else toast(t('agentManager.error', { defaultValue: 'Could not remove the agent.' }), 'error');
    },
    [t],
  );

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  return (
    <div className="space-y-3">
      {/* Plain muted prose, not a tinted box: this is the section's description,
          and a box around an explanation is the first thing that turns a settings
          pane into a stack of rectangles. */}
      <p className="text-xs text-muted-foreground leading-relaxed">
        {t('agentManager.description', {
          defaultValue:
            'Your naby agents. The built-in persona learns how you work and can act on your behalf; add custom agents for focused jobs. Address one in the composer with @name.',
        })}
      </p>

      {/* Import — panel-level, not per agent: it CREATES one. */}
      <AgentImportButton onImported={() => void reload()} />

      {/* Editor */}
      {form ? (
        <div className="space-y-2 rounded-lg border border-brand/40 bg-brand/5 p-3">
          <div className="flex gap-2 items-end">
            <label className="flex-1 flex flex-col gap-0.5">
              <span className="text-[10px] text-muted-foreground">{t('agentManager.name', { defaultValue: 'Name (@handle)' })}</span>
              <input
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
                placeholder="persona"
                className="text-xs px-2 py-1 rounded border border-border bg-background text-foreground font-mono"
              />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-[10px] text-muted-foreground">{t('agentManager.model', { defaultValue: 'Model (optional)' })}</span>
              <input
                value={form.model}
                onChange={(e) => set('model', e.target.value)}
                placeholder={t('agentManager.modelPlaceholder', { defaultValue: 'inherit' })}
                className="text-xs px-2 py-1 rounded border border-border bg-background text-foreground font-mono w-40"
              />
            </label>
          </div>

          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] text-muted-foreground">{t('agentManager.summary', { defaultValue: 'Short description (optional)' })}</span>
            <input
              value={form.description}
              onChange={(e) => set('description', e.target.value)}
              className="text-xs px-2 py-1 rounded border border-border bg-background text-foreground"
            />
          </label>

          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] text-muted-foreground">{t('agentManager.instructions', { defaultValue: 'Instructions (persona / system prompt)' })}</span>
            <textarea
              value={form.systemPrompt}
              onChange={(e) => set('systemPrompt', e.target.value)}
              rows={5}
              className="text-xs px-2 py-1 rounded border border-border bg-background text-foreground leading-relaxed resize-y"
            />
          </label>

          <div className="flex gap-2 flex-wrap">
            <label className="flex flex-col gap-0.5">
              <span className="text-[10px] text-muted-foreground">{t('agentManager.memoryScope', { defaultValue: 'Learns in' })}</span>
              <select
                value={form.memoryScope}
                onChange={(e) => set('memoryScope', e.target.value as MemoryScope)}
                className="text-xs px-2 py-1 rounded border border-border bg-background text-foreground"
              >
                <option value="user">{t('agentManager.scope_user', { defaultValue: 'You (all projects)' })}</option>
                <option value="project">{t('agentManager.scope_project', { defaultValue: 'This project' })}</option>
                <option value="org">{t('agentManager.scope_org', { defaultValue: 'Organization' })}</option>
                <option value="session">{t('agentManager.scope_session', { defaultValue: 'This session only' })}</option>
              </select>
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-[10px] text-muted-foreground">{t('agentManager.escalation', { defaultValue: 'Escalate via' })}</span>
              <select
                value={form.escalation}
                onChange={(e) => set('escalation', e.target.value as Escalation)}
                className="text-xs px-2 py-1 rounded border border-border bg-background text-foreground"
              >
                <option value="inline">{t('agentManager.esc_inline', { defaultValue: 'Ask inline' })}</option>
                <option value="telegram">{t('agentManager.esc_telegram', { defaultValue: 'Telegram' })}</option>
                <option value="both">{t('agentManager.esc_both', { defaultValue: 'Inline + Telegram' })}</option>
              </select>
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-[10px] text-muted-foreground">{t('agentManager.maxSteps', { defaultValue: 'Max autonomous steps' })}</span>
              <input
                value={form.maxSteps}
                onChange={(e) => set('maxSteps', e.target.value.replace(/[^0-9]/g, ''))}
                placeholder={t('agentManager.noLimit', { defaultValue: 'off (1 turn)' })}
                className="text-xs px-2 py-1 rounded border border-border bg-background text-foreground w-28"
              />
            </label>
          </div>

          {/* P3-M3c: what the number actually does. An empty field is autonomy
              OFF (one turn), not "unlimited" — and the store's value is clamped,
              so the ceiling is stated rather than discovered. */}
          <p className="text-[10px] text-muted-foreground">
            {t('agentManager.stepsHint', {
              defaultValue:
                'Empty or 1 = a single turn. 2+ lets the agent keep working on its own (hard cap 20); it stops when it reports done, uses no tool, or spends the budget.',
            })}
          </p>

          <div className="flex gap-2 justify-end pt-1">
            <button
              onClick={() => setForm(null)}
              disabled={busy}
              className="text-xs px-3 py-1.5 rounded border border-border text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              {t('agentManager.cancel', { defaultValue: 'Cancel' })}
            </button>
            <button
              onClick={() => void save()}
              disabled={busy || !form.name.trim() || !form.systemPrompt.trim()}
              className="text-xs px-3 py-1.5 rounded border border-brand bg-brand/10 text-brand hover:bg-brand/20 disabled:opacity-50"
            >
              {t('agentManager.save', { defaultValue: 'Save' })}
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setForm({ ...BLANK })}
          className="text-xs px-3 py-1.5 rounded border border-brand bg-brand/10 text-brand hover:bg-brand/20"
        >
          {t('agentManager.addAgent', { defaultValue: '+ Add agent' })}
        </button>
      )}

      {/* List */}
      {loading ? (
        <p className="text-xs text-muted-foreground">{t('agentManager.loading', { defaultValue: 'Loading…' })}</p>
      ) : agents.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">
          {t('agentManager.empty', { defaultValue: 'No agents yet.' })}
        </p>
      ) : (
        <div className="space-y-2">
          {agents.map((a) => (
            <AgentRow
              key={a.id}
              agent={a}
              busy={busy}
              {...(cwd ? { cwd } : {})}
              onEdit={(x) => setForm(toForm(x))}
              onRemove={(x) => void remove(x)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
