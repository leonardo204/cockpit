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
// HP-02. The Naby-owned command CRUD panel. Given the active cwd so its
// `project` scope is addressable; `user` scope needs no key.
import { NabyCommandManager } from './NabyCommandManager';
// HP-04 + HP-06. The `~/.claude` importer + import review panel (all kinds).
// Given the active cwd so its `project`-scope `.claude` is importable.
import { NabyHarnessReview } from './NabyHarnessReview';

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

type SettingsSectionId =
  | 'theme'
  | 'language'
  | 'provider'
  | 'memory'
  | 'commands'
  | 'harness'
  | 'about';

// Left-nav sections. Each `labelKey` reuses an existing i18n string, so no new
// nav copy is introduced. `icon` is decorative only.
const NAV_SECTIONS: { id: SettingsSectionId; labelKey: string; icon: string }[] = [
  { id: 'theme', labelKey: 'settings.theme', icon: '🎨' },
  { id: 'language', labelKey: 'settings.language', icon: '🌐' },
  { id: 'provider', labelKey: 'settings.aiProvider', icon: '🤖' },
  { id: 'memory', labelKey: 'memoryReview.title', icon: '🧠' },
  { id: 'commands', labelKey: 'commandManager.title', icon: '⌘' },
  { id: 'harness', labelKey: 'harnessReview.title', icon: '🧩' },
  { id: 'about', labelKey: 'settings.about', icon: 'ℹ️' },
];

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

  // Which section the left nav has selected — replaces the old single long
  // scroll. Kept across opens so returning to Settings lands where you left.
  const [section, setSection] = useState<SettingsSectionId>('theme');

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

  // ESC closes the modal (kept from the old narrow modal's affordances). Only
  // bound while open so it never swallows Escape for other surfaces.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

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

      {/* Panel — a wide, near-full-screen surface split into a left section nav
          and a right content pane, so the (now many) sections no longer stack
          into one long scroll. Sits within the shared z-50 modal layer. */}
      <div className="relative bg-card rounded-lg shadow-xl w-full max-w-4xl h-[85vh] mx-4 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <h2 className="text-sm font-medium text-foreground">{t('settings.title')}</h2>
          <button
            onClick={onClose}
            aria-label={t('common.close')}
            className="p-1 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body: nav + content. Stacks on narrow windows (nav becomes a
            horizontal strip), splits side-by-side from `sm` up. */}
        <div className="flex flex-col sm:flex-row flex-1 min-h-0">
          {/* Left section nav */}
          <nav className="shrink-0 sm:w-48 border-b sm:border-b-0 sm:border-r border-border overflow-x-auto sm:overflow-y-auto">
            <ul className="flex sm:flex-col p-2 gap-1">
              {NAV_SECTIONS.map((s) => (
                <li key={s.id} className="shrink-0">
                  <button
                    onClick={() => setSection(s.id)}
                    className={`w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm text-left whitespace-nowrap transition-colors ${
                      section === s.id
                        ? 'bg-brand/10 text-brand font-medium'
                        : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                    }`}
                  >
                    <span aria-hidden>{s.icon}</span>
                    <span>{t(s.labelKey)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          {/* Right content — only the selected section renders. Scrolls on its
              own so a tall section (AI provider / harness) never clips its
              controls. */}
          <div className="flex-1 min-w-0 overflow-y-auto p-5">
            {section === 'theme' ? (
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">
                  {t('settings.theme')}
                </label>
                <div className="grid grid-cols-3 gap-2 max-w-md">
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
            ) : null}

            {section === 'language' ? (
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">
                  {t('settings.language')}
                </label>
                <div className="grid grid-cols-3 gap-2 max-w-md">
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
            ) : null}

            {section === 'provider' ? (
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">{t('settings.aiProvider')}</label>
                <NabyProviderSettings isOpen={isOpen} />
              </div>
            ) : null}

            {section === 'memory' ? (
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">
                  {t('memoryReview.title')}
                </label>
                <NabyMemoryReview isOpen={isOpen} sessionId={sessionId} cwd={cwd} />
              </div>
            ) : null}

            {section === 'commands' ? (
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">
                  {t('commandManager.title')}
                </label>
                <NabyCommandManager isOpen={isOpen} cwd={cwd} />
              </div>
            ) : null}

            {section === 'harness' ? (
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">
                  {t('harnessReview.title')}
                </label>
                <NabyHarnessReview isOpen={isOpen} cwd={cwd} />
              </div>
            ) : null}

            {section === 'about' ? (
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">
                  {t('settings.about')}
                </label>
                <div className="text-xs text-muted-foreground space-y-1">
                  {/* APP_TITLE, not APP_NAME: the About box is exactly where a
                      tester looks to confirm which build they are reporting on,
                      and "Alpha" is the most important word there. */}
                  <p>{APP_TITLE}{appVersion ? ` · shell v${appVersion}` : ''}</p>
                  <p className="text-muted-foreground/60">{APP_DESCRIPTION}</p>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
