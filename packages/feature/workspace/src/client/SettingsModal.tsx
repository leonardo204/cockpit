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
import { UpdatePanel } from './UpdatePanel';
import { DevModePanel } from './DevModePanel';
// P15-06. The scoped-memory review + delete panel. Given the active session/cwd
// so its `session`/`project` scopes are addressable; `user` scope needs neither.
import { NabyMemoryReview } from './NabyMemoryReview';
// HP-02. The Naby-owned command CRUD panel. Given the active cwd so its
// `project` scope is addressable; `user` scope needs no key.
import { NabyCommandManager } from './NabyCommandManager';
// HP-04 + HP-06. The `~/.claude` importer + import review panel (all kinds).
// Given the active cwd so its `project`-scope `.claude` is importable.
import { NabyHarnessReview } from './NabyHarnessReview';
// Phase 2 (M1). Tool-execution policy rules. Given the active cwd so its
// project-scope rules are editable.
import { NabyPolicyManager } from './NabyPolicyManager';
// Phase 3 (P3-M1). The naby agent layer: built-in persona + custom agents. The
// Memory review moves UNDER this section (an agent's learned memory), and the
// former standalone Commands section folds into Harness.
import { NabyAgentManager } from './NabyAgentManager';
// Phase 3 (P3-M3). The Telegram escalation channel config — how an agent reaches
// the user for a critical decision and sends its final report.
import { NabyTelegramSettings } from './NabyTelegramSettings';
// Every section is a flat header + content block; the content pane below draws
// the full-width rule between them (`divide-y`). Cards were tried first and made
// the multi-panel sections (Agents, Harness, About) boxes-inside-boxes.
import { SettingsSection } from './SettingsSection';

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
  | 'agents'
  | 'harness'
  | 'permissions'
  | 'about';

// Left-nav sections. Each `labelKey` reuses an existing i18n string, so no new
// nav copy is introduced. `icon` is decorative only.
//
// Phase 3 (P3-M1) reorg: `agents` is the naby agent layer (persona + memory);
// `harness` now owns command/skill/subagent (the old standalone `memory` and
// `commands` sections were folded in — memory under Agents, commands under
// Harness) so the two-layer model (`@` agents / `/` harness) shows in Settings.
//
// SINGLE-CODEPOINT ICONS ONLY. `agents` used 🧑‍🚀 (person + ZWJ + rocket), the
// one ZWJ sequence in the codebase: Windows does not compose it and renders TWO
// glyphs side by side, so the nav row read as a typo. 🦋 (U+1F98B) is one
// codepoint everywhere — and on-theme, since the butterfly is the agent's own
// growth/trust symbol.
const NAV_SECTIONS: { id: SettingsSectionId; labelKey: string; icon: string }[] = [
  { id: 'theme', labelKey: 'settings.theme', icon: '🎨' },
  { id: 'language', labelKey: 'settings.language', icon: '🌐' },
  { id: 'provider', labelKey: 'settings.aiProvider', icon: '🤖' },
  { id: 'agents', labelKey: 'agentManager.title', icon: '🦋' },
  { id: 'harness', labelKey: 'harnessReview.title', icon: '🧩' },
  { id: 'permissions', labelKey: 'policyManager.title', icon: '🛡️' },
  { id: 'about', labelKey: 'settings.about', icon: 'ℹ️' },
];

export function SettingsModal({ isOpen, onClose, sessionId, cwd }: SettingsModalProps) {
  const { t, i18n } = useTranslation();
  const { theme, setTheme } = useTheme();
  const [appVersion, setAppVersion] = useState<string>('');
  // The packaged app's own version (package.json / the release tag), read from
  // the update bridge — the only place the main process publishes it. Absent in
  // the browser dev server, where the shell version is all there is.
  const [nabyVersion, setNabyVersion] = useState<string>('');

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

  useEffect(() => {
    if (!isOpen) return;
    const w = window as unknown as {
      naby?: { updates?: { get(): Promise<{ ok: boolean; value?: { currentVersion?: string } }> } };
    };
    void w.naby?.updates?.get().then((r) => {
      if (r?.ok && r.value?.currentVersion) setNabyVersion(r.value.currentVersion);
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
          into one long scroll. Sits within the shared z-50 modal layer.

          WIDTH IS PROPORTIONAL, WITH A FLOOR. `max-w-4xl` (896px) meant the
          modal stayed the same size on a 27" display as on a laptop, wasting
          two thirds of the screen while the harness and provider panels
          scrolled. `min(86vw, 1600px)` scales with the window and stops before
          it becomes a wall of text; the `min-w` floor keeps a 48px-wide nav plus
          a usable content pane at ~880px, and yields to the viewport (minus the
          mx-4 gutters) on windows narrower than that rather than overflowing. */}
      <div className="relative bg-card rounded-lg shadow-xl w-[min(86vw,1600px)] min-w-[min(880px,calc(100vw-2rem))] h-[85vh] mx-4 flex flex-col overflow-hidden">
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
              controls.

              THE SECTION SEPARATOR LIVES HERE. `divide-y` draws one full-width
              rule BETWEEN adjacent sections and none above the first or below the
              last, which is the whole separation contract: a section is a flat
              header + content, and the only chrome around it is that line. Each
              branch renders its sections as direct children (a fragment, never a
              wrapper div) so the rule reaches both edges of the pane. */}
          <div className="flex-1 min-w-0 overflow-y-auto p-5 divide-y divide-border">
            {section === 'theme' ? (
              <SettingsSection title={t('settings.theme')}>
                {/* The button grid keeps its own max-width: three tiles stretched
                    across a 1600px pane would read as three billboards. The
                    section fills the pane; its contents stay hand-sized. */}
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
              </SettingsSection>
            ) : null}

            {section === 'language' ? (
              <SettingsSection title={t('settings.language')}>
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
              </SettingsSection>
            ) : null}

            {section === 'provider' ? (
              <SettingsSection title={t('settings.aiProvider')}>
                <NabyProviderSettings isOpen={isOpen} />
              </SettingsSection>
            ) : null}

            {section === 'agents' ? (
              <>
                <SettingsSection title={t('agentManager.title', { defaultValue: 'Agents' })}>
                  <NabyAgentManager isOpen={isOpen} cwd={cwd} />
                </SettingsSection>
                {/* Telegram escalation — how an agent reaches you (P3-M3). */}
                <SettingsSection
                  title={t('telegramSettings.title', { defaultValue: 'Telegram escalation' })}
                >
                  <NabyTelegramSettings isOpen={isOpen} />
                </SettingsSection>
                {/* Memory lives with the agents (their learned memory), P3-M1 reorg. */}
                <SettingsSection title={t('memoryReview.title')}>
                  <NabyMemoryReview isOpen={isOpen} sessionId={sessionId} cwd={cwd} />
                </SettingsSection>
              </>
            ) : null}

            {section === 'harness' ? (
              <>
                <SettingsSection title={t('harnessReview.title')}>
                  <NabyHarnessReview isOpen={isOpen} cwd={cwd} />
                </SettingsSection>
                {/* Commands folded into Harness (command/skill/subagent), P3-M1 reorg. */}
                <SettingsSection title={t('commandManager.title')}>
                  <NabyCommandManager isOpen={isOpen} cwd={cwd} />
                </SettingsSection>
              </>
            ) : null}

            {section === 'permissions' ? (
              <SettingsSection title={t('policyManager.title')}>
                <NabyPolicyManager isOpen={isOpen} cwd={cwd} />
              </SettingsSection>
            ) : null}

            {section === 'about' ? (
              <>
                <SettingsSection title={t('settings.about')}>
                  <div className="text-xs text-muted-foreground space-y-1">
                    {/* APP_TITLE, not APP_NAME: the About box is exactly where a
                        tester looks to confirm which build they are reporting on,
                        and "Alpha" is the most important word there. */}
                    {/* THE APP VERSION FIRST. This line used to show only the
                        cockpit shell's package version (1.0.245), which is not the
                        number on the release, the tag, or the update dialog — a
                        tester reading "v1.0.245" next to an update that just
                        installed 1.3.0 has no way to tell which is real. The shell
                        version stays, demoted, because it is still useful when the
                        submodule and the app move independently. */}
                    <p>
                      {APP_TITLE}
                      {nabyVersion ? ` · v${nabyVersion}` : ''}
                    </p>
                    {appVersion ? (
                      <p className="text-muted-foreground/60">shell v{appVersion}</p>
                    ) : null}
                    <p className="text-muted-foreground/60">{APP_DESCRIPTION}</p>
                  </div>
                </SettingsSection>

                {/* Updates live here rather than in a section of their own: the
                    About block is already where someone goes to find out which
                    build they are on, and "which build am I on" and "is there a
                    newer one" are the same question asked twice. Its own section,
                    separated by the pane's divider. */}
                <SettingsSection title={t('updates.title')}>
                  <UpdatePanel />
                </SettingsSection>

                {/* Renders its own section, or nothing at all when the build has
                    no dev-mode door — which is why it is not wrapped here: an
                    empty titled block would advertise a feature this binary
                    lacks. Returning null also drops its divider, because the rule
                    is drawn BETWEEN siblings that exist. */}
                <DevModePanel />
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
