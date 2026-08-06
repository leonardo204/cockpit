'use client';

/**
 * Phase 1.5 (P15-07) — the cold-start interview.
 *
 * A fresh install knows nothing about its user, so the persona's first
 * recommendations are guesses and the check-ins that score them measure noise.
 * Four questions fix the worst of that before the first turn.
 *
 * WHY IT IS A CARD AND NOT A BLOCKING WIZARD. Onboarding that stands between a
 * person and the thing they installed gets clicked through without being read,
 * which produces worse answers than not asking. This sits in Settings → Memory,
 * every field is optional, and "later" is a real button — the flag is set either
 * way, because re-offering a form someone closed is how a first run turns
 * annoying.
 *
 * The answers become CONFIRMED user-tier memory, unlike everything else that
 * writes memory. That is not an exception to the write gate: the gate's rule is
 * that EXTERNAL content never auto-confirms, and this is the user's own words
 * typed in answer to a direct question. Routing them through a review queue so
 * they can confirm what they just wrote would be theatre.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@cockpit/shared-ui';

type Question = { id: string; type: string; labelKey: string; placeholderKey: string };

type BootstrapWire = {
  offer: boolean;
  questions: Question[];
  existing: Record<string, string>;
  stored?: number;
  skipped?: Array<{ id: string; reason: string }>;
};

async function post(body: Record<string, unknown>): Promise<BootstrapWire | null> {
  try {
    const res = await fetch('/api/naby', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as { ok?: boolean; bootstrap?: BootstrapWire } | null;
    return res.ok && json?.ok && json.bootstrap ? json.bootstrap : null;
  } catch {
    return null;
  }
}

export function BootstrapCard({ isOpen, onSaved }: { isOpen: boolean; onSaved?: () => void }) {
  const { t } = useTranslation();
  const [state, setState] = useState<BootstrapWire | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    let live = true;
    void post({ action: 'bootstrap.get' }).then((next) => {
      if (!live || !next) return;
      setState(next);
      setAnswers(next.existing);
    });
    return () => {
      live = false;
    };
  }, [isOpen]);

  const finish = useCallback(
    async (dismiss: boolean) => {
      setBusy(true);
      const result = await post({
        action: 'bootstrap.save',
        ...(dismiss ? { dismiss: true } : { answers }),
      });
      setBusy(false);
      if (!result) {
        toast(t('bootstrap.failed', { defaultValue: 'That could not be saved.' }), 'error');
        return;
      }
      setState(null);
      if (!dismiss) {
        const skipped = result.skipped?.length ?? 0;
        toast(
          skipped > 0
            ? t('bootstrap.savedWithSkips', {
                defaultValue: 'Saved {{count}}. {{skipped}} could not be stored.',
                count: result.stored ?? 0,
                skipped,
              })
            : t('bootstrap.saved', { defaultValue: 'Saved {{count}} thing(s) about you.', count: result.stored ?? 0 }),
          'success',
        );
        onSaved?.();
      }
    },
    [answers, onSaved, t],
  );

  if (!state?.offer) return null;

  return (
    <div className="space-y-2 rounded-lg border border-brand/40 bg-brand/5 p-3" data-testid="bootstrap-card">
      <div className="text-xs font-medium text-foreground">
        {t('bootstrap.title', { defaultValue: 'Tell naby four things and it starts out knowing you' })}
      </div>
      <p className="text-[0.786rem] leading-relaxed text-muted-foreground">
        {t('bootstrap.body', {
          defaultValue:
            'Every field is optional, and you can change any of it later in this list. Blank answers are not stored.',
        })}
      </p>
      {/* WHERE THIS ENDS (settings-ia-reorg §3.3). Four questions is the whole of
          the cold start, and when they are answered the card disappears — which
          leaves "so how do I teach it more?" unanswered on the one screen where
          it is being asked. The fast-growth session is that answer, and it lives
          on the naby tab, so the card names it rather than pretending the
          interview was everything. */}
      <p className="text-[0.786rem] leading-relaxed text-muted-foreground">
        {t('bootstrap.fastGrowth', {
          defaultValue: 'To teach it more, open a fast-growth session from the Naby tab.',
        })}
      </p>

      {state.questions.map((q) => (
        <label key={q.id} className="flex flex-col gap-0.5">
          <span className="text-[0.714rem] text-muted-foreground">{t(q.labelKey, { defaultValue: q.id })}</span>
          <input
            value={answers[q.id] ?? ''}
            onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
            placeholder={t(q.placeholderKey, { defaultValue: '' })}
            className="rounded border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:border-brand/50"
          />
        </label>
      ))}

      <div className="flex gap-1.5 pt-0.5">
        <button
          onClick={() => void finish(false)}
          disabled={busy}
          className="rounded border border-brand/50 px-2.5 py-1 text-xs text-brand hover:bg-brand/10 disabled:opacity-50"
        >
          {t('bootstrap.save', { defaultValue: 'Save' })}
        </button>
        <button
          onClick={() => void finish(true)}
          disabled={busy}
          className="rounded border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          {t('bootstrap.later', { defaultValue: 'Not now' })}
        </button>
      </div>
    </div>
  );
}
