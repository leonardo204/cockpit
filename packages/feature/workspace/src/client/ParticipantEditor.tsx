'use client';

/**
 * THE PARTICIPANT EDITOR (multi-agent-chat R1.1, R5.2, §8.5, MAC-M3).
 *
 * Seven sections, in the order R1.1 groups a participant: identity, instructions,
 * knowledge, guardrails, external resources (MCP), skills, model and memory. The
 * description carries the one sentence that matters most — naby reads it to
 * decide when to hand work over — so the hint under it says exactly that.
 *
 * Saved through `participant.put` (never `agent.put`, which would turn the row
 * into a custom agent and drop its profile). The form logic — fill, validate,
 * request body — is participantForm.ts; this file only draws it.
 *
 * Where the choices come from: MCP servers from the runtime state (`GET
 * /api/naby` → `mcp`), skills from the harness (`/api/harness`, kind 'skill'),
 * models from the stored-model list feature-agent shares with the agent editor
 * (no `auto` — that value is the chat bar's only), and the tools a participant
 * can be granted from `tools.list` (MAC-M4 — built by the turn's own builders).
 * Allowed tools are chips: pick a suggestion or type a name (an MCP tool is
 * `server__tool`).
 */

import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@cockpit/shared-ui';
import { CLAUDE_MODELS_FOR_AGENTS, ParticipantAvatar, announceParticipantsChanged } from '@cockpit/feature-agent';
import {
  AVATAR_PRESETS,
  COLOR_PRESETS,
  PARTICIPANT_LIMITS,
  newKnowledgeId,
  participantPutBody,
  validateParticipantForm,
  type FormError,
  type MemoryScope,
  type ParticipantForm,
} from './participantForm';

/** Field chrome without a width, so a sized field never fights `w-full`. */
const FIELD = 'text-xs px-2 py-1.5 rounded-md border border-border bg-background text-foreground';
const INPUT = `w-full ${FIELD}`;
const LABEL = 'text-[0.714rem] font-semibold text-muted-foreground';
const SMALL_BTN =
  'shrink-0 whitespace-nowrap text-xs px-2 py-1 rounded-md border border-border text-foreground hover:bg-accent disabled:opacity-50';

async function nabyPost(body: Record<string, unknown>): Promise<{ ok: boolean; error?: string; participants?: unknown }> {
  try {
    const res = await fetch('/api/naby', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; participants?: unknown } | null;
    if (!json) return { ok: false, error: `request failed (${res.status})` };
    return { ok: !!json.ok && res.ok, ...(json.error ? { error: json.error } : {}), participants: json.participants };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** The MCP server names the runtime knows (approved ones only). */
async function readMcpNames(): Promise<string[]> {
  try {
    const res = await fetch('/api/naby');
    if (!res.ok) return [];
    const json = (await res.json()) as { mcp?: { name?: unknown; status?: unknown }[] };
    return (json.mcp ?? [])
      .filter((m) => typeof m.name === 'string' && m.status !== 'proposed')
      .map((m) => m.name as string);
  } catch {
    return [];
  }
}

/** The tools a participant can be granted on this machine (`tools.list`). */
async function readToolNames(): Promise<string[]> {
  try {
    const res = await fetch('/api/naby', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'tools.list' }),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { ok?: boolean; tools?: unknown };
    return Array.isArray(json.tools) ? json.tools.filter((n): n is string => typeof n === 'string') : [];
  } catch {
    return [];
  }
}

/** Enabled harness skills across the scopes this user can see. */
async function readSkillNames(cwd?: string): Promise<{ name: string; description?: string }[]> {
  const scopes: { scope: string; scopeKey?: string }[] = [{ scope: 'user' }, { scope: 'org' }];
  if (cwd) scopes.push({ scope: 'project', scopeKey: cwd });
  const seen = new Map<string, { name: string; description?: string }>();
  await Promise.all(
    scopes.map(async ({ scope, scopeKey }) => {
      try {
        const params = new URLSearchParams({ scope });
        if (scopeKey) params.set('scopeKey', scopeKey);
        const res = await fetch(`/api/harness?${params.toString()}`);
        if (!res.ok) return;
        const json = (await res.json()) as { items?: { kind?: unknown; name?: unknown; status?: unknown; description?: unknown }[] };
        for (const it of json.items ?? []) {
          if (it.kind !== 'skill' || it.status !== 'enabled' || typeof it.name !== 'string') continue;
          if (!seen.has(it.name)) {
            seen.set(it.name, {
              name: it.name,
              ...(typeof it.description === 'string' ? { description: it.description } : {}),
            });
          }
        }
      } catch {
        /* a scope that cannot be read offers nothing */
      }
    }),
  );
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** One numbered section, per the prototype's editor. */
function Section({ n, title, sub, children, id }: { n: number; title: string; sub?: string; children: ReactNode; id: string }) {
  return (
    <section className="border-t border-border pt-3.5 first:border-t-0 first:pt-0" data-editor-section={id}>
      <div className="mb-2.5 flex items-center gap-2 text-[0.929rem] font-extrabold text-foreground">
        <span className="grid h-5 w-5 place-items-center rounded-md bg-accent text-[0.714rem] text-brand">{n}</span>
        {title}
        {sub ? <span className="text-[0.714rem] font-semibold text-muted-foreground">{sub}</span> : null}
      </div>
      <div className="space-y-2.5">{children}</div>
    </section>
  );
}

function FieldError({ errors, field }: { errors: FormError[]; field: string }) {
  const { t } = useTranslation();
  const mine = errors.filter((e) => e.field === field);
  if (mine.length === 0) return null;
  return (
    <>
      {mine.map((e, i) => (
        <p key={i} className="text-[0.714rem] font-semibold text-destructive" data-testid={`editor-error-${e.code}`}>
          {t(`participants.editor.err.${e.code}`, { defaultValue: e.code, ...(e.params ?? {}) })}
        </p>
      ))}
    </>
  );
}

/** A checklist of names (MCP servers, skills). */
function CheckList({
  options,
  selected,
  onToggle,
  empty,
}: {
  options: { name: string; hint?: string }[];
  selected: readonly string[];
  onToggle: (name: string) => void;
  empty: string;
}) {
  // Selected names the catalogue no longer lists stay visible (and removable).
  const all: { name: string; hint?: string }[] = [
    ...options,
    ...selected.filter((s) => !options.some((o) => o.name === s)).map((name) => ({ name })),
  ];
  if (all.length === 0) return <p className="text-xs text-muted-foreground">{empty}</p>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {all.map((o) => {
        const on = selected.includes(o.name);
        return (
          <button
            key={o.name}
            type="button"
            onClick={() => onToggle(o.name)}
            aria-pressed={on}
            title={o.hint}
            className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-semibold ${
              on ? 'border-brand/50 bg-accent text-brand' : 'border-border text-foreground hover:bg-muted'
            }`}
          >
            <span
              className={`grid h-3.5 w-3.5 place-items-center rounded-sm border text-[0.643rem] ${
                on ? 'border-brand bg-brand text-primary-foreground' : 'border-border'
              }`}
              aria-hidden="true"
            >
              {on ? '✓' : ''}
            </span>
            {o.name}
          </button>
        );
      })}
    </div>
  );
}

export const ParticipantEditor = memo(function ParticipantEditor({
  initial,
  cwd,
  onCancel,
  onSaved,
}: {
  initial: ParticipantForm;
  cwd?: string;
  onCancel: () => void;
  /** Called with the server's participant list after a save. */
  onSaved: (participants: unknown) => void;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState<ParticipantForm>(initial);
  const [busy, setBusy] = useState(false);
  const [triedSave, setTriedSave] = useState(false);
  const [toolDraft, setToolDraft] = useState('');
  const [mcpNames, setMcpNames] = useState<string[]>([]);
  const [skills, setSkills] = useState<{ name: string; description?: string }[]>([]);
  const [toolNames, setToolNames] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    void readMcpNames().then((n) => alive && setMcpNames(n));
    void readSkillNames(cwd).then((s) => alive && setSkills(s));
    void readToolNames().then((n) => alive && setToolNames(n));
    return () => {
      alive = false;
    };
  }, [cwd]);

  const errors = useMemo(() => validateParticipantForm(form), [form]);
  const shown = triedSave ? errors : [];
  const set = useCallback(<K extends keyof ParticipantForm>(k: K, v: ParticipantForm[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
  }, []);
  const toggleIn = (k: 'mcpServers' | 'skills', name: string) =>
    setForm((f) => ({
      ...f,
      [k]: f[k].includes(name) ? f[k].filter((x) => x !== name) : [...f[k], name],
    }));

  const save = useCallback(async () => {
    setTriedSave(true);
    if (validateParticipantForm(form).length > 0) return;
    setBusy(true);
    const res = await nabyPost(participantPutBody(form));
    setBusy(false);
    if (!res.ok) {
      toast(
        t('participants.settings.actionFailed', { defaultValue: 'Could not do that: {{error}}', error: res.error ?? '' }),
        'error',
      );
      return;
    }
    toast(t('participants.settings.saved', { defaultValue: 'Participant saved.' }), 'success');
    announceParticipantsChanged();
    onSaved(res.participants);
  }, [form, onSaved, t]);

  const addTool = () => {
    const name = toolDraft.trim();
    if (!name) return;
    if (!form.toolRefs.includes(name)) set('toolRefs', [...form.toolRefs, name]);
    setToolDraft('');
  };

  const modelOptions = CLAUDE_MODELS_FOR_AGENTS.filter((o) => o.value !== '');
  const modelKnown = form.model === '' || modelOptions.some((o) => o.value === form.model);

  return (
    <div className="space-y-4 rounded-xl border border-brand/40 bg-card p-4 shadow-card" data-testid="participant-editor">
      <div>
        <h3 className="text-[1rem] font-extrabold text-foreground">
          {form.id
            ? t('participants.editor.titleEdit', { defaultValue: 'Edit participant' })
            : t('participants.editor.titleNew', { defaultValue: 'New participant' })}
        </h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t('participants.editor.intro', {
            defaultValue: 'The spec naby uses when it hands this participant work. Participants speak only to naby.',
          })}
        </p>
      </div>

      {/* 1 — identity */}
      <Section n={1} id="identity" title={t('participants.editor.sec.identity', { defaultValue: 'Identity' })}>
        <div className="grid grid-cols-[auto_1fr_1fr] items-start gap-3">
          <div className="space-y-1">
            <span className={LABEL}>{t('participants.editor.avatar', { defaultValue: 'Avatar' })}</span>
            <div className="flex items-center gap-1.5">
              <ParticipantAvatar
                avatar={form.avatarImage ? { kind: 'image', dataUrl: form.avatarImage } : { kind: 'emoji', value: form.avatarEmoji || '?' }}
                color={/^#/.test(form.color) ? form.color : '#8B8FA3'}
                size="lg"
              />
              <input
                value={form.avatarImage ? '' : form.avatarEmoji}
                onChange={(e) => setForm((f) => ({ ...f, avatarEmoji: e.target.value.slice(0, 8), avatarImage: undefined }))}
                placeholder={form.avatarImage ? t('participants.editor.avatarImage', { defaultValue: 'image' }) : '🙂'}
                className={`${FIELD} w-14 text-center text-base`}
                aria-label={t('participants.editor.avatar', { defaultValue: 'Avatar' })}
              />
            </div>
            <div className="flex max-w-[11rem] flex-wrap gap-1">
              {AVATAR_PRESETS.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, avatarEmoji: e, avatarImage: undefined }))}
                  className={`grid h-7 w-7 place-items-center rounded-md border text-sm ${
                    !form.avatarImage && form.avatarEmoji === e ? 'border-brand bg-accent' : 'border-border hover:bg-muted'
                  }`}
                >
                  {e}
                </button>
              ))}
            </div>
            <FieldError errors={shown} field="avatar" />
          </div>
          <label className="flex flex-col gap-1">
            <span className={LABEL}>{t('participants.editor.displayName', { defaultValue: 'Display name' })}</span>
            <input
              value={form.displayName}
              onChange={(e) => set('displayName', e.target.value)}
              placeholder={t('participants.editor.displayNamePh', { defaultValue: 'e.g. Reviewer' })}
              className={INPUT}
            />
            <FieldError errors={shown} field="displayName" />
          </label>
          <label className="flex flex-col gap-1">
            <span className={LABEL}>{t('participants.editor.name', { defaultValue: 'Handle (unique)' })}</span>
            <div className="flex items-center rounded-md border border-border bg-background pl-2">
              <span className="text-xs text-muted-foreground">@</span>
              <input
                value={form.name}
                onChange={(e) => set('name', e.target.value.replace(/^@/, ''))}
                placeholder="reviewer"
                className="w-full bg-transparent px-1 py-1.5 font-mono text-xs text-foreground outline-none"
              />
            </div>
            <FieldError errors={shown} field="name" />
          </label>
        </div>
        <div className="space-y-1">
          <span className={LABEL}>{t('participants.editor.color', { defaultValue: 'Colour' })}</span>
          <div className="flex flex-wrap items-center gap-1.5">
            {COLOR_PRESETS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => set('color', c)}
                className={`h-6 w-6 rounded-full border-2 ${form.color.toLowerCase() === c.toLowerCase() ? 'border-foreground' : 'border-transparent'}`}
                style={{ background: c }}
                aria-label={c}
              />
            ))}
            <input
              type="color"
              value={/^#[0-9a-fA-F]{6}$/.test(form.color) ? form.color : '#6366F1'}
              onChange={(e) => set('color', e.target.value)}
              className="h-6 w-8 cursor-pointer rounded border border-border bg-transparent"
              aria-label={t('participants.editor.color', { defaultValue: 'Colour' })}
            />
            <input value={form.color} onChange={(e) => set('color', e.target.value)} className={`${FIELD} w-24 font-mono`} />
          </div>
          <FieldError errors={shown} field="color" />
        </div>
        <label className="flex flex-col gap-1">
          <span className={LABEL}>{t('participants.editor.description', { defaultValue: 'Description' })}</span>
          <textarea
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
            rows={2}
            placeholder={t('participants.editor.descriptionPh', {
              defaultValue: 'What it is good at and when to call it, in a sentence or two',
            })}
            className={`${INPUT} resize-y leading-relaxed`}
          />
          <span
            className="flex gap-1.5 rounded-md bg-accent px-2 py-1.5 text-[0.786rem] font-bold text-brand"
            data-testid="description-hint"
          >
            {t('participants.editor.descriptionHint', {
              defaultValue: '💡 naby reads this sentence to decide when to hand work over',
            })}
          </span>
        </label>
      </Section>

      {/* 2 — instructions */}
      <Section
        n={2}
        id="instructions"
        title={t('participants.editor.sec.instructions', { defaultValue: 'Instructions' })}
        sub={t('participants.editor.sec.instructionsSub', { defaultValue: 'system prompt · greeting · examples' })}
      >
        <label className="flex flex-col gap-1">
          <span className={LABEL}>{t('participants.editor.instructions', { defaultValue: 'Instructions' })}</span>
          <textarea
            value={form.instructions}
            onChange={(e) => set('instructions', e.target.value)}
            rows={5}
            placeholder={t('participants.editor.instructionsPh', { defaultValue: 'How this participant speaks and works' })}
            className={`${INPUT} resize-y leading-relaxed`}
          />
          <FieldError errors={shown} field="instructions" />
        </label>
        <label className="flex flex-col gap-1">
          <span className={LABEL}>{t('participants.editor.greeting', { defaultValue: 'Greeting (optional)' })}</span>
          <input
            value={form.greeting}
            onChange={(e) => set('greeting', e.target.value)}
            placeholder={t('participants.editor.greetingPh', { defaultValue: 'One line when it joins' })}
            className={INPUT}
          />
        </label>
        <div className="space-y-1.5">
          <span className={LABEL}>
            {t('participants.editor.examples', {
              defaultValue: 'Example exchanges (up to {{max}})',
              max: PARTICIPANT_LIMITS.examples,
            })}
          </span>
          {form.examples.map((ex, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-1.5">
              <input
                value={ex.user}
                onChange={(e) => set('examples', form.examples.map((x, j) => (j === i ? { ...x, user: e.target.value } : x)))}
                placeholder={t('participants.editor.exampleUser', { defaultValue: 'User' })}
                className={INPUT}
              />
              <input
                value={ex.assistant}
                onChange={(e) =>
                  set('examples', form.examples.map((x, j) => (j === i ? { ...x, assistant: e.target.value } : x)))
                }
                placeholder={t('participants.editor.exampleAssistant', { defaultValue: 'Participant' })}
                className={INPUT}
              />
              <button type="button" onClick={() => set('examples', form.examples.filter((_, j) => j !== i))} className={SMALL_BTN}>
                {t('participants.editor.remove', { defaultValue: 'Remove' })}
              </button>
              <div className="col-span-3">
                <FieldError errors={shown} field={`examples.${i}`} />
              </div>
            </div>
          ))}
          <button
            type="button"
            disabled={form.examples.length >= PARTICIPANT_LIMITS.examples}
            onClick={() => set('examples', [...form.examples, { user: '', assistant: '' }])}
            className={SMALL_BTN}
          >
            {t('participants.editor.addExample', { defaultValue: '+ Add example' })}
          </button>
          <FieldError errors={shown} field="examples" />
        </div>
      </Section>

      {/* 3 — knowledge */}
      <Section
        n={3}
        id="knowledge"
        title={t('participants.editor.sec.knowledge', { defaultValue: 'Knowledge' })}
        sub={t('participants.editor.sec.knowledgeSub', { defaultValue: 'text · markdown · always injected or loaded on demand' })}
      >
        {form.knowledge.map((k, i) => {
          const patch = (p: Partial<typeof k>) => set('knowledge', form.knowledge.map((x, j) => (j === i ? { ...x, ...p } : x)));
          return (
            <div key={k.id} className="space-y-1.5 rounded-lg border border-border p-2.5" data-knowledge-item={k.id}>
              <div className="flex items-center gap-1.5">
                <span aria-hidden="true">📄</span>
                <input
                  value={k.title}
                  onChange={(e) => patch({ title: e.target.value })}
                  placeholder={t('participants.editor.knowledgeTitle', { defaultValue: 'Title' })}
                  className={INPUT}
                />
                <div className="flex shrink-0 overflow-hidden rounded-md border border-border text-xs">
                  {(['always', 'on-demand'] as const).map((inj) => (
                    <button
                      key={inj}
                      type="button"
                      onClick={() => patch({ inject: inj })}
                      className={`px-2 py-1 font-semibold ${k.inject === inj ? 'bg-accent text-brand' : 'text-muted-foreground hover:bg-muted'}`}
                    >
                      {inj === 'always'
                        ? t('participants.editor.knowledgeAlways', { defaultValue: 'Always' })
                        : t('participants.editor.knowledgeOnDemand', { defaultValue: 'On demand' })}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => set('knowledge', form.knowledge.filter((_, j) => j !== i))}
                  className={SMALL_BTN}
                >
                  {t('participants.editor.remove', { defaultValue: 'Remove' })}
                </button>
              </div>
              <input
                value={k.keywords}
                onChange={(e) => patch({ keywords: e.target.value })}
                placeholder={t('participants.editor.knowledgeKeywords', {
                  defaultValue: 'Keywords, comma-separated (when set, injected only on a match)',
                })}
                className={INPUT}
              />
              {k.source.kind === 'inline' ? (
                <textarea
                  value={k.source.text}
                  onChange={(e) => patch({ source: { kind: 'inline', text: e.target.value } })}
                  rows={3}
                  placeholder={t('participants.editor.knowledgeText', { defaultValue: 'Content (up to 16 KB)' })}
                  className={`${INPUT} resize-y font-mono leading-relaxed`}
                />
              ) : (
                <p className="text-xs text-muted-foreground">
                  {t('participants.editor.knowledgeFile', { defaultValue: 'File: {{path}}', path: k.source.path })}
                </p>
              )}
              <FieldError errors={shown} field={`knowledge.${i}`} />
            </div>
          );
        })}
        <button
          type="button"
          disabled={form.knowledge.length >= PARTICIPANT_LIMITS.knowledge}
          onClick={() =>
            set('knowledge', [
              ...form.knowledge,
              { id: newKnowledgeId(), title: '', inject: 'always', keywords: '', source: { kind: 'inline', text: '' } },
            ])
          }
          className={SMALL_BTN}
        >
          {t('participants.editor.addKnowledge', {
            defaultValue: '+ Add knowledge ({{count}}/{{max}})',
            count: form.knowledge.length,
            max: PARTICIPANT_LIMITS.knowledge,
          })}
        </button>
        <FieldError errors={shown} field="knowledge" />
      </Section>

      {/* 4 — guardrails */}
      <Section
        n={4}
        id="guardrails"
        title={t('participants.editor.sec.guardrails', { defaultValue: 'Guardrails' })}
        sub={t('participants.editor.sec.guardrailsSub', { defaultValue: 'plain-language policy + tool permissions' })}
      >
        <label className="flex flex-col gap-1">
          <span className={LABEL}>{t('participants.editor.policy', { defaultValue: 'Policy (plain language)' })}</span>
          <textarea
            value={form.policy}
            onChange={(e) => set('policy', e.target.value)}
            rows={2}
            placeholder={t('participants.editor.policyPh', { defaultValue: 'What it must never do, what it must always say' })}
            className={`${INPUT} resize-y leading-relaxed`}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className={LABEL}>{t('participants.editor.permissionMode', { defaultValue: 'Permission mode' })}</span>
          <select
            value={form.permissionMode}
            onChange={(e) => set('permissionMode', e.target.value === 'plan' ? 'plan' : 'default')}
            className={`${FIELD} w-auto self-start`}
          >
            <option value="default">{t('participants.editor.permDefault', { defaultValue: 'Default (each tool follows your approval rules)' })}</option>
            <option value="plan">{t('participants.editor.permPlan', { defaultValue: 'Plan (read-only)' })}</option>
          </select>
        </label>
        <div className="space-y-1">
          <span className={LABEL}>{t('participants.editor.toolRefs', { defaultValue: 'Allowed tools' })}</span>
          <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-background p-1.5">
            {form.toolRefs.map((tool) => (
              <span key={tool} className="flex items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                {tool}
                <button
                  type="button"
                  onClick={() => set('toolRefs', form.toolRefs.filter((x) => x !== tool))}
                  className="text-muted-foreground hover:text-destructive"
                  aria-label={t('participants.editor.remove', { defaultValue: 'Remove' })}
                >
                  ×
                </button>
              </span>
            ))}
            <input
              value={toolDraft}
              onChange={(e) => setToolDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === 'Enter' || e.key === ',') {
                  e.preventDefault();
                  addTool();
                }
              }}
              onBlur={addTool}
              placeholder={t('participants.editor.toolRefsPh', { defaultValue: 'Type a tool name, then Enter' })}
              className="min-w-[10rem] flex-1 bg-transparent px-1 py-0.5 font-mono text-xs text-foreground outline-none"
            />
          </div>
          {toolNames.some((n) => !form.toolRefs.includes(n)) ? (
            <div className="flex flex-wrap items-center gap-1" data-testid="tool-suggestions">
              <span className="text-[0.714rem] text-muted-foreground">
                {t('participants.editor.toolSuggest', { defaultValue: 'Available here:' })}
              </span>
              {toolNames
                .filter((n) => !form.toolRefs.includes(n))
                .map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => set('toolRefs', [...form.toolRefs, n])}
                    className="rounded-sm border border-dashed border-border px-1.5 py-0.5 font-mono text-[0.714rem] text-muted-foreground hover:border-brand/45 hover:text-brand"
                  >
                    + {n}
                  </button>
                ))}
            </div>
          ) : null}
          <p className="text-[0.714rem] text-muted-foreground">
            {t('participants.editor.toolRefsHint', {
              defaultValue:
                'Empty = no tools. A participant’s tool calls still pass the turn’s approval gate. MCP tools are named server__tool.',
            })}
          </p>
        </div>
      </Section>

      {/* 5 — external resources */}
      <Section
        n={5}
        id="external"
        title={t('participants.editor.sec.external', { defaultValue: 'External resources' })}
        sub={t('participants.editor.sec.externalSub', { defaultValue: 'MCP servers' })}
      >
        <CheckList
          options={mcpNames.map((name) => ({ name }))}
          selected={form.mcpServers}
          onToggle={(n) => toggleIn('mcpServers', n)}
          empty={t('participants.editor.mcpNone', { defaultValue: 'No MCP servers are set up.' })}
        />
        <p className="text-[0.714rem] text-muted-foreground">
          {t('participants.editor.mcpHint', {
            defaultValue: 'APIs connect through MCP servers only. Pick which of naby’s servers this participant may see.',
          })}
        </p>
      </Section>

      {/* 6 — skills */}
      <Section
        n={6}
        id="skills"
        title={t('participants.editor.sec.skills', { defaultValue: 'Skills' })}
        sub={t('participants.editor.sec.skillsSub', { defaultValue: 'from your harness skills' })}
      >
        <CheckList
          options={skills.map((s) => ({ name: s.name, ...(s.description ? { hint: s.description } : {}) }))}
          selected={form.skills}
          onToggle={(n) => toggleIn('skills', n)}
          empty={t('participants.editor.skillsNone', { defaultValue: 'No skills are set up.' })}
        />
      </Section>

      {/* 7 — model · memory */}
      <Section n={7} id="model" title={t('participants.editor.sec.model', { defaultValue: 'Model · memory' })}>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className={LABEL}>{t('participants.editor.model', { defaultValue: 'Model' })}</span>
            <select value={form.model} onChange={(e) => set('model', e.target.value)} className={`${FIELD} w-48`}>
              <option value="">{t('participants.editor.modelSession', { defaultValue: 'Follow the session model' })}</option>
              {modelOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                  {o.hint ? ` — ${o.hint}` : ''}
                </option>
              ))}
              {!modelKnown ? <option value={form.model}>{form.model}</option> : null}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className={LABEL}>{t('participants.editor.temperature', { defaultValue: 'Temperature (0–2, blank = default)' })}</span>
            <input
              value={form.temperature}
              onChange={(e) => set('temperature', e.target.value.replace(/[^0-9.]/g, ''))}
              inputMode="decimal"
              className={`${FIELD} w-28`}
            />
            <FieldError errors={shown} field="temperature" />
          </label>
          <label className="flex flex-col gap-1">
            <span className={LABEL}>{t('participants.editor.memoryScope', { defaultValue: 'Memory it reads' })}</span>
            <select
              value={form.memoryScope}
              onChange={(e) => set('memoryScope', e.target.value as MemoryScope)}
              className={`${FIELD} w-auto self-start`}
            >
              <option value="user">{t('agentManager.scope_user', { defaultValue: 'You (all projects)' })}</option>
              <option value="project">{t('agentManager.scope_project', { defaultValue: 'This project' })}</option>
              <option value="org">{t('agentManager.scope_org', { defaultValue: 'Organization' })}</option>
              <option value="session">{t('agentManager.scope_session', { defaultValue: 'This session only' })}</option>
            </select>
          </label>
        </div>
        <p className="text-[0.714rem] text-muted-foreground">
          {t('participants.editor.memoryHint', {
            defaultValue: 'A participant reads this memory but never writes to it; only naby learns.',
          })}
        </p>
      </Section>

      {triedSave && errors.length > 0 ? (
        <p className="text-xs font-semibold text-destructive" data-testid="editor-error-summary">
          {t('participants.editor.fixErrors', { defaultValue: 'Fix the marked fields to save.' })}
        </p>
      ) : null}
      <div className="flex justify-end gap-2 border-t border-border pt-3">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="text-xs px-3 py-1.5 rounded-md border border-border text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          {t('participants.editor.cancel', { defaultValue: 'Cancel' })}
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy}
          className="text-xs px-3 py-1.5 rounded-md border border-transparent bg-primary font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          data-testid="participant-save"
        >
          {t('participants.editor.save', { defaultValue: 'Save' })}
        </button>
      </div>
    </div>
  );
});
