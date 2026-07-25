'use client';

/**
 * Phase 3 (P3-M3) — the Telegram escalation channel settings, rendered under the
 * Agents section in SettingsModal.
 *
 * naby's persona agent escalates a critical decision (and reports when done) over
 * Telegram so the user stays in the loop while away. This panel configures the
 * bot token + chat id it sends to. On first run naby pre-fills these from the
 * dotclaude messenger the user may already have (~/.claude/messenger.json), so
 * the fields often arrive populated and DISABLED — the user just flips it on and
 * hits Test.
 *
 * The token is shown REDACTED (`1234…AAE1`); leaving it blank on save keeps the
 * stored secret, so the mask never wipes it.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@cockpit/shared-ui';

type TelegramView = { enabled: boolean; botTokenRedacted: string; chatId: string; ready: boolean };

async function tgAction(body: Record<string, unknown>): Promise<
  { ok: true; telegram?: TelegramView } | { ok: false; error: string }
> {
  try {
    const res = await fetch('/api/naby', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as
      | { ok: boolean; telegram?: TelegramView; error?: string }
      | null;
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? `request failed (${res.status})` };
    return { ok: true, telegram: json.telegram };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function NabyTelegramSettings({ isOpen }: { isOpen: boolean }) {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(false);
  const [tokenMask, setTokenMask] = useState('');
  const [tokenInput, setTokenInput] = useState(''); // blank = keep stored
  const [chatId, setChatId] = useState('');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await tgAction({ action: 'telegram.get' });
    if (res.ok && res.telegram) {
      setEnabled(res.telegram.enabled);
      setTokenMask(res.telegram.botTokenRedacted);
      setChatId(res.telegram.chatId);
      setReady(res.telegram.ready);
      setTokenInput('');
    }
  }, []);

  useEffect(() => {
    if (isOpen) void load();
  }, [isOpen, load]);

  const save = useCallback(async () => {
    setBusy(true);
    const res = await tgAction({
      action: 'telegram.set',
      enabled,
      chatId,
      ...(tokenInput.trim() ? { botToken: tokenInput.trim() } : {}),
    });
    setBusy(false);
    if (res.ok && res.telegram) {
      setTokenMask(res.telegram.botTokenRedacted);
      setReady(res.telegram.ready);
      setTokenInput('');
      toast(t('telegramSettings.saved', { defaultValue: 'Telegram settings saved.' }), 'success');
    } else {
      toast(res.ok ? '' : res.error, 'error');
    }
  }, [enabled, chatId, tokenInput, t]);

  const test = useCallback(async () => {
    setBusy(true);
    // Save first so the test uses exactly what is on screen.
    await tgAction({
      action: 'telegram.set',
      enabled,
      chatId,
      ...(tokenInput.trim() ? { botToken: tokenInput.trim() } : {}),
    });
    const res = await tgAction({ action: 'telegram.test' });
    setBusy(false);
    if (res.ok) toast(t('telegramSettings.testSent', { defaultValue: 'Test message sent — check Telegram.' }), 'success');
    else toast(res.ok ? '' : res.error, 'error');
    void load();
  }, [enabled, chatId, tokenInput, t, load]);

  return (
    <div className="space-y-3">
      <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground leading-relaxed">
        {t('telegramSettings.description', {
          defaultValue:
            'How an agent reaches you when it hits a critical decision, and where it sends its final report. Uses a Telegram bot — reply or tap a button to approve remotely. Pre-filled from your existing setup when available.',
        })}
      </p>

      <label className="flex items-center gap-2 text-xs text-foreground">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        {t('telegramSettings.enable', { defaultValue: 'Enable Telegram escalation' })}
        {ready ? (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
            {t('telegramSettings.ready', { defaultValue: 'ready' })}
          </span>
        ) : null}
      </label>

      <label className="flex flex-col gap-0.5">
        <span className="text-[10px] text-muted-foreground">{t('telegramSettings.botToken', { defaultValue: 'Bot token' })}</span>
        <input
          value={tokenInput}
          onChange={(e) => setTokenInput(e.target.value)}
          placeholder={tokenMask || t('telegramSettings.tokenPlaceholder', { defaultValue: '123456:AA… (from @BotFather)' })}
          className="text-xs px-2 py-1 rounded border border-border bg-background text-foreground font-mono"
        />
        <span className="text-[10px] text-muted-foreground">
          {tokenMask
            ? t('telegramSettings.tokenKept', { defaultValue: 'Leave blank to keep the current token.' })
            : t('telegramSettings.tokenHint', { defaultValue: 'One bot can serve both naby and other tools.' })}
        </span>
      </label>

      <label className="flex flex-col gap-0.5">
        <span className="text-[10px] text-muted-foreground">{t('telegramSettings.chatId', { defaultValue: 'Chat ID' })}</span>
        <input
          value={chatId}
          onChange={(e) => setChatId(e.target.value)}
          placeholder="123456789"
          className="text-xs px-2 py-1 rounded border border-border bg-background text-foreground font-mono w-48"
        />
      </label>

      <div className="flex gap-2">
        <button
          onClick={() => void save()}
          disabled={busy}
          className="text-xs px-3 py-1.5 rounded border border-brand bg-brand/10 text-brand hover:bg-brand/20 disabled:opacity-50"
        >
          {t('telegramSettings.save', { defaultValue: 'Save' })}
        </button>
        <button
          onClick={() => void test()}
          disabled={busy}
          className="text-xs px-3 py-1.5 rounded border border-border text-foreground hover:bg-muted disabled:opacity-50"
        >
          {t('telegramSettings.test', { defaultValue: 'Send test message' })}
        </button>
      </div>
    </div>
  );
}
