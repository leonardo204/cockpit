'use client';

/**
 * "Instructions for every session" (specs/user-instructions.md §4).
 *
 * One textarea and a Save button. The text is stored under the setting
 * `instructions.global` and read fresh on every turn, so a save takes effect on
 * the next message in any project. Over the cap the Save button is disabled and
 * the counter turns red: the server refuses rather than truncates, and the
 * editor says so before the user tries.
 */

import { memo, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@cockpit/shared-ui';

type NabyReply = {
  ok: boolean;
  error?: string;
  instructions?: string;
  instructionsMaxChars?: number;
};

async function nabyPost(body: Record<string, unknown>): Promise<NabyReply> {
  try {
    const res = await fetch('/api/naby', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as (Omit<NabyReply, 'ok'> & { ok?: boolean }) | null;
    if (!json) return { ok: false, error: `request failed (${res.status})` };
    return { ...json, ok: !!json.ok && res.ok };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Mirrors USER_INSTRUCTIONS_MAX_CHARS until the server answers with the real one. */
const FALLBACK_MAX = 8000;

export const NabyUserInstructions = memo(function NabyUserInstructions({ isOpen }: { isOpen: boolean }) {
  const { t } = useTranslation();
  const [saved, setSaved] = useState('');
  const [draft, setDraft] = useState('');
  const [max, setMax] = useState(FALLBACK_MAX);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    let alive = true;
    void nabyPost({ action: 'instructions.get' }).then((res) => {
      if (!alive) return;
      if (res.ok) {
        const text = res.instructions ?? '';
        setSaved(text);
        setDraft(text);
        if (typeof res.instructionsMaxChars === 'number') setMax(res.instructionsMaxChars);
      }
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, [isOpen]);

  // Compared trimmed, because the server stores the trimmed text: a trailing
  // newline is not an unsaved change.
  const dirty = draft.trim() !== saved;
  const length = draft.trim().length;
  const tooLong = length > max;

  const onSave = useCallback(async () => {
    setBusy(true);
    const res = await nabyPost({ action: 'instructions.set', text: draft });
    setBusy(false);
    if (!res.ok) {
      toast(t('userInstructions.failed', { error: res.error ?? '' }), 'error');
      return;
    }
    const text = res.instructions ?? '';
    setSaved(text);
    setDraft(text);
    toast(t('userInstructions.saved'), 'success');
  }, [draft, t]);

  if (!loaded) {
    return <p className="text-xs text-muted-foreground">{t('userInstructions.loading')}</p>;
  }

  return (
    <div className="space-y-2" data-testid="user-instructions">
      <p className="text-[0.714rem] text-muted-foreground leading-relaxed">{t('userInstructions.hint')}</p>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={t('userInstructions.placeholder')}
        rows={8}
        aria-label={t('userInstructions.title')}
        data-testid="user-instructions-input"
        className="w-full text-xs px-2 py-1.5 rounded border border-border bg-background text-foreground leading-relaxed resize-y"
      />
      <div className="flex items-center gap-2">
        <span
          className={`text-[0.714rem] tabular-nums ${tooLong ? 'text-red-500' : 'text-muted-foreground'}`}
          data-testid="user-instructions-count"
        >
          {tooLong
            ? t('userInstructions.tooLong', { count: length, max })
            : t('userInstructions.count', { count: length, max })}
        </span>
        {dirty && !tooLong ? (
          <span className="text-[0.714rem] text-muted-foreground">· {t('userInstructions.unsaved')}</span>
        ) : null}
        <span className="flex-1" />
        {draft ? (
          <button
            type="button"
            onClick={() => setDraft('')}
            disabled={busy}
            className="text-xs px-2 py-1 rounded border border-border hover:bg-brand/10 hover:border-brand/40 text-foreground disabled:opacity-50"
          >
            {t('userInstructions.clear')}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => void onSave()}
          disabled={busy || !dirty || tooLong}
          data-testid="user-instructions-save"
          className="text-xs px-3 py-1.5 rounded border border-brand bg-brand/10 text-brand hover:bg-brand/20 disabled:opacity-50"
        >
          {busy ? t('userInstructions.saving') : t('userInstructions.save')}
        </button>
      </div>
    </div>
  );
});
