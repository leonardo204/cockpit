'use client';

/**
 * NABY'S PARTICIPANT DRAFT CARD (multi-agent-chat §8.12, R8.3, MAC-M5a) — the
 * third face of the approval prompt, beside the tool card and the proposal card.
 *
 * naby called `naby_participant_draft`; the turn is suspended until this card is
 * answered. The identity the user is most likely to want different — avatar,
 * display name, `@` handle, description, colour — is editable in place (the same
 * inputs as the import preview); the words naby wrote for the participant itself
 * (instructions, guardrail policy, greeting) are folded previews. Corrections go
 * back as `approval.resolve {edits}` and the server validates them again before
 * anything is written. There is never an "always" button: a draft always asks.
 *
 * Shown whatever "show routing" says — it is a question, not a routing detail.
 */

import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NabyAvatar } from '@cockpit/shared-ui';
import { ParticipantAvatar } from './ParticipantAvatar';
import {
  AVATAR_PRESETS,
  COLOR_PRESETS,
  draftFormFrom,
  validateDraftForm,
  type DraftChoice,
  type DraftField,
  type DraftForm,
  type DraftFormError,
  type ParticipantDraftCard as DraftCardData,
} from './participantDraft';

const BTN = 'text-xs font-semibold px-3 py-1.5 rounded-md border disabled:opacity-50 transition-colors';
const FIELD = 'text-xs px-2 py-1.5 rounded-md border border-border bg-background text-foreground';
const LABEL = 'text-[0.714rem] font-semibold text-muted-foreground';

const FIELD_LABEL: Record<DraftField, { key: string; en: string }> = {
  name: { key: 'participants.draft.field.name', en: 'Handle' },
  displayName: { key: 'participants.draft.field.displayName', en: 'Display name' },
  description: { key: 'participants.draft.field.description', en: 'Description' },
  instructions: { key: 'participants.draft.field.instructions', en: 'Instructions' },
  guardrailsPolicy: { key: 'participants.draft.field.guardrailsPolicy', en: 'Guardrail policy' },
  greeting: { key: 'participants.draft.field.greeting', en: 'Greeting' },
  avatar: { key: 'participants.draft.field.avatar', en: 'Avatar' },
  color: { key: 'participants.draft.field.color', en: 'Colour' },
};

function FieldError({ errors, field }: { errors: DraftFormError[]; field: DraftFormError['field'] }) {
  const { t } = useTranslation();
  const e = errors.find((x) => x.field === field);
  if (!e) return null;
  return (
    <span className="text-[0.714rem] text-destructive" data-testid={`draft-error-${field}`}>
      {t(`participants.draft.err.${e.code}`, { defaultValue: e.code, ...(e.params ?? {}) })}
    </span>
  );
}

/** A long text, folded: the first line shows, the whole opens on click. */
function Folded({ label, text, testId }: { label: string; text: string; testId: string }) {
  const first = text.split('\n')[0] ?? '';
  return (
    <details className="group rounded-lg bg-muted px-2.5 py-1.5" data-testid={testId}>
      <summary className="cursor-pointer list-none text-xs">
        <span className="font-semibold text-foreground">{label}</span>
        <span className="ml-1.5 text-muted-foreground group-open:hidden">
          {first.length > 90 ? `${first.slice(0, 90)}…` : first}
        </span>
      </summary>
      <div className="mt-1.5 max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground">
        {text}
      </div>
    </details>
  );
}

function avatarText(a: DraftCardData['draft']['avatar']): string {
  return a.kind === 'emoji' ? a.value : '🖼';
}

export const ParticipantDraftCard = memo(function ParticipantDraftCard({
  card,
  busy,
  more,
  onAnswer,
}: {
  card: DraftCardData;
  busy: boolean;
  more: number;
  /** The button pressed, with the form as the user left it. */
  onAnswer: (choice: DraftChoice, form: DraftForm) => void;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState<DraftForm>(() => draftFormFrom(card));
  const errors = useMemo(() => validateDraftForm(form, card), [form, card]);
  const blocked = busy || errors.length > 0;
  const set = <K extends keyof DraftForm>(k: K, v: DraftForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const isCreate = card.action === 'create';
  const previewAvatar =
    form.avatar.trim() || card.draft.avatar.kind === 'emoji'
      ? ({ kind: 'emoji', value: form.avatar.trim() || '?' } as const)
      : card.draft.avatar;
  const color = /^#/.test(form.color) ? form.color : '#8B8FA3';
  const label = (f: DraftField) => t(FIELD_LABEL[f].key, { defaultValue: FIELD_LABEL[f].en });
  // An update shows only what changes (R8.3); the identity inputs are always there.
  const changedText = card.changed.filter((f) => f !== 'avatar' && f !== 'color');

  return (
    <div
      className="mx-4 mb-2 rounded-xl border-[1.5px] border-brand/40 bg-card p-3.5 shadow-card"
      data-testid="participant-draft"
      data-action={card.action}
    >
      <div className="inline-flex items-center gap-1.5 rounded-sm bg-accent py-0.5 pl-1 pr-2 text-xs font-semibold text-accent-foreground">
        <NabyAvatar size={20} bare />
        {t('participants.draft.title', { defaultValue: 'naby’s draft · needs your OK' })}
      </div>
      <div className="mt-2 text-sm font-semibold text-foreground">
        {isCreate
          ? t('participants.draft.createQuestion', { defaultValue: 'Create this participant?' })
          : t('participants.draft.updateQuestion', {
              defaultValue: 'Apply these changes to @{{name}}?',
              name: card.before?.name ?? card.draft.name,
            })}
      </div>

      {/* identity — editable in place */}
      <div className="mt-2 grid grid-cols-[auto_1fr_1fr] items-start gap-2.5 rounded-lg bg-muted px-2.5 py-2">
        <div className="space-y-1">
          <span className={LABEL}>{label('avatar')}</span>
          <div className="flex items-center gap-1.5">
            <ParticipantAvatar avatar={previewAvatar} color={color} size="lg" />
            <input
              value={form.avatar}
              onChange={(e) => set('avatar', e.target.value.slice(0, 8))}
              placeholder={card.draft.avatar.kind === 'image' ? t('participants.draft.avatarImage', { defaultValue: 'image' }) : '🙂'}
              className={`${FIELD} w-12 text-center text-base`}
              aria-label={label('avatar')}
              data-testid="draft-avatar"
            />
          </div>
          <div className="flex max-w-[10rem] flex-wrap gap-1">
            {AVATAR_PRESETS.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => set('avatar', e)}
                className={`grid h-6 w-6 place-items-center rounded-md border text-xs ${
                  form.avatar === e ? 'border-brand bg-accent' : 'border-border bg-card hover:bg-accent'
                }`}
              >
                {e}
              </button>
            ))}
          </div>
          <div className="flex max-w-[10rem] flex-wrap gap-1" role="radiogroup" aria-label={label('color')}>
            {COLOR_PRESETS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={form.color.toLowerCase() === c.toLowerCase()}
                onClick={() => set('color', c)}
                className={`h-4 w-4 rounded-full border ${
                  form.color.toLowerCase() === c.toLowerCase() ? 'ring-2 ring-brand ring-offset-1 ring-offset-card' : 'border-border'
                }`}
                style={{ backgroundColor: c }}
                aria-label={c}
              />
            ))}
          </div>
          <FieldError errors={errors} field="avatar" />
          <FieldError errors={errors} field="color" />
        </div>
        <label className="flex flex-col gap-1">
          <span className={LABEL}>{label('displayName')}</span>
          <input
            value={form.displayName}
            onChange={(e) => set('displayName', e.target.value)}
            className={FIELD}
            data-testid="draft-display-name"
          />
          <FieldError errors={errors} field="displayName" />
        </label>
        <label className="flex flex-col gap-1">
          <span className={LABEL}>{label('name')}</span>
          <div className="flex items-center rounded-md border border-border bg-background pl-2">
            <span className="text-xs text-muted-foreground">@</span>
            <input
              value={form.name}
              onChange={(e) => set('name', e.target.value.replace(/^@/, ''))}
              className="w-full bg-transparent px-1 py-1.5 font-mono text-xs text-foreground outline-none"
              data-testid="draft-name"
            />
          </div>
          <FieldError errors={errors} field="name" />
        </label>
        <label className="col-span-3 flex flex-col gap-1">
          <span className={LABEL}>{label('description')}</span>
          <textarea
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
            rows={2}
            className={`${FIELD} resize-y leading-relaxed`}
            data-testid="draft-description"
          />
          <span className="text-[0.714rem] text-muted-foreground">
            {t('participants.draft.descriptionHint', {
              defaultValue: 'naby reads this sentence to decide when to hand work over.',
            })}
          </span>
          <FieldError errors={errors} field="description" />
        </label>
      </div>

      {isCreate ? (
        <div className="mt-2 space-y-1.5">
          <Folded label={label('instructions')} text={card.draft.instructions} testId="draft-instructions" />
          {card.draft.guardrailsPolicy ? (
            <Folded label={label('guardrailsPolicy')} text={card.draft.guardrailsPolicy} testId="draft-policy" />
          ) : null}
          {card.draft.greeting ? (
            <Folded label={label('greeting')} text={card.draft.greeting} testId="draft-greeting" />
          ) : null}
          <div className="text-[0.714rem] text-muted-foreground" data-testid="draft-safe-defaults">
            {t('participants.draft.safeDefaults', {
              defaultValue: 'Starts with no tools, MCP servers or skills, and remembers only this session. Widen them in Settings.',
            })}
          </div>
        </div>
      ) : (
        <div className="mt-2 space-y-1.5" data-testid="draft-changes">
          {changedText.map((f) => {
            const before = card.before ? card.before[f] : '';
            const after = card.draft[f];
            const long = f === 'instructions' || f === 'guardrailsPolicy' || f === 'greeting';
            return (
              <div key={f} className="rounded-lg bg-muted px-2.5 py-1.5 text-xs" data-testid={`draft-change-${f}`}>
                <div className="font-semibold text-foreground">{label(f)}</div>
                {long ? (
                  <div className="mt-1 space-y-1">
                    <Folded
                      label={t('participants.draft.before', { defaultValue: 'Before' })}
                      text={String(before) || '—'}
                      testId={`draft-before-${f}`}
                    />
                    <Folded
                      label={t('participants.draft.after', { defaultValue: 'After' })}
                      text={String(after) || '—'}
                      testId={`draft-after-${f}`}
                    />
                  </div>
                ) : (
                  <div className="mt-0.5 break-words">
                    <span className="text-muted-foreground line-through">{String(before) || '—'}</span>
                    <span className="mx-1.5 text-muted-foreground">→</span>
                    <span className="text-foreground">{String(after) || '—'}</span>
                  </div>
                )}
              </div>
            );
          })}
          {card.changed.includes('avatar') || card.changed.includes('color') ? (
            <div className="text-[0.714rem] text-muted-foreground" data-testid="draft-change-look">
              {label('avatar')} / {label('color')}: {card.before ? avatarText(card.before.avatar) : ''} {card.before?.color} →{' '}
              {avatarText(card.draft.avatar)} {card.draft.color}
            </div>
          ) : null}
        </div>
      )}

      <div className="mt-3 flex flex-wrap justify-end gap-1.5">
        <button
          onClick={() => onAnswer('decline', form)}
          disabled={busy}
          className={`${BTN} border-border bg-card text-muted-foreground hover:text-foreground hover:bg-accent`}
          data-testid="draft-decline"
        >
          {t('participants.draft.decline', { defaultValue: 'Decline' })}
        </button>
        {isCreate ? (
          <>
            <button
              onClick={() => onAnswer('create-only', form)}
              disabled={blocked}
              className={`${BTN} border-border bg-card text-foreground hover:bg-accent`}
              data-testid="draft-create-only"
            >
              {t('participants.draft.createOnly', { defaultValue: 'Create only' })}
            </button>
            <button
              onClick={() => onAnswer('create-add', form)}
              disabled={blocked}
              className={`${BTN} border-transparent bg-primary text-primary-foreground hover:bg-primary/90`}
              data-testid="draft-create-add"
            >
              {t('participants.draft.createAndAdd', { defaultValue: 'Create and add to this chat' })}
            </button>
          </>
        ) : (
          <button
            onClick={() => onAnswer('apply', form)}
            disabled={blocked}
            className={`${BTN} border-transparent bg-primary text-primary-foreground hover:bg-primary/90`}
            data-testid="draft-apply"
          >
            {t('participants.draft.apply', { defaultValue: 'Apply' })}
          </button>
        )}
      </div>
      {more > 0 ? (
        <div className="mt-1.5 text-[0.714rem] text-muted-foreground">
          {t('toolApproval.more', { defaultValue: '+{{count}} more waiting', count: more })}
        </div>
      ) : null}
    </div>
  );
});
