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
// `NabyMcpServers` is the same component it always was; it simply mounts under
// Connections now rather than at the foot of the provider section
// (settings-ia-reorg §3.4).
import { NabyProviderSettings, NabyMcpServers } from './NabyProviderSetup';
import { UpdatePanel } from './UpdatePanel';
// P15-06. The scoped-memory review + delete panel. Given the active session/cwd
// so its `session`/`project` scopes are addressable; `user` scope needs neither.
// It reads its own summary (`fetchMemorySummary`, exported from that file) and
// states the pending count on its inbox heading — this modal no longer reads it,
// see the nav below.
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
// The four font knobs (family / size / chat size / code family). It sits under
// General beside theme and language because it is the third thing in the same
// question — what this app looks like — and because a nav row per one-control
// tab is the menu the reorg (§3.1) removed.
import { FontSettingsPanel } from './FontSettingsPanel';
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
  | 'general'
  | 'provider'
  | 'connections'
  | 'agents'
  | 'memory'
  | 'harness'
  | 'permissions'
  | 'about';

// Left-nav sections, GROUPED BY INTENT (settings-ia-reorg §3.1). `icon` is
// decorative only.
//
// WHAT MOVED, AND WHY THE ROWS ARE THESE EIGHT. Settings grew by accretion: each
// new feature landed on the nearest existing tab, so "AI provider" ended up
// holding an engine choice, five key accordions, two in-house MCP presets and an
// unbounded server list, while Telegram — a connection setting — sat under the
// agent tab and memory was a third section under it.
//
//   theme + language → GENERAL. Two one-control tabs, merged: each was a single
//     row of three tiles, and a nav entry per control is a menu that describes
//     itself rather than the work.
//   AI PROVIDER keeps what the name promises — which model answers, and with
//     whose key. Every MCP surface left it.
//   CONNECTIONS (new) is what this machine is wired to: the System MCP presets
//     and the user-added servers (one component, unchanged), plus Telegram.
//   NABY is the agent itself — its list, its delegation settings, its growth
//     summary. The growth REPORT is an overlay off that summary, not a section.
//   MEMORY (new) is what the agent has learned, including the decisions waiting
//     on the user. It was the third section of the agent tab, where the one
//     thing on this screen that needs answering was also the least visible. It
//     carried a count on its nav row for one build; the count lives on the tab's
//     own inbox heading now (§3.3a).
//   HARNESS / PERMISSIONS / ABOUT are unchanged.
//
// NO "ADVANCED" AND NO "OTHER". A label has to predict what is behind it
// (NN/g information scent); a bucket named for its own vagueness predicts
// nothing and becomes wherever the next feature goes.
//
// SINGLE-CODEPOINT ICONS ONLY. `agents` used 🧑‍🚀 (person + ZWJ + rocket), the
// one ZWJ sequence in the codebase: Windows does not compose it and renders TWO
// glyphs side by side, so the nav row read as a typo. 🦋 (U+1F98B) is one
// codepoint everywhere — and on-theme, since the butterfly is the agent's own
// growth/trust symbol.
const NAV_SECTIONS: { id: SettingsSectionId; labelKey: string; icon: string }[] = [
  { id: 'general', labelKey: 'settings.general', icon: '🎨' },
  { id: 'provider', labelKey: 'settings.aiProvider', icon: '🤖' },
  { id: 'connections', labelKey: 'settings.connections', icon: '🔌' },
  { id: 'agents', labelKey: 'agentManager.title', icon: '🦋' },
  { id: 'memory', labelKey: 'memoryReview.title', icon: '🧠' },
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
  // The ids were RENAMED by the reorg (theme+language → general, memory split
  // out); this state is per-mount rather than persisted, so a rename simply
  // starts at the first tab instead of restoring an id nothing renders.
  const [section, setSection] = useState<SettingsSectionId>('general');

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
                    {/* NO BADGE ON ANY ROW, and the memory row least of all
                        (settings-ia-reorg §3.3a).

                        It shipped as a bare count beside the 기억 label and the
                        first thing the user asked was what the "1" meant. The
                        answer was in `title`/`aria-label` — and Electron never
                        showed the tooltip, so the one surface that explained it
                        was unreachable on the platform this app actually runs
                        on. A number nobody can resolve is not a notification.

                        The count did not go away; the SECOND place it was shown
                        became the only one. The memory tab's inbox heading
                        states "확인할 것 N건" over the very rows it counts, which
                        is a number with its noun, its list and its actions on one
                        screen — everything the badge was missing. */}
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
            {/* GENERAL — the two one-control tabs, merged (§3.1). Two sections
                rather than one with two grids: they are separate settings, and
                the pane's rule between them is what says so. */}
            {section === 'general' ? (
              <>
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

              {/* FONTS — the third appearance control, and the only one with more
                  than one knob, so it renders as a panel rather than a tile grid
                  (the panel also keeps the `<label>`s out of this pane; see
                  settingsLayout.test.ts). */}
              <SettingsSection title={t('fonts.title')}>
                <FontSettingsPanel />
              </SettingsSection>
              </>
            ) : null}

            {/* AI PROVIDER — which model answers, and with whose key. The MCP
                halves of this panel moved to Connections (§3.4). */}
            {section === 'provider' ? (
              <SettingsSection title={t('settings.aiProvider')}>
                <NabyProviderSettings isOpen={isOpen} />
              </SettingsSection>
            ) : null}

            {/* CONNECTIONS — what this machine is wired to. The MCP component is
                the one that used to sit under the provider keys, mounted here
                unchanged; Telegram came from the agent tab, where "how naby
                reaches me" was filed under "who naby is". */}
            {section === 'connections' ? (
              <>
                {/* Its own title rather than `providerSetup.mcpServers`: the
                    component renders THAT heading itself, over the user-added
                    list, below the in-house presets. Two identical headings one
                    level apart would read as a rendering bug. */}
                <SettingsSection title={t('settings.mcpServers')}>
                  <NabyMcpServers isOpen={isOpen} />
                </SettingsSection>
                {/* Telegram escalation — how an agent reaches you (P3-M3). */}
                <SettingsSection
                  title={t('telegramSettings.title', { defaultValue: 'Telegram escalation' })}
                >
                  <NabyTelegramSettings isOpen={isOpen} />
                </SettingsSection>
              </>
            ) : null}

            {/* NABY — the agent itself. One section now: memory became its own
                tab (it is what the agent LEARNED, not what it IS) and Telegram
                went to Connections. */}
            {section === 'agents' ? (
              <SettingsSection title={t('agentManager.title', { defaultValue: 'Naby' })}>
                {/* `onLeaveSettings` is this modal's own close, handed down for
                    ONE caller: the fast-growth button, which opens a session in
                    the workspace BEHIND this modal. A control that navigates
                    somewhere else has to get out of the way, or the user is left
                    looking at Settings and told the thing they asked for is
                    somewhere they cannot see. */}
                <NabyAgentManager isOpen={isOpen} cwd={cwd} onLeaveSettings={onClose} />
              </SettingsSection>
            ) : null}

            {/* MEMORY — the decisions inbox, the switches, the browser. It
                counts its own pending decisions on the inbox heading, which is
                where the count lives now that the nav badge is gone. */}
            {section === 'memory' ? (
              <SettingsSection title={t('memoryReview.title')}>
                <NabyMemoryReview isOpen={isOpen} sessionId={sessionId} cwd={cwd} />
              </SettingsSection>
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
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
