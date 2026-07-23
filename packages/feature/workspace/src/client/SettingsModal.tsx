'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@cockpit/shared-ui';
import { APP_DESCRIPTION, APP_TITLE } from '@cockpit/shared-utils';
import { toast } from '@cockpit/shared-ui';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { Effect } from 'effect';
import {
  loadSettings,
  saveSettings,
  loadCockpitVersion,
} from './effect/workspaceClient';
// F1-04. Provider keys are a desktop-app concern (safeStorage lives in the
// Electron main process), so the section renders itself as unavailable when
// `window.naby` is absent — i.e. in the plain browser dev server.
import { NabyProviderSettings } from './NabyProviderSetup';
// P15-06. The scoped-memory review + delete panel. Given the active session/cwd
// so its `session`/`project` scopes are addressable; `user` scope needs neither.
import { NabyMemoryReview } from './NabyMemoryReview';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** The session currently in view, so the Memory section can address
   *  `session`-scoped memory. Absent = no active session (its scope shows an
   *  unavailable notice). */
  sessionId?: string;
  /** The active project's cwd, addressing `project`-scoped memory. */
  cwd?: string;
}

export function SettingsModal({ isOpen, onClose, sessionId, cwd }: SettingsModalProps) {
  const { t, i18n } = useTranslation();
  const { theme, setTheme } = useTheme();
  const [appVersion, setAppVersion] = useState<string>('');

  // Language: 'en', 'ko', or 'auto' (use browser detection)
  const [language, setLanguageState] = useState<string>('auto');

  // Fetch current language setting from backend on open
  useEffect(() => {
    if (!isOpen) return;
    BrowserRuntime.runPromiseExit(loadSettings()).then((exit) => {
      if (exit._tag === 'Success' && exit.value.language) {
        setLanguageState(exit.value.language);
      }
    });
  }, [isOpen]);

  const handleLanguageChange = useCallback((lang: string) => {
    setLanguageState(lang);
    // Save to backend (fire-and-forget)
    BrowserRuntime.runFork(
      saveSettings({ language: lang }).pipe(Effect.orElse(() => Effect.void))
    );
    // Apply immediately
    const effective = lang === 'auto'
      ? (navigator.language.startsWith('ko') ? 'ko' : 'en')
      : lang;
    i18n.changeLanguage(effective);
  }, [i18n]);

  // Fetch app version
  useEffect(() => {
    if (!isOpen) return;
    BrowserRuntime.runPromiseExit(loadCockpitVersion()).then((exit) => {
      if (exit._tag === 'Success' && exit.value.version) {
        setAppVersion(exit.value.version);
      }
    });
  }, [isOpen]);

  if (!isOpen) return null;

  const themeOptions = [
    { value: 'system' as const, label: t('settings.themeSystem'), icon: '💻' },
    { value: 'light' as const, label: t('settings.themeLight'), icon: '☀️' },
    { value: 'dark' as const, label: t('settings.themeDark'), icon: '🌙' },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative bg-card rounded-lg shadow-xl w-full max-w-md mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-sm font-medium text-foreground">{t('settings.title')}</h2>
          <button
            onClick={onClose}
            className="p-1 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content — scrolls: the AI provider section can expand past the
            viewport on a short window, and a modal that clips its Save button
            is worse than one that scrolls. */}
        <div className="p-4 space-y-4 max-h-[75vh] overflow-y-auto">
          {/* Theme Section */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-2">
              {t('settings.theme')}
            </label>
            <div className="grid grid-cols-3 gap-2">
              {themeOptions.map((option) => (
                <button
                  key={option.value}
                  onClick={() => setTheme(option.value)}
                  className={`flex flex-col items-center gap-1 p-3 rounded-lg border transition-colors ${
                    theme === option.value
                      ? 'border-brand bg-brand/10 text-brand'
                      : 'border-border hover:border-slate-6 text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <span className="text-xl">{option.icon}</span>
                  <span className="text-xs font-medium">{option.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Divider */}
          <div className="border-t border-border" />

          {/* Language Section */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-2">
              {t('settings.language')}
            </label>
            <div className="grid grid-cols-3 gap-2">
              {[
                { value: 'auto', label: t('settings.languageAuto'), icon: '🌐' },
                { value: 'en', label: 'English', icon: '🇺🇸' },
                { value: 'ko', label: '한국어', icon: '🇰🇷' },
              ].map((option) => (
                <button
                  key={option.value}
                  onClick={() => handleLanguageChange(option.value)}
                  className={`flex flex-col items-center gap-1 p-3 rounded-lg border transition-colors ${
                    language === option.value
                      ? 'border-brand bg-brand/10 text-brand'
                      : 'border-border hover:border-slate-6 text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <span className="text-xl">{option.icon}</span>
                  <span className="text-xs font-medium">{option.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Divider */}
          <div className="border-t border-border" />

          {/* AI provider Section (F1-04) */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-2">{t('settings.aiProvider')}</label>
            <NabyProviderSettings isOpen={isOpen} />
          </div>

          {/* Divider */}
          <div className="border-t border-border" />

          {/* Memory Section (P15-06) — review + delete what Naby has remembered. */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-2">
              {t('memoryReview.title')}
            </label>
            <NabyMemoryReview isOpen={isOpen} sessionId={sessionId} cwd={cwd} />
          </div>

          {/* Divider */}
          <div className="border-t border-border" />

          {/* About Section */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-2">
              {t('settings.about')}
            </label>
            <div className="text-xs text-muted-foreground space-y-1">
              {/* APP_TITLE, not APP_NAME: the About box is exactly where a
                  tester looks to confirm which build they are reporting on, and
                  "Alpha" is the most important word there. */}
              <p>{APP_TITLE}{appVersion ? ` · shell v${appVersion}` : ''}</p>
              <p className="text-muted-foreground/60">{APP_DESCRIPTION}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
