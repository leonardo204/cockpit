'use client';

/**
 * NABY REACHING INTO ANOTHER PROJECT (cross-project-context R17) — the access
 * card, in the same place and the same brand-edged shape as a tool approval.
 *
 * naby called `naby_read_project` (or sent a request to a tab) for another
 * project — same sidebar group included; the turn waits for this card. Three
 * answers (R17): allow once, always allow (the directed project pair is kept,
 * R18 — deletable in Settings, never a policy rule), or decline.
 */

import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { NabyAvatar } from '@cockpit/shared-ui';
import {
  crossProjectGroupNoteKey,
  crossProjectLabelKey,
  crossProjectQuestionKey,
  QUESTION_SLOTS,
  splitQuestion,
  type CrossProjectAccessCard,
} from './crossProjectApproval';

const BTN = 'text-xs font-semibold px-3 py-1.5 rounded-md border disabled:opacity-50 transition-colors';

export const CrossProjectApprovalCard = memo(function CrossProjectApprovalCard({
  card,
  busy,
  more,
  onAllowOnce,
  onAllowAlways,
  onDeny,
}: {
  card: CrossProjectAccessCard;
  busy: boolean;
  more: number;
  onAllowOnce: () => void;
  onAllowAlways: () => void;
  onDeny: () => void;
}) {
  const { t } = useTranslation();
  const q = crossProjectQuestionKey(card);
  const note = crossProjectGroupNoteKey(card);
  const label = crossProjectLabelKey(card);
  const parts = splitQuestion(
    t(q.key, { defaultValue: q.defaultValue, ...QUESTION_SLOTS, title: card.sessionTitle ?? '' }),
    card,
    label ? t(label.key, { defaultValue: label.defaultValue, ...label.params }) : undefined,
  );
  return (
    <div
      className="mx-4 mb-2 rounded-xl border-[1.5px] border-brand/40 bg-card p-3.5 shadow-card"
      data-testid="cross-project-approval"
      data-kind={card.kind}
      data-new-session={card.newSession ? 'true' : undefined}
      data-relation={card.relation}
    >
      <div className="inline-flex items-center gap-1.5 rounded-sm bg-accent py-0.5 pl-1 pr-2 text-xs font-semibold text-accent-foreground">
        <NabyAvatar size={20} bare />
        {t('toolApproval.crossProject.title', { defaultValue: 'naby wants to look into another project' })}
      </div>
      <div className="mt-2 text-sm text-foreground break-words" data-testid="cross-project-question">
        {parts.map((p, i) =>
          p.kind === 'project' ? (
            <b key={i}>{p.text}</b>
          ) : p.kind === 'cwd' ? (
            <code key={i} className="font-mono text-[0.786rem] break-all">
              {p.text}
            </code>
          ) : (
            <span key={i}>{p.text}</span>
          ),
        )}
      </div>
      <div className="mt-1 text-xs text-muted-foreground" data-testid="cross-project-group-note">
        {t(note.key, { defaultValue: note.defaultValue, ...note.params })}
      </div>
      <div className="mt-3 flex flex-wrap justify-end gap-1.5">
        <button
          onClick={onDeny}
          disabled={busy}
          className={`${BTN} border-border bg-card text-muted-foreground hover:text-foreground hover:bg-accent`}
          data-testid="cross-project-deny"
        >
          {t('toolApproval.crossProject.deny', { defaultValue: 'Decline' })}
        </button>
        <button
          onClick={onAllowAlways}
          disabled={busy}
          className={`${BTN} border-border bg-card text-foreground hover:bg-accent`}
          data-testid="cross-project-allow-always"
        >
          {t('toolApproval.crossProject.allowAlways', { defaultValue: 'Always allow' })}
        </button>
        <button
          onClick={onAllowOnce}
          disabled={busy}
          className={`${BTN} border-transparent bg-primary text-primary-foreground hover:bg-primary/90`}
          data-testid="cross-project-allow"
        >
          {t('toolApproval.crossProject.allowOnce', { defaultValue: 'Allow once' })}
        </button>
      </div>
      {more > 0 ? (
        <div className="mt-1.5 text-[0.714rem] text-muted-foreground">
          {t('toolApproval.more', { defaultValue: '+{{count}} more waiting', count: more })}
        </div>
      ) : null}
    </div>
  );
});
