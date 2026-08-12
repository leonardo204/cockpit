'use client';

/**
 * Phase 3 (P3-M3) — the Telegram escalation channel settings, rendered under the
 * Agents section in SettingsModal.
 *
 * naby's persona agent escalates a critical decision (and reports when done) over
 * Telegram so the user stays in the loop while away. This panel configures the
 * bot token + chat id it sends to. naby is a SEPARATE product from the dotclaude
 * messenger — it uses its OWN dedicated bot (create one with @BotFather). The
 * chat id can be auto-detected: message the naby bot once, then tap "Detect".
 *
 * The token is shown REDACTED (`1234…AAE1`); leaving it blank on save keeps the
 * stored secret, so the mask never wipes it.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@cockpit/shared-ui';
import { SettingsDetails } from './SettingsDetails';

type TelegramSyncMode = 'always' | 'manual';
type TelegramView = {
  enabled: boolean;
  botTokenRedacted: string;
  chatId: string;
  syncMode: TelegramSyncMode;
  ready: boolean;
};

async function tgAction(body: Record<string, unknown>): Promise<
  { ok: true; telegram?: TelegramView; chatId?: string } | { ok: false; error: string }
> {
  try {
    const res = await fetch('/api/naby', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as
      | { ok: boolean; telegram?: TelegramView; chatId?: string; error?: string }
      | null;
    if (!res.ok || !json?.ok) return { ok: false, error: json?.error ?? `request failed (${res.status})` };
    return { ok: true, telegram: json.telegram, chatId: json.chatId };
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
  const [syncMode, setSyncMode] = useState<TelegramSyncMode>('manual');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await tgAction({ action: 'telegram.get' });
    if (res.ok && res.telegram) {
      setEnabled(res.telegram.enabled);
      setTokenMask(res.telegram.botTokenRedacted);
      setChatId(res.telegram.chatId);
      setSyncMode(res.telegram.syncMode === 'always' ? 'always' : 'manual');
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
      syncMode,
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
  }, [enabled, chatId, syncMode, tokenInput, t]);

  const detect = useCallback(async () => {
    setBusy(true);
    // Save the token first so detection can call the bot.
    if (tokenInput.trim()) await tgAction({ action: 'telegram.set', botToken: tokenInput.trim() });
    const res = await tgAction({ action: 'telegram.detectChat' });
    setBusy(false);
    if (res.ok && res.chatId) {
      setChatId(res.chatId);
      setTokenInput('');
      toast(t('telegramSettings.detected', { defaultValue: 'Chat ID detected.' }), 'success');
    } else {
      toast(res.ok ? '' : res.error, 'error');
    }
  }, [tokenInput, t]);

  const test = useCallback(async () => {
    setBusy(true);
    // Save first so the test uses exactly what is on screen.
    await tgAction({
      action: 'telegram.set',
      enabled,
      chatId,
      syncMode,
      ...(tokenInput.trim() ? { botToken: tokenInput.trim() } : {}),
    });
    const res = await tgAction({ action: 'telegram.test' });
    setBusy(false);
    if (res.ok) toast(t('telegramSettings.testSent', { defaultValue: 'Test message sent — check Telegram.' }), 'success');
    else toast(res.ok ? '' : res.error, 'error');
    void load();
  }, [enabled, chatId, syncMode, tokenInput, t, load]);

  return (
    <div className="space-y-3">
      {/* Plain muted prose, and ONE sentence: what this channel is for. The
          three sentences that followed it were a setup walkthrough, which has
          moved below the fields it walks through. */}
      <p className="text-xs text-muted-foreground leading-relaxed">
        {t('telegramSettings.description', {
          defaultValue:
            'How an agent reaches you when it hits a critical decision, and where it sends its final report.',
        })}
      </p>

      <label className="flex items-center gap-2 text-xs text-foreground">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        {t('telegramSettings.enable', { defaultValue: 'Enable Telegram escalation' })}
        {ready ? (
          <span className="text-[0.714rem] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
            {t('telegramSettings.ready', { defaultValue: 'ready' })}
          </span>
        ) : null}
      </label>

      <label className="flex flex-col gap-0.5">
        <span className="text-[0.714rem] text-muted-foreground">{t('telegramSettings.botToken', { defaultValue: 'Bot token' })}</span>
        <input
          value={tokenInput}
          onChange={(e) => setTokenInput(e.target.value)}
          placeholder={tokenMask || t('telegramSettings.tokenPlaceholder', { defaultValue: '123456:AA… (from @BotFather)' })}
          className="text-xs px-2 py-1 rounded border border-border bg-background text-foreground font-mono"
        />
        <span className="text-[0.714rem] text-muted-foreground">
          {tokenMask
            ? t('telegramSettings.tokenKept', { defaultValue: 'Leave blank to keep the current token.' })
            : t('telegramSettings.tokenHint', { defaultValue: 'A dedicated naby bot, separate from any other tool.' })}
        </span>
      </label>

      <label className="flex flex-col gap-0.5">
        <span className="text-[0.714rem] text-muted-foreground">{t('telegramSettings.chatId', { defaultValue: 'Chat ID' })}</span>
        <div className="flex gap-2 items-center">
          <input
            value={chatId}
            onChange={(e) => setChatId(e.target.value)}
            placeholder="123456789"
            className="text-xs px-2 py-1 rounded border border-border bg-background text-foreground font-mono w-48"
          />
          <button
            onClick={() => void detect()}
            disabled={busy}
            className="text-xs px-2 py-1 rounded border border-border text-foreground hover:bg-muted disabled:opacity-50"
          >
            {t('telegramSettings.detect', { defaultValue: 'Detect' })}
          </button>
        </div>
        <span className="text-[0.714rem] text-muted-foreground">
          {t('telegramSettings.detectHint', { defaultValue: 'Message your naby bot once, then tap Detect.' })}
        </span>
      </label>

      {/* Delivery mode (telegram-chat §8.1): manual is everything the channel
          did before; always additionally mirrors every finished desktop turn so
          work stays followable — and answerable, by reply — from the phone. */}
      <fieldset className="flex flex-col gap-1">
        <legend className="text-[0.714rem] text-muted-foreground">
          {t('telegramSettings.syncMode', { defaultValue: 'Delivery mode' })}
        </legend>
        <label className="flex items-start gap-2 text-xs text-foreground">
          <input
            type="radio"
            name="telegram-sync-mode"
            className="mt-0.5"
            checked={syncMode === 'manual'}
            onChange={() => setSyncMode('manual')}
          />
          <span className="flex flex-col">
            {t('telegramSettings.syncManual', { defaultValue: 'On demand' })}
            <span className="text-[0.714rem] text-muted-foreground">
              {t('telegramSettings.syncManualHint', {
                defaultValue: 'Only escalations, check-ins and final reports — the current behavior.',
              })}
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-xs text-foreground">
          <input
            type="radio"
            name="telegram-sync-mode"
            className="mt-0.5"
            checked={syncMode === 'always'}
            onChange={() => setSyncMode('always')}
          />
          <span className="flex flex-col">
            {t('telegramSettings.syncAlways', { defaultValue: 'Always sync' })}
            <span className="text-[0.714rem] text-muted-foreground">
              {t('telegramSettings.syncAlwaysHint', {
                defaultValue: 'Mirror every finished turn (request + answer) to Telegram; reply to one to continue that session.',
              })}
            </span>
          </span>
        </label>
      </fieldset>

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

      {/* The setup recipe — make a bot, paste the token, message it, detect —
          used to be sentences two through four of the opening paragraph, read
          before the reader had seen a single field. It is a walkthrough of the
          controls now directly above it, so it belongs here and on request. */}
      <SettingsDetails>
        <p>{t('telegramSettings.setupNote')}</p>
      </SettingsDetails>
    </div>
  );
}
