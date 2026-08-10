'use client';

/**
 * F1-04 / F1-06 — API key entry and the first-run wizard.
 *
 * ONE FILE, TWO SURFACES. `<NabyProviderSettings />` is the section rendered
 * inside SettingsModal; `<NabyOnboardingWizard />` is the full-screen first-run
 * flow. They share every piece of logic below because they are the same task
 * with different framing — and because this is a git submodule, so one new file
 * plus two three-line call sites is the entire fork diff.
 *
 * THE PROVIDER LIST IS NOT IN THIS FILE. It comes from
 * `window.naby.providers.describe()`, which the main process answers from the
 * runtime's `describeProviders()` (contract §4). Adding a sixth provider is a
 * registry change in the parent repo and this UI picks it up with no edit —
 * which is the point, and why the fields below are rendered from
 * `configFields` rather than from a hardcoded switch on provider name.
 *
 * WHAT THIS COMPONENT CAN AND CANNOT SEE
 *   * It can see WHETHER a key is stored (`stored`), the storage backend, and
 *     whether that backend is secure.
 *   * It can never see a key. There is no read channel (see preload.ts), so a
 *     stored key is rendered as "Saved" and never as characters. Replacing a
 *     key means typing a new one; there is no "show" button to add later.
 *
 * THE INSECURE PATH IS THE INTERESTING ONE (design §4.1). On a machine with no
 * OS secret store, `safeStorage` silently encrypts with a hardcoded password.
 * Main REFUSES the write in that case with CREDENTIAL_INSECURE; this component
 * turns that refusal into a visible explanation plus an explicit "Save anyway",
 * which retries with `acknowledgeInsecure`. The user can still proceed — they
 * just cannot do it unknowingly.
 *
 * NO KEY EVER ENTERS REACT STATE THAT OUTLIVES THE SAVE: the input is cleared
 * on success, and the value is never written to localStorage, a query string,
 * or a log.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  SYSTEM_MCP_PRESETS,
  SYSTEM_MCP_PRESET_NAMES,
  type SystemMcpPresetView,
  type SystemMcpStatus,
} from './systemMcpPresets';
import { SettingsDetails } from './SettingsDetails';

// ---------------------------------------------------------------------------
// The preload bridge (electron/preload.ts). Typed locally so this file compiles
// in the browser-only dev server too, where `window.naby` is simply absent.
// ---------------------------------------------------------------------------

type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string; detail?: string } };

type Security = { backend: string; secure: boolean; warning: string | null };

type ProviderRow = {
  kind: string;
  label: string;
  configFields: string[];
  modelMeaning: string;
  defaultModel: string;
  envVar: string;
  keyHelp: string;
  stored: boolean;
  model: string;
  config: Record<string, unknown>;
};

type DescribeResult = { providers: ProviderRow[]; security: Security };

type OnboardingState = {
  onboarded: boolean;
  configured: string[];
  skipped: boolean;
  security: Security;
};

type NabyBridge = {
  credentials: {
    status: (providerId: string) => Promise<Result<{ stored: boolean; backend: string; secure: boolean }>>;
    set: (
      providerId: string,
      key: string,
      opts?: { acknowledgeInsecure?: boolean },
    ) => Promise<Result<{ secure: boolean }>>;
    clear: (providerId: string) => Promise<Result<void>>;
  };
  providers: {
    describe: () => Promise<Result<DescribeResult>>;
    upsert: (profile: unknown) => Promise<Result<void>>;
  };
  onboarding: {
    state: () => Promise<Result<OnboardingState>>;
    complete: () => Promise<Result<void>>;
  };
};

/** The provider kind of the DEV-ONLY ChatGPT subscription provider. It signs in
 *  by OAuth, not an API key, so it is filtered out of the "API keys" paste-a-key
 *  list. In the engine selector it appears exactly like Claude (subscription):
 *  a plain selectable "which model answers" row. Account management (sign in /
 *  out) lives ONLY in the session bottom bar (ChatgptLoginStatus), never here. */
const CHATGPT_OAUTH_KIND = 'openai-chatgpt-oauth';

/** Google Gemini. THE ONE PROVIDER WHERE THE MODEL IS A LIST RATHER THAN A
 *  STRING TO KNOW: a single Google key opens the whole Gemini catalog, so this
 *  form offers the live list (`models.list` provider:'google') beside the text
 *  box instead of asking the user to remember an id. The key is not involved on
 *  this side — the server resolves it and answers with model ids. */
const GOOGLE_KIND = 'google';

declare global {
  interface Window {
    naby?: Partial<NabyBridge>;
  }
}

/** The bridge, or undefined when running outside the desktop app. */
function bridge(): NabyBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  const naby = window.naby;
  if (!naby?.credentials || !naby.providers || !naby.onboarding) return undefined;
  return naby as NabyBridge;
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

function useProviders(active: boolean) {
  const [data, setData] = useState<DescribeResult | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  const reload = useCallback(async () => {
    const api = bridge();
    if (!api) {
      setUnavailable(true);
      return;
    }
    const res = await api.providers.describe();
    if (res.ok) setData(res.value);
  }, []);

  useEffect(() => {
    if (active) void reload();
  }, [active, reload]);

  return { data, unavailable, reload };
}

const inputClass =
  'w-full px-2 py-1.5 text-sm rounded border border-border bg-background text-foreground ' +
  'placeholder:text-muted-foreground/60 focus:outline-none focus:border-brand';

/** Placeholders/hints per config field. */
const CONFIG_PLACEHOLDERS: Record<string, string> = {
  region: 'us-east-1',
  baseURL: 'https://<resource>.services.ai.azure.com/openai/v1',
  resource: 'my-azure-resource (classic endpoint only)',
  deployment: 'my-deployment-name',
  apiVersion: '2024-10-21 (classic endpoint only)',
};

// ---------------------------------------------------------------------------
// One provider's form
// ---------------------------------------------------------------------------

function ProviderForm({
  row,
  onSaved,
  autoFocus,
}: {
  row: ProviderRow;
  onSaved: () => void;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation();
  const [key, setKey] = useState('');
  const [model, setModel] = useState(row.model || row.defaultModel);
  const [config, setConfig] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    for (const field of row.configFields) seed[field] = String(row.config[field] ?? '');
    return seed;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when main refused because the machine has no secure store. Holding it
  // in state is what turns the second click into an informed decision.
  const [insecureWarning, setInsecureWarning] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // The live Gemini catalog (Google only). Null = not asked yet; an empty answer
  // becomes a NOTE rather than an empty control, because the reason is almost
  // always "the key is not saved yet" and the user can act on that.
  const [models, setModels] = useState<string[] | null>(null);
  const [modelsBusy, setModelsBusy] = useState(false);
  const [modelsNote, setModelsNote] = useState<string | null>(null);

  /**
   * Ask the SERVER which Gemini models this key can use.
   *
   * The key never comes near this component: `models.list` resolves the stored
   * credential in the Next server, calls Google there and answers with model ids
   * (api/naby.ts). A failure is a note next to the box, never a broken form —
   * the text input below still accepts any id, which is the whole reason the
   * list is an aid and not a gate.
   */
  const loadModels = useCallback(
    async (refresh: boolean) => {
      if (row.kind !== GOOGLE_KIND) return;
      setModelsBusy(true);
      setModelsNote(null);
      try {
        const res = await nabyPost({
          action: 'models.list',
          provider: GOOGLE_KIND,
          ...(refresh ? { refresh: true } : {}),
        });
        const list = res.models?.google;
        if (Array.isArray(list) && list.length > 0) setModels(list);
        else setModelsNote(t('providerSetup.modelListEmpty'));
      } finally {
        setModelsBusy(false);
      }
    },
    [row.kind, t],
  );

  // Ask once when this provider's form opens (the accordion mounts it), and
  // again right after a save — the moment a first-time key makes the lookup
  // possible at all.
  useEffect(() => {
    void loadModels(false);
  }, [loadModels]);

  // Azure has TWO valid endpoint shapes, so not every configField is required at
  // once: supply EITHER `baseURL` (newer AI-Services /openai/v1 endpoint) OR
  // `resource` + `apiVersion` (classic). `deployment` is always required. Every
  // other provider requires all of its configFields.
  const missing =
    row.kind === 'azure-openai'
      ? [
          ...(config.deployment?.trim() ? [] : ['deployment']),
          ...(config.baseURL?.trim() || (config.resource?.trim() && config.apiVersion?.trim())
            ? []
            : ['baseURL-or-resource']),
        ]
      : row.configFields.filter((f) => !config[f]?.trim());
  const canSave = (key.trim().length > 0 || row.stored) && model.trim().length > 0 && missing.length === 0;

  const save = useCallback(
    async (acknowledgeInsecure: boolean) => {
      const api = bridge();
      if (!api) return;
      setBusy(true);
      setError(null);
      try {
        // Profile first: a key with no profile is unreachable, and main
        // materializes a default one anyway — sending ours means the model and
        // config the user just typed are the ones that get used.
        const upsert = await api.providers.upsert({
          id: row.kind,
          label: row.label,
          kind: row.kind,
          config: { kind: row.kind, ...config },
          model: model.trim(),
          // Opaque; main overwrites it regardless. Sent for shape completeness.
          credentialRef: `vault:${row.kind}`,
        });
        if (!upsert.ok) {
          setError(upsert.error.message);
          return;
        }

        // An empty key with a key already stored means "I am only editing the
        // model/config" — do not overwrite the stored key with nothing.
        if (key.trim()) {
          const res = await api.credentials.set(row.kind, key, { acknowledgeInsecure });
          if (!res.ok) {
            if (res.error.code === 'CREDENTIAL_INSECURE') {
              setInsecureWarning(res.error.message);
            } else {
              setError(res.error.message);
            }
            return;
          }
        }

        setKey(''); // the key does not linger in component state
        setInsecureWarning(null);
        setSaved(true);
        onSaved();
        // A first key makes the catalog reachable for the first time, so the list
        // beside the model box fills in without the user pressing anything.
        void loadModels(true);
      } finally {
        setBusy(false);
      }
    },
    [config, key, loadModels, model, onSaved, row.kind, row.label],
  );

  const clear = useCallback(async () => {
    const api = bridge();
    if (!api) return;
    setBusy(true);
    try {
      await api.credentials.clear(row.kind);
      setSaved(false);
      onSaved();
    } finally {
      setBusy(false);
    }
  }, [onSaved, row.kind]);

  return (
    <div className="space-y-2">
      <div>
        <label className="block text-xs font-medium text-foreground mb-1">
          {t('providerSetup.apiKey')} {row.stored && <span className="text-muted-foreground">{t('providerSetup.keyAlreadySaved')}</span>}
        </label>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
          value={key}
          onChange={(e) => {
            setKey(e.target.value);
            setSaved(false);
          }}
          placeholder={row.stored ? t('providerSetup.pasteNewKey') : t('providerSetup.pasteKey')}
          className={inputClass}
        />
        <p className="mt-1 text-xs text-muted-foreground">{t('providerSetup.whereToFind', { help: row.keyHelp })}</p>
      </div>

      <div>
        <label className="block text-xs font-medium text-foreground mb-1">{t('providerSetup.model')}</label>
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder={row.defaultModel || row.modelMeaning}
          className={inputClass}
          data-testid={`provider-model-${row.kind}`}
        />
        {/* THE LIST NEVER BECOMES A GATE. The text box above stays the source of
            truth and accepts anything, so a model released this morning is usable
            this morning even if the cached list has never heard of it. The picker
            just spares the user from knowing an id by heart. */}
        {row.kind === GOOGLE_KIND && (
          <div className="mt-1 flex items-center gap-2">
            <select
              value={models?.includes(model) ? model : ''}
              onChange={(e) => {
                if (e.target.value) setModel(e.target.value);
              }}
              disabled={!models || models.length === 0}
              className={`${inputClass} flex-1 disabled:opacity-50`}
              data-testid="provider-model-list"
            >
              <option value="">{t('providerSetup.modelChoose')}</option>
              {(models ?? []).map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void loadModels(true)}
              disabled={modelsBusy}
              className="shrink-0 px-2 py-1.5 text-xs rounded border border-border text-muted-foreground hover:text-foreground disabled:opacity-40"
              data-testid="provider-model-refresh"
            >
              {modelsBusy ? t('providerSetup.modelRefreshing') : t('providerSetup.modelRefresh')}
            </button>
          </div>
        )}
        {modelsNote && <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">{modelsNote}</p>}
        <p className="mt-1 text-xs text-muted-foreground">{row.modelMeaning}</p>
      </div>

      {/* Rendered from configFields — Azure's resource/deployment/apiVersion and
          Bedrock's region come from the registry, not from a switch here. */}
      {row.configFields.map((field) => (
        <div key={field}>
          <label className="block text-xs font-medium text-foreground mb-1">{field}</label>
          <input
            value={config[field] ?? ''}
            onChange={(e) => setConfig((prev) => ({ ...prev, [field]: e.target.value }))}
            placeholder={CONFIG_PLACEHOLDERS[field] ?? ''}
            className={inputClass}
          />
        </div>
      ))}

      {insecureWarning && (
        <div className="border-l-2 border-amber-500/60 pl-2.5 space-y-2">
          <p className="text-xs text-amber-600 dark:text-amber-400">⚠ {insecureWarning}</p>
          <button
            onClick={() => void save(true)}
            disabled={busy}
            className="px-2 py-1 text-xs rounded border border-amber-500/60 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20"
          >
            {t('providerSetup.saveAnyway')}
          </button>
        </div>
      )}

      {error && <p className="text-xs text-red-500">{error}</p>}

      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={() => void save(false)}
          disabled={!canSave || busy}
          className="px-3 py-1.5 text-xs font-medium rounded bg-brand text-white disabled:opacity-40"
        >
          {busy ? t('providerSetup.saving') : t('providerSetup.save')}
        </button>
        {row.stored && (
          <button
            onClick={() => void clear()}
            disabled={busy}
            className="px-3 py-1.5 text-xs rounded border border-border text-muted-foreground hover:text-foreground"
          >
            {t('providerSetup.removeKey')}
          </button>
        )}
        {saved && <span className="text-xs text-green-600 dark:text-green-400">{t('providerSetup.saved')}</span>}
        {missing.length > 0 && (
          <span className="text-xs text-muted-foreground">{t('providerSetup.stillNeeds', { fields: missing.join(', ') })}</span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Insecure-backend banner — the design §4.1 warning, in the UI.
// ---------------------------------------------------------------------------

function SecurityBanner({ security }: { security: Security }) {
  const { t } = useTranslation();
  if (security.secure) return null;
  return (
    // A LEFT ACCENT rather than a box. This banner renders in two places — the
    // settings section and the onboarding card — and inside the card a bordered,
    // tinted rectangle was a box within a box. The amber edge plus amber text
    // still reads as a warning wherever it lands.
    <div className="border-l-2 border-amber-500/60 pl-2.5">
      <p className="text-xs text-amber-600 dark:text-amber-400">
        ⚠ {t('providerSetup.insecurePre')}
        <code>{security.backend}</code>{t('providerSetup.insecurePost')}{security.warning ? ` ${security.warning}` : ''}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings section — "AI provider": WHICH MODEL ANSWERS, AND WITH WHOSE KEY.
// ---------------------------------------------------------------------------
//
// THE MCP HALF LEFT THIS SECTION (settings-ia-reorg §3.4). It used to render the
// System MCP presets and the general MCP list below the key accordion, which put
// four unrelated decisions — engine, keys, in-house servers, arbitrary servers —
// behind one nav row. `NabyMcpServers` is unchanged and now renders under the
// Connections tab instead; nothing about either was rewritten, only where they
// are mounted. The onboarding wizard below is untouched: it still reaches
// `SystemMcpForm` / `SecurityBanner` directly, because it is not a settings tab.

export function NabyProviderSettings({ isOpen }: { isOpen: boolean }) {
  const { t } = useTranslation();
  const { data, unavailable, reload } = useProviders(isOpen);
  const [expanded, setExpanded] = useState<string | null>(null);
  /**
   * SAVING A KEY IS A CHANGE TO THE LIST ABOVE IT, not just to the accordion row
   * the user is looking at.
   *
   * The key list and "which model answers" are two components reading two
   * sources (the preload bridge and /api/naby), and only the first one was being
   * re-read after a save — so a user who saved a Gemini key with Settings still
   * open saw "key saved" on the row and NOTHING new in the selector above it, and
   * reasonably concluded the key had not taken. (The chat header's own switcher
   * has always refreshed, because it polls; that difference is what made this
   * read as "it only fails in Settings".)
   *
   * A counter rather than a shared reload function: the selector owns its own
   * fetch and its own state, and this is a SIGNAL that something it depends on
   * changed. No polling is added — a save is an unambiguous event, and asking on
   * a timer for something that happens twice a year is the wrong trade.
   */
  const [savedTick, setSavedTick] = useState(0);
  const onSaved = useCallback(() => {
    void reload();
    setSavedTick((n) => n + 1);
  }, [reload]);

  if (unavailable) {
    return (
      <div className="space-y-4">
        <p className="text-xs text-muted-foreground">
          {t('providerSetup.browserManaged')}
        </p>
        {/* Engine choice is runtime state, not keychain state, so it works here
            even without the desktop bridge. */}
        <NabyEngineSelector isOpen={isOpen} refreshToken={savedTick} />
      </div>
    );
  }
  if (!data) return <p className="text-xs text-muted-foreground">{t('providerSetup.loading')}</p>;

  return (
    <div className="space-y-2">
      <SecurityBanner security={data.security} />
      <NabyEngineSelector isOpen={isOpen} refreshToken={savedTick} />
      {/* The ChatGPT (subscription) engine appears inside the selector above,
          exactly like Claude (subscription). Account sign in / out lives in the
          session bottom bar, so there is no account UI here. The paste-a-key
          list below deliberately excludes it — it is an OAuth sign-in, not a key. */}
      <p className="text-xs font-medium text-foreground pt-2">{t('providerSetup.apiKeys')}</p>
      {data.providers
        .filter((row) => row.kind !== CHATGPT_OAUTH_KIND)
        .map((row) => (
        <div key={row.kind} className="border border-border rounded">
          <button
            onClick={() => setExpanded(expanded === row.kind ? null : row.kind)}
            className="w-full flex items-center justify-between px-2 py-2 text-left hover:bg-accent/50"
          >
            <span className="text-sm text-foreground">{row.label}</span>
            <span className="text-xs">
              {row.stored ? (
                <span className="text-green-600 dark:text-green-400">{t('providerSetup.keySaved')}</span>
              ) : (
                <span className="text-muted-foreground">{t('providerSetup.notConfigured')}</span>
              )}
            </span>
          </button>
          {expanded === row.kind && (
            <div className="px-2 pb-2">
              <ProviderForm row={row} onSaved={onSaved} autoFocus />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// F1-06 — first-run wizard
// ---------------------------------------------------------------------------

/**
 * Shown INSTEAD OF the chat when no provider has a key.
 *
 * "Onboarded" is inferred from "a key exists" rather than from a sticky flag,
 * so a user who removes their last key is walked through setup again instead of
 * landing in a chat that cannot answer. The explicit flag exists only to record
 * a deliberate skip, which is why "Skip for now" is the one path that sets it.
 *
 * The wizard is not a dead end in either direction: it can be skipped, and it is
 * re-enterable from Settings → AI provider at any time.
 */
export function NabyOnboardingWizard() {
  const { t } = useTranslation();
  const [needed, setNeeded] = useState(false);
  const [checked, setChecked] = useState(false);
  const { data, reload } = useProviders(needed);
  const [choice, setChoice] = useState<string | null>(null);
  // WHICH STEP THE WIZARD IS ON (skill-hub-builtin §2.3). The provider step
  // resolves in two ways — a key was saved, or the user chose to skip it — and
  // BOTH land here rather than closing the wizard, because the in-house servers
  // are the same one-paste setup and asking for them now costs the user nothing.
  const [step, setStep] = useState<'provider' | 'systemMcp'>('provider');
  const [systemMcp, setSystemMcp] = useState<Record<string, SystemMcpStatus>>({});
  // Which presets answered a live connect. Presence, not a count of all of them:
  // each preset is independently connectable and NONE of them is required.
  const [connected, setConnected] = useState<string[]>([]);

  const refreshState = useCallback(async () => {
    const api = bridge();
    if (!api) {
      setChecked(true);
      return;
    }
    const res = await api.onboarding.state();
    if (res.ok) setNeeded(!res.value.onboarded);
    setChecked(true);
  }, []);

  useEffect(() => {
    void refreshState();
  }, [refreshState]);

  const reloadSystemMcp = useCallback(async () => {
    const state = await nabyGet();
    setSystemMcp(state?.systemMcp ?? {});
  }, []);

  useEffect(() => {
    // Read the presets' state when the step opens, so a user who already
    // connected one (or an agent that proposed it) sees the truth rather than a
    // blank form.
    if (step === 'systemMcp') void reloadSystemMcp();
  }, [step, reloadSystemMcp]);

  const selected = useMemo(
    () => data?.providers.find((p) => p.kind === choice) ?? null,
    [choice, data],
  );

  // Outside the desktop app, or already set up: render nothing at all. The
  // System MCP step lives INSIDE this same guard — it is a step of the wizard,
  // not a second overlay that could appear on its own in a browser.
  if (!checked || !needed) return null;

  /** Finish onboarding. EXACTLY what "Skip for now" did before this step
   *  existed: mark it done and close. No preset is a completion condition. */
  const finish = async () => {
    await bridge()?.onboarding.complete();
    setNeeded(false);
  };

  if (step === 'systemMcp') {
    return (
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-background">
        <div className="w-full max-w-lg mx-4 rounded-lg border border-border bg-card p-5 space-y-4">
          <div>
            <h1 className="text-lg font-medium text-foreground">{t('systemMcp.onboardingTitle')}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t('systemMcp.onboardingBody')}</p>
          </div>

          {/* Stacked, and INDEPENDENT: a user with a hub token but no Atlassian
              account connects one and leaves the other alone. */}
          {SYSTEM_MCP_PRESETS.map((preset, index) => (
            <div key={preset.name} className="space-y-1.5">
              <p className="text-xs font-medium text-foreground">{t(preset.titleKey)}</p>
              <p className="text-xs text-muted-foreground">{t(preset.descriptionKey)}</p>
              <SystemMcpForm
                preset={preset}
                state={systemMcp[preset.name] ?? { configured: false }}
                variant="wizard"
                autoFocus={index === 0}
                onChanged={() => void reloadSystemMcp()}
                onConnected={() =>
                  setConnected((prev) =>
                    prev.includes(preset.name) ? prev : [...prev, preset.name],
                  )
                }
              />
            </div>
          ))}

          <div className="flex items-center justify-between pt-1 border-t border-border">
            <button
              onClick={() => void finish()}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              {t('systemMcp.later')}
            </button>
            {connected.length === 0 ? (
              <span className="text-xs text-muted-foreground">{t('systemMcp.changeLater')}</span>
            ) : (
              // A live connect happened: the form is already showing the tool
              // count, so this is the door out rather than another message.
              <button
                onClick={() => void finish()}
                className="px-3 py-1.5 text-xs font-medium rounded bg-brand text-white"
              >
                {t('common.done')}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-background">
      <div className="w-full max-w-lg mx-4 rounded-lg border border-border bg-card p-5 space-y-4">
        <div>
          <h1 className="text-lg font-medium text-foreground">{t('providerSetup.welcome')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('providerSetup.welcomeBody')}
          </p>
        </div>

        {data && <SecurityBanner security={data.security} />}

        {!selected && (
          <div className="space-y-1">
            {/* The dev-only ChatGPT subscription provider is not a paste-a-key
                onboarding choice; it is set up from Settings → its sign-in card. */}
            {(data?.providers ?? [])
              .filter((row) => row.kind !== CHATGPT_OAUTH_KIND)
              .map((row) => (
              <button
                key={row.kind}
                onClick={() => setChoice(row.kind)}
                className="w-full flex items-center justify-between px-3 py-2 rounded border border-border hover:border-brand hover:bg-brand/5 text-left"
              >
                <span className="text-sm text-foreground">{row.label}</span>
                {row.stored && (
                  <span className="text-xs text-green-600 dark:text-green-400">{t('providerSetup.keySaved')}</span>
                )}
              </button>
            ))}
            {!data && <p className="text-xs text-muted-foreground">{t('providerSetup.loadingProviders')}</p>}
          </div>
        )}

        {selected && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-foreground">{selected.label}</span>
              <button
                onClick={() => setChoice(null)}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                {t('providerSetup.chooseDifferent')}
              </button>
            </div>
            <ProviderForm
              row={selected}
              autoFocus
              onSaved={() => {
                // Reloading first means "did that actually store a key" is
                // answered by the vault, not assumed from a click. Note what is
                // NOT called: `refreshState`, which would see the new key, flip
                // `needed` to false and unmount the wizard mid-flow. The state is
                // re-read when the last step finishes instead.
                void reload().then(() => setStep('systemMcp'));
              }}
            />
          </div>
        )}

        <div className="flex items-center justify-between pt-1 border-t border-border">
          <button
            onClick={() => setStep('systemMcp')}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            {t('providerSetup.skipForNow')}
          </button>
          <span className="text-xs text-muted-foreground">
            {t('providerSetup.changeLater')}
          </span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// F1-08 — which engine/provider answers
// ---------------------------------------------------------------------------
//
// THIS TALKS TO /api/naby, NOT TO THE PRELOAD BRIDGE, and the split is by
// sensitivity rather than convenience: keys go over IPC to the Electron main
// process because they are secrets; "which provider should answer" is ordinary
// runtime state owned by the Next server, and widening the preload bridge for
// non-secret data would enlarge the one surface F1-04 deliberately kept narrow.
//
// The dev-engine option is only OFFERED when `devEngineAvailable` says the
// Agent SDK actually resolves. In a packaged build it never does (design §3.3
// — electron-builder excludes it), so a shipped app simply does not show a
// choice that could not work.

/** One copy-paste install command, as the runtime computed it. `id` is a stable
 *  route name (never English shown to a user): the label comes from i18n. */
type ClaudeInstallCommand = { id: string; command: string };

/** How to install Claude Code on THIS machine — the official setup page as data
 *  (see `claudeInstallHelp` in the runtime). The UI renders it; it never picks
 *  commands of its own, because a second copy of these strings is a second place
 *  for them to go stale. */
type ClaudeInstallHelp = {
  platform: string;
  docsUrl: string;
  recommended: ClaudeInstallCommand;
  alternatives: ClaudeInstallCommand[];
  /** Facts to read BEFORE running anything, as ids the UI translates. */
  notes: string[];
};

/** The subset of `/api/naby`'s `claudeLogin` block this screen needs: whether a
 *  `claude` executable exists at all, and what to do when it does not. */
type ClaudeLoginBlock = {
  status: string;
  cliFound: boolean;
  relevant: boolean;
  installHelp: ClaudeInstallHelp | null;
};

type NabyEngineState = {
  engine: { ok: boolean; id?: string; costBasis?: string; summary: string };
  settings: { enginePreference?: string; selectedProvider?: string };
  devEngineAvailable: boolean;
  /** The LOCAL Claude sign-in the Claude (subscription) engine answers on. Absent
   *  from an older server, which reads as "nothing to say" rather than a crash. */
  claudeLogin?: ClaudeLoginBlock;
  providers: { id: string; label: string; model: string; ready: boolean }[];
  mcp: McpRow[];
  /** Every built-in System MCP preset's connection state, keyed by preset name.
   *  Computed server-side by `readSystemMcpStatus` — this UI never re-derives it
   *  from the `mcp` list, because two answers to "is this connected" is how a row
   *  ends up disagreeing with the list under it. */
  systemMcp?: Record<string, SystemMcpStatus>;
};

/**
 * Read the runtime's state.
 *
 * `recheckLogin` is the EXISTING re-check path (`readNabyState`'s one option),
 * not a new endpoint: it bypasses the runtime's 10s `claude auth status` cache
 * so a user who has just installed the CLI is not shown a stale "not found" for
 * another ten seconds. Ordinary reads must NOT set it — that cache is what keeps
 * a settings screen from spawning a process per poll.
 */
async function nabyGet(recheckLogin = false): Promise<NabyEngineState | null> {
  try {
    const res = await fetch(`/api/naby${recheckLogin ? '?recheckLogin=1' : ''}`);
    if (!res.ok) return null;
    return (await res.json()) as NabyEngineState;
  } catch {
    return null;
  }
}

type NabyPostResult = {
  ok: boolean;
  error?: string;
  /** An i18n key the server offers for a refusal it knows how to phrase (a
   *  missing preset field, a bad email, a missing uvx). Preferred over `error`,
   *  which stays the English truth for logs. */
  errorKey?: string;
  /** The field id `errorKey` is about, so the caller can name it with the field's
   *  own translated label. */
  errorField?: string;
  message?: string;
  toolCount?: number;
  /** `models.list`: the live model catalog for the provider that was asked for.
   *  Model IDS ONLY — the key that fetched them stays in the server. */
  models?: { claude?: unknown[]; google?: string[]; fetchedAt?: number; cached?: boolean };
};

async function nabyPost(body: unknown): Promise<NabyPostResult> {
  try {
    const res = await fetch('/api/naby', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as NabyPostResult | null;
    if (!res.ok) {
      return {
        ok: false,
        error: json?.error ?? `request failed (${res.status})`,
        ...(json?.errorKey ? { errorKey: json.errorKey } : {}),
        ...(json?.errorField ? { errorField: json.errorField } : {}),
      };
    }
    return {
      ok: true,
      ...(json?.message ? { message: json.message } : {}),
      // `systemMcp.test` answers with a COUNT rather than a sentence, so the two
      // surfaces that show it can phrase it in the user's own language.
      ...(typeof json?.toolCount === 'number' ? { toolCount: json.toolCount } : {}),
      ...(json?.models ? { models: json.models } : {}),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Claude (subscription) with no CLI on the machine
// ---------------------------------------------------------------------------
//
// The Claude (subscription) engine answers on the Claude Code sign-in that lives
// on this computer, so a machine with no `claude` executable cannot use it — and
// the app used to say so and stop, which leaves the reader holding a problem and
// no next step. (On Windows it was worse: the app could say this to someone who
// HAD installed it, because the known-location probe never looked for
// `claude.exe`. That is fixed in the runtime; this card is what the honest
// "really not installed" case deserves.)
//
// WHAT IS HERE: what is missing and why it matters, a link to the official setup
// page, the command for THIS platform with a copy button, the other routes, the
// two caveats worth knowing before starting — and "Check again", because the
// install happens outside the app and the app must be able to notice.
//
// WHAT IS DELIBERATELY NOT HERE: a button that installs it. Running an installer
// on the user's behalf is a different decision with a different blast radius,
// and it is not this change.
//
// The commands are NOT written here. They come from the runtime's
// `claudeInstallHelp`, whose ids are mapped to translated labels below — so a
// change to the official instructions is a runtime change, and this file cannot
// disagree with it.

/** id → i18n key. An id with no entry falls back to the raw id, so a route added
 *  in the runtime shows up (unlabelled) rather than vanishing from the list. */
const INSTALL_COMMAND_LABELS: Record<string, string> = {
  'windows-powershell': 'claudeInstall.routePowershell',
  'windows-cmd': 'claudeInstall.routeCmd',
  'windows-winget': 'claudeInstall.routeWinget',
  'unix-native': 'claudeInstall.routeNativeScript',
  'macos-homebrew': 'claudeInstall.routeHomebrew',
  npm: 'claudeInstall.routeNpm',
};

const INSTALL_NOTES: Record<string, string> = {
  'no-admin-required': 'claudeInstall.noteNoAdmin',
  'paid-plan-required': 'claudeInstall.notePaidPlan',
};

/** One command: what it is, the command itself, and a copy button. A command a
 *  user has to select by hand is a command that gets copied with half a word
 *  missing. */
function InstallCommandRow({ entry }: { entry: ClaudeInstallCommand }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(entry.command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard denied: the command is shown in full beside the button, so it
      // can still be selected by hand.
    }
  }, [entry.command]);

  const labelKey = INSTALL_COMMAND_LABELS[entry.id];

  return (
    <div className="space-y-1" data-testid={`claude-install-command-${entry.id}`}>
      <p className="text-xs text-muted-foreground">{labelKey ? t(labelKey) : entry.id}</p>
      <div className="flex items-center gap-1">
        <code className="flex-1 px-2 py-1 rounded bg-secondary text-foreground text-xs break-all">
          {entry.command}
        </code>
        <button
          type="button"
          onClick={() => void copy()}
          className="shrink-0 px-2 py-1 text-xs rounded border border-border text-muted-foreground hover:text-foreground"
          data-testid={`claude-install-copy-${entry.id}`}
        >
          {copied ? t('claudeInstall.copied') : t('claudeInstall.copy')}
        </button>
      </div>
    </div>
  );
}

function ClaudeCliMissingCard({
  help,
  onRecheck,
  rechecking,
}: {
  help: ClaudeInstallHelp;
  onRecheck: () => void;
  rechecking: boolean;
}) {
  const { t } = useTranslation();
  return (
    // The same left-accent amber treatment the insecure-storage banner uses:
    // this is advice about something the user has to go and do, not a failure.
    <div className="border-l-2 border-amber-500/60 pl-2.5 space-y-2" data-testid="claude-cli-install">
      <p className="text-xs text-amber-600 dark:text-amber-400">⚠ {t('claudeInstall.missing')}</p>
      <p className="text-xs text-muted-foreground">{t('claudeInstall.why')}</p>
      {/* target="_blank" is what electron/boot.ts turns into "open in the OS
          browser" — the docs must not load inside the app shell. */}
      <a
        href={help.docsUrl}
        target="_blank"
        rel="noreferrer"
        className="inline-block text-xs text-brand underline"
        data-testid="claude-install-docs"
      >
        {t('claudeInstall.docsLink')}
      </a>

      <div className="space-y-1">
        <p className="text-xs font-medium text-foreground">{t('claudeInstall.recommended')}</p>
        <InstallCommandRow entry={help.recommended} />
      </div>

      {help.alternatives.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-foreground">{t('claudeInstall.alternatives')}</p>
          {help.alternatives.map((entry) => (
            <InstallCommandRow key={entry.id} entry={entry} />
          ))}
        </div>
      )}

      {help.notes.length > 0 && (
        <ul className="space-y-0.5">
          {help.notes.map((note) => (
            <li key={note} className="text-xs text-muted-foreground">
              · {INSTALL_NOTES[note] ? t(INSTALL_NOTES[note]) : note}
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        onClick={onRecheck}
        disabled={rechecking}
        className="px-2 py-1 text-xs rounded border border-border text-muted-foreground hover:text-foreground disabled:opacity-40"
        data-testid="claude-install-recheck"
      >
        {rechecking ? t('claudeInstall.rechecking') : t('claudeInstall.recheck')}
      </button>
    </div>
  );
}

export function NabyEngineSelector({
  isOpen,
  /** Bump to re-read /api/naby. The parent raises it when a KEY IS SAVED OR
   *  REMOVED — a change this component cannot observe on its own, because keys
   *  live behind the preload bridge and this list comes from the server. Without
   *  it, saving a key while Settings is open left this list showing the state
   *  from before the save (see NabyProviderSettings). */
  refreshToken = 0,
}: {
  isOpen: boolean;
  refreshToken?: number;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<NabyEngineState | null>(null);
  const [busy, setBusy] = useState(false);
  const [recheckingCli, setRecheckingCli] = useState(false);

  const reload = useCallback(async () => {
    setState(await nabyGet());
  }, []);

  /** "Check again" after installing the CLI outside the app. It re-reads THIS
   *  state with the login cache bypassed — the existing `recheckLogin` path —
   *  rather than adding an endpoint for a question the GET already answers. */
  const recheckCli = useCallback(async () => {
    setRecheckingCli(true);
    try {
      const fresh = await nabyGet(true);
      // A failed re-check keeps the last known answer rather than blanking the
      // whole section: the card is advice, and losing it mid-install helps
      // nobody.
      if (fresh) setState(fresh);
    } finally {
      setRecheckingCli(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) void reload();
  }, [isOpen, reload, refreshToken]);

  const choose = useCallback(
    async (enginePreference: string, selectedProvider: string) => {
      setBusy(true);
      try {
        await nabyPost({ action: 'settings.set', enginePreference, selectedProvider });
        await reload();
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

  if (!state) return null;

  const pref = state.settings.enginePreference ?? '';
  const selectedProvider = state.settings.selectedProvider ?? '';

  // "Automatic" is first and is the default, because it is right for almost
  // everyone: a configured provider answers, and if none is configured the
  // Claude subscription engine picks up the slack rather than the app being
  // unusable.
  const options: { id: string; label: string; hint: string; onPick: () => void; active: boolean }[] =
    [
      {
        id: 'auto',
        label: t('providerSetup.automatic'),
        hint: t('providerSetup.automaticHint'),
        onPick: () => void choose('', ''),
        active: pref === '' && selectedProvider === '',
      },
    ];

  if (state.devEngineAvailable) {
    // A first-class default provider, not a "development-only" fallback: it runs
    // on the local Claude sign-in (Agent SDK) and adds no per-message charge.
    options.push({
      id: 'dev-claude',
      label: t('providerSetup.claudeSubscription'),
      hint: t('providerSetup.claudeSubscriptionHint'),
      onPick: () => void choose('dev-claude', ''),
      active: pref === 'dev-claude',
    });
  }

  for (const p of state.providers) {
    if (p.id === CHATGPT_OAUTH_KIND) {
      // The DEV-ONLY ChatGPT subscription is a subscription engine, mirrored on
      // Claude (subscription) above: a plain selectable "which model answers"
      // row, NOT a metered "billed" key. It appears only because the server
      // included it in `providers` (dev seal open); a shipped build never does.
      // Selecting it is enough here — sign in / out happens in the session
      // bottom bar (ChatgptLoginStatus), exactly as Claude's does.
      options.push({
        id: p.id,
        label: t('chatgptOauth.title'),
        hint: t('providerSetup.chatgptSubscriptionHint'),
        onPick: () => void choose('ai-sdk', p.id),
        active: pref === 'ai-sdk' && selectedProvider === p.id,
      });
      continue;
    }
    options.push({
      id: p.id,
      label: p.label,
      hint: p.ready
        ? t('providerSetup.billedHint', { model: p.model, label: p.label })
        : t('providerSetup.noKeyHint', { model: p.model }),
      onPick: () => void choose('ai-sdk', p.id),
      active: pref === 'ai-sdk' && selectedProvider === p.id,
    });
  }

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-foreground">{t('providerSetup.whichModel')}</p>
      <div className="space-y-1">
        {options.map((o) => (
          <button
            key={o.id}
            onClick={o.onPick}
            disabled={busy}
            className={`w-full text-left px-2 py-1.5 rounded border transition-colors ${
              o.active
                ? 'border-brand bg-brand/5'
                : 'border-border hover:border-brand/50 hover:bg-accent/40'
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="text-sm text-foreground">{o.label}</span>
              {o.active && <span className="text-xs text-brand">{t('providerSetup.selected')}</span>}
            </div>
            <p className="text-xs text-muted-foreground">{o.hint}</p>
          </button>
        ))}
      </div>
      {/* Claude (subscription) is offered above but the CLI it signs in with is
          not on this computer: say so HERE, next to the choice, and say how to
          fix it. `installHelp` is present only when the runtime found no
          executable, so this cannot appear for a machine that merely needs to
          sign in — that is the chip's job in the session bar. */}
      {state.devEngineAvailable && state.claudeLogin?.installHelp && (
        <ClaudeCliMissingCard
          help={state.claudeLogin.installHelp}
          onRecheck={() => void recheckCli()}
          rechecking={recheckingCli}
        />
      )}
      {/* The runtime's own sentence about what will actually happen — kept as
          the single source of truth rather than re-derived in the UI. */}
      <p className={`text-xs ${state.engine.ok ? 'text-muted-foreground' : 'text-amber-500'}`}>
        {state.engine.summary}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// F1-08 — MCP server CRUD
// ---------------------------------------------------------------------------
//
// The registry is PROVIDER-INDEPENDENT (contract §5): these servers are the same
// whichever model was chosen. That independence is why they now live under
// CONNECTIONS rather than under AI provider (settings-ia-reorg §3.4) — an MCP
// server is a thing this machine is connected to, not a property of the model.
// The component itself is unchanged by the move.
//
// SECRETS: `env` / `headers` values are never sent back by the API — only their
// KEY NAMES (see redactEntry in api/naby.ts). So this form can add them but
// cannot display them, exactly like the API-key field above.
//
// "Test" connects and lists tools. It deliberately does not CALL a tool:
// connecting is safe, invoking is the thing the gate exists to mediate.

type McpRow = {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  timeoutMs?: number;
  envKeys?: string[];
  headerKeys?: string[];
  /** 'proposed' = added by the chat agent, awaiting the user's approval before it
   *  runs; absent/'enabled' = active. */
  status?: 'enabled' | 'proposed';
};

/** Parse a "Key<sep>Value" textarea (one per line) into a record; blank/keyless
 *  lines are skipped. Used for headers (":") and env ("="). */
function parseKeyVals(text: string, sep: ':' | '='): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const i = line.indexOf(sep);
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (k) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

function McpAddForm({
  onAdded,
  onCancel,
  initial,
}: {
  onAdded: () => void;
  onCancel?: () => void;
  /** When present the form EDITS this server (upsert replaces by name). Secret
   *  VALUES are redacted server-side, so the header/env textarea is pre-seeded
   *  with the KEY names only (blank values) — the user re-enters any secret. */
  initial?: McpRow;
}) {
  const { t } = useTranslation();
  const [transport, setTransport] = useState<'stdio' | 'http' | 'sse'>(initial?.transport ?? 'stdio');
  const [name, setName] = useState(initial?.name ?? '');
  const [command, setCommand] = useState(initial?.command ?? '');
  const [args, setArgs] = useState((initial?.args ?? []).join(' '));
  const [url, setUrl] = useState(initial?.url ?? '');
  // Seed secret editors with the known KEY names so the user sees what to fill;
  // values are never returned by the server, so they start blank.
  const [headersText, setHeadersText] = useState(
    (initial?.headerKeys ?? []).map((k) => `${k}: `).join('\n'),
  );
  const [envText, setEnvText] = useState((initial?.envKeys ?? []).map((k) => `${k}=`).join('\n'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editing = !!initial;

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const entry =
        transport === 'stdio'
          ? {
              name: name.trim(),
              transport,
              command: command.trim(),
              // Split on whitespace: the common case is `-y some-package`, and
              // a full shell-quoting parser here would be a lie anyway since
              // the command is spawned without a shell.
              ...(args.trim() ? { args: args.trim().split(/\s+/) } : {}),
              ...(parseKeyVals(envText, '=') ? { env: parseKeyVals(envText, '=') } : {}),
            }
          : {
              name: name.trim(),
              transport,
              url: url.trim(),
              ...(parseKeyVals(headersText, ':') ? { headers: parseKeyVals(headersText, ':') } : {}),
            };
      const res = await nabyPost({ action: 'mcp.upsert', entry });
      if (!res.ok) {
        setError(res.error ?? t('providerSetup.couldNotSave'));
        return;
      }
      setName('');
      setCommand('');
      setArgs('');
      setUrl('');
      setHeadersText('');
      setEnvText('');
      onAdded();
    } finally {
      setBusy(false);
    }
  }, [args, command, name, onAdded, transport, url, headersText, envText, t]);

  const canSave =
    name.trim().length > 0 &&
    (transport === 'stdio' ? command.trim().length > 0 : url.trim().length > 0);

  return (
    <div className="space-y-2 border border-border rounded p-2">
      <div className="flex gap-1">
        {(['stdio', 'http', 'sse'] as const).map((tp) => (
          <button
            key={tp}
            onClick={() => setTransport(tp)}
            className={`px-2 py-1 text-xs rounded border ${
              transport === tp ? 'border-brand text-brand' : 'border-border text-muted-foreground'
            }`}
          >
            {tp}
          </button>
        ))}
      </div>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t('providerSetup.namePlaceholder')}
        // Renaming would create a second entry (upsert is keyed by name), so the
        // name is fixed while editing.
        readOnly={editing}
        className={`${inputClass} ${editing ? 'opacity-60' : ''}`}
      />
      {transport === 'stdio' ? (
        <>
          <input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder={t('providerSetup.commandPlaceholder')}
            className={inputClass}
          />
          <input
            value={args}
            onChange={(e) => setArgs(e.target.value)}
            placeholder={t('providerSetup.argsPlaceholder')}
            className={inputClass}
          />
          <textarea
            value={envText}
            onChange={(e) => setEnvText(e.target.value)}
            placeholder={t('providerSetup.envPlaceholder')}
            rows={2}
            className={`${inputClass} font-mono`}
          />
        </>
      ) : (
        <>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={t('providerSetup.urlPlaceholder')}
            className={inputClass}
          />
          <textarea
            value={headersText}
            onChange={(e) => setHeadersText(e.target.value)}
            placeholder={t('providerSetup.headersPlaceholder')}
            rows={2}
            className={`${inputClass} font-mono`}
          />
        </>
      )}
      {editing && (initial?.headerKeys?.length || initial?.envKeys?.length) ? (
        <p className="text-xs text-amber-600 dark:text-amber-400">{t('providerSetup.secretReentry')}</p>
      ) : null}
      {error && <p className="text-xs text-red-500">{error}</p>}
      <div className="flex items-center gap-2">
        <button
          onClick={() => void submit()}
          disabled={!canSave || busy}
          className="px-3 py-1.5 text-xs font-medium rounded bg-brand text-white disabled:opacity-40"
        >
          {busy
            ? t('providerSetup.saving')
            : editing
              ? t('providerSetup.saveChanges')
              : t('providerSetup.addServer')}
        </button>
        {onCancel && (
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs rounded border border-border text-muted-foreground hover:text-foreground"
          >
            {t('providerSetup.cancel')}
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The built-in System MCP presets (skill-hub-builtin §2.4)
// ---------------------------------------------------------------------------
//
// The general form above asks for a name, a transport, a URL or a command, and a
// `Key: Value` block. For an in-house server every one of those answers is fixed
// and known to the product, so asking for them would be four or five chances to
// mistype a setup that has one or two variables: a token, maybe an email.
//
// ONE COMPONENT, EVERY PRESET. Nothing below names a preset or branches on one —
// it iterates `SYSTEM_MCP_PRESETS` and renders whatever fields a preset declares.
// A third in-house server is a registry entry plus its copy, and this file does
// not change.
//
// SECRETS GO ONE WAY. Values are posted to `systemMcp.set`, which assembles the
// entry server-side; a secret is never returned by any read (redactEntry hands
// back header/env NAMES only), so — exactly like the API-key field at the top of
// this file — a stored secret renders as a status word and never as characters.
// Blank input means "keep what is stored", the same convention as the Telegram
// token, and the merge happens on the server where the stored value actually is.
// A NON-secret field (the Atlassian account email) IS shown back, because
// "connected as who?" is a question the user should not have to guess at.

/** The fields of one preset plus its buttons, shared by the settings row and the
 *  onboarding step. `variant` decides WHICH BUTTONS APPEAR, never what they do:
 *  Connect (save + probe) is identical in both, and the wizard simply has no Test
 *  or Remove, because a first-run user has nothing stored to diagnose or delete. */
function SystemMcpForm({
  preset,
  state,
  variant,
  onChanged,
  onConnected,
  autoFocus,
}: {
  preset: SystemMcpPresetView;
  /** What the server says is stored. `nonSecretFields` seeds the visible inputs. */
  state: SystemMcpStatus;
  variant: 'settings' | 'wizard';
  /** Re-read the server state after a write. */
  onChanged: () => void;
  /** The wizard's success signal — a live connect, with its tool count. */
  onConnected?: (toolCount: number) => void;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation();
  // ONLY WHAT THE USER TYPED. Everything else falls back to the server state on
  // read, so a status that arrives after the first paint fills the visible boxes
  // without overwriting anything already being typed into them.
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);

  const configured = state.configured;
  const proposed = configured && state.status === 'proposed';
  const stored = state.nonSecretFields ?? {};

  /** What a field's box shows: the typed value, else the stored non-secret value,
   *  else nothing. A secret has no stored value to fall back to, by construction. */
  const valueOf = useCallback(
    (field: SystemMcpPresetView['fields'][number]) =>
      typed[field.id] ?? (field.secret ? '' : (stored[field.id] ?? '')),
    [stored, typed],
  );

  /** Any box holding something other than what the server has. Used to disable
   *  Test: probing the stored credentials while the user looks at new ones would
   *  answer a question nobody asked. */
  const dirty = preset.fields.some((f) => {
    const value = typed[f.id];
    if (value === undefined) return false;
    return value.trim() !== (f.secret ? '' : (stored[f.id] ?? '')).trim();
  });

  /** Turn a server refusal into a sentence in the user's language. */
  const failure = useCallback(
    (res: NabyPostResult): string => {
      if (res.errorKey) {
        const field = preset.fields.find((f) => f.id === res.errorField);
        return t(res.errorKey, { field: field ? t(field.labelKey) : res.errorField });
      }
      return t('systemMcp.failed', { error: res.error });
    },
    [preset.fields, t],
  );

  /** Store the typed values. Blank fields are OMITTED rather than sent empty, so
   *  the server keeps what it has — which is the only way an unchanged secret can
   *  survive an edit of the field beside it. */
  const save = useCallback(async (): Promise<boolean> => {
    const fields: Record<string, string> = {};
    for (const field of preset.fields) {
      const value = valueOf(field).trim();
      if (value) fields[field.id] = value;
      else if (!configured) {
        // Nothing stored to fall back on: say which box, in its own words.
        setNote({ text: t('systemMcp.fieldRequired', { field: t(field.labelKey) }), ok: false });
        return false;
      }
    }
    const res = await nabyPost({ action: 'systemMcp.set', preset: preset.name, fields });
    if (!res.ok) {
      setNote({ text: failure(res), ok: false });
      return false;
    }
    // No secret lingers in component state past the save; a non-secret value is
    // dropped too, because the server state now carries it.
    setTyped({});
    onChanged();
    return true;
  }, [configured, failure, onChanged, preset.fields, preset.name, t, valueOf]);

  /** Connect and count the tools — the server's one-shot probe, which lists tools
   *  and calls none of them. */
  const probe = useCallback(async () => {
    const res = await nabyPost({ action: 'systemMcp.test', preset: preset.name });
    if (!res.ok) {
      setNote({ text: failure(res), ok: false });
      return;
    }
    const tools = res.toolCount ?? 0;
    setNote({ text: t('systemMcp.toolCount', { tools }), ok: true });
    onConnected?.(tools);
  }, [failure, onConnected, preset.name, t]);

  /** Save, then immediately connect. "Saved" is not an answer anybody wants: the
   *  question a pasted credential raises is whether it WORKS, and the probe
   *  answers it in one round trip. */
  const connect = useCallback(async () => {
    setBusy(true);
    setNote({ text: t('systemMcp.connecting'), ok: true });
    try {
      if (!(await save())) return;
      await probe();
    } finally {
      setBusy(false);
    }
  }, [probe, save, t]);

  /** Re-connect what is ALREADY STORED — the diagnosis for a server that worked
   *  last month and does not today (an expired token reads as a connect failure,
   *  spec §4). It deliberately saves nothing. */
  const test = useCallback(async () => {
    setBusy(true);
    setNote({ text: t('systemMcp.connecting'), ok: true });
    try {
      await probe();
    } finally {
      setBusy(false);
    }
  }, [probe, t]);

  const remove = useCallback(async () => {
    setBusy(true);
    try {
      await nabyPost({ action: 'systemMcp.remove', preset: preset.name });
      setTyped({});
      setNote(null);
      onChanged();
    } finally {
      setBusy(false);
    }
  }, [onChanged, preset.name]);

  return (
    <div className="space-y-1.5" data-testid={`system-mcp-form-${preset.name}`}>
      {preset.fields.map((field, index) => {
        // A preset can ask for more than one thing (Atlassian wants an email AND
        // a token), and a placeholder disappears the moment the box has content —
        // so the label is a standing line rather than hint text inside the input.
        const id = `system-mcp-${preset.name}-${field.id}`;
        return (
          <div key={field.id} className="space-y-1">
            <label htmlFor={id} className="block text-xs text-muted-foreground">
              {t(field.labelKey)}
            </label>
            <input
              id={id}
              type={field.secret ? 'password' : 'text'}
              autoComplete="off"
              spellCheck={false}
              autoFocus={autoFocus && index === 0}
              value={valueOf(field)}
              onChange={(e) => setTyped((prev) => ({ ...prev, [field.id]: e.target.value }))}
              placeholder={t(field.placeholderKey)}
              className={`${inputClass} ${field.secret ? 'font-mono' : ''}`}
            />
          </div>
        );
      })}
      <div className="flex items-center gap-2">
        <button
          onClick={() => void connect()}
          disabled={busy}
          className="shrink-0 px-3 py-1.5 text-xs font-medium rounded bg-brand text-white disabled:opacity-40"
        >
          {busy ? t('systemMcp.connecting') : t('systemMcp.connect')}
        </button>
        {variant === 'settings' && configured && (
          <>
            <button
              onClick={() => void test()}
              disabled={busy || dirty}
              className="shrink-0 px-2 py-1.5 text-xs rounded border border-border text-muted-foreground hover:text-foreground disabled:opacity-40"
            >
              {t('systemMcp.test')}
            </button>
            <button
              onClick={() => void remove()}
              disabled={busy}
              className="shrink-0 px-2 py-1.5 text-xs rounded border border-border text-muted-foreground hover:text-red-500 disabled:opacity-40"
            >
              {t('systemMcp.remove')}
            </button>
          </>
        )}
      </div>
      {configured && !proposed && preset.fields.some((f) => f.secret) && (
        <p className="text-xs text-muted-foreground">{t('systemMcp.secretKept')}</p>
      )}
      {note && (
        <p className={`text-xs ${note.ok ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>
          {note.text}
        </p>
      )}
    </div>
  );
}

/** One preset's row: name, connection state, description, form, and — when an
 *  agent proposed the same server — the approval the existing HITL path expects.
 *  A single bordered interactive row: the description is plain muted text and the
 *  proposed warning is a left accent, so this adds one frame rather than three. */
function SystemMcpRow({
  preset,
  state,
  onChanged,
}: {
  preset: SystemMcpPresetView;
  state: SystemMcpStatus;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const proposed = state.configured && state.status === 'proposed';

  const approve = useCallback(async () => {
    // The EXISTING HITL path, not a second one: an agent-proposed server is
    // approved exactly like any other agent-proposed server.
    await nabyPost({ action: 'mcp.approve', name: preset.name });
    onChanged();
  }, [onChanged, preset.name]);

  return (
    <div className="space-y-1.5 pt-2" data-testid={`system-mcp-row-${preset.name}`}>
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-foreground">{t(preset.titleKey)}</p>
        <span className="text-xs">
          {proposed ? (
            <span className="text-amber-600 dark:text-amber-400">{t('systemMcp.proposed')}</span>
          ) : state.configured ? (
            <span className="text-green-600 dark:text-green-400">{t('systemMcp.connected')}</span>
          ) : (
            <span className="text-muted-foreground">{t('systemMcp.notConfigured')}</span>
          )}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">{t(preset.descriptionKey)}</p>
      <div className="border border-border rounded px-2 py-2">
        <SystemMcpForm preset={preset} state={state} variant="settings" onChanged={onChanged} />
      </div>
      {proposed && (
        <div className="border-l-2 border-amber-500/60 pl-2.5 space-y-1.5">
          <p className="text-xs text-amber-600 dark:text-amber-400">{t('systemMcp.proposedHint')}</p>
          <button
            onClick={() => void approve()}
            className="px-2 py-1 text-xs rounded border border-amber-500/60 text-amber-700 dark:text-amber-300 hover:bg-amber-500/10"
          >
            {t('systemMcp.approve')}
          </button>
        </div>
      )}
    </div>
  );
}

/** The System MCP subsection: one row per preset, above the user-added list. */
function NabySystemMcpSection({
  status,
  onChanged,
}: {
  status: Record<string, SystemMcpStatus>;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1.5" data-testid="system-mcp-section">
      <p className="text-xs font-medium text-foreground">{t('systemMcp.title')}</p>
      {/* ONE sentence: what these are and what is asked of you. What is handled
          for you, and the fact that their tools are gated like any other, is
          reassurance rather than instruction — it changes nothing the reader has
          to do — so it waits below. */}
      <p className="text-xs text-muted-foreground">{t('systemMcp.description')}</p>
      {SYSTEM_MCP_PRESETS.map((preset) => (
        <SystemMcpRow
          key={preset.name}
          preset={preset}
          // A preset the server has not answered for yet reads as not configured
          // rather than as a blank row.
          state={status[preset.name] ?? { configured: false }}
          onChanged={onChanged}
        />
      ))}
      <SettingsDetails>
        <p>{t('systemMcp.detailsNote')}</p>
      </SettingsDetails>
    </div>
  );
}

export function NabyMcpServers({ isOpen }: { isOpen: boolean }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<McpRow[] | null>(null);
  const [systemMcp, setSystemMcp] = useState<Record<string, SystemMcpStatus>>({});
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<McpRow | null>(null);
  const [status, setStatus] = useState<Record<string, { text: string; ok: boolean }>>({});

  const reload = useCallback(async () => {
    const state = await nabyGet();
    // Each preset has its own row above, so its entry is filtered out of the
    // general list rather than shown twice — once with the URL/command and secret
    // block the preset exists to hide, and once without.
    setRows((state?.mcp ?? []).filter((r) => !SYSTEM_MCP_PRESET_NAMES.includes(r.name)));
    setSystemMcp(state?.systemMcp ?? {});
  }, []);

  useEffect(() => {
    if (isOpen) void reload();
  }, [isOpen, reload]);

  const test = useCallback(async (serverName: string) => {
    setStatus((prev) => ({ ...prev, [serverName]: { text: t('providerSetup.connecting'), ok: true } }));
    const res = await nabyPost({ action: 'mcp.test', name: serverName });
    setStatus((prev) => ({
      ...prev,
      [serverName]: res.ok
        ? { text: res.message ?? t('providerSetup.connected'), ok: true }
        : { text: t('providerSetup.failed', { error: res.error }), ok: false },
    }));
  }, [t]);

  const remove = useCallback(
    async (serverName: string) => {
      await nabyPost({ action: 'mcp.remove', name: serverName });
      await reload();
    },
    [reload],
  );

  const approve = useCallback(
    async (serverName: string) => {
      await nabyPost({ action: 'mcp.approve', name: serverName });
      await reload();
    },
    [reload],
  );

  if (!rows) return null;

  return (
    <div className="space-y-2 pt-2">
      {/* The presets come first: they are the MCP servers most users will ever
          connect, and they need no knowledge of what an MCP server is. */}
      <NabySystemMcpSection status={systemMcp} onChanged={() => void reload()} />

      <div className="flex items-center justify-between pt-2">
        <p className="text-xs font-medium text-foreground">{t('providerSetup.mcpServers')}</p>
        <button
          onClick={() => setAdding((v) => !v)}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          {adding ? t('providerSetup.cancel') : t('providerSetup.add')}
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        {t('providerSetup.mcpDescription')}
      </p>

      {adding && !editing && (
        <McpAddForm
          onAdded={() => {
            setAdding(false);
            void reload();
          }}
          onCancel={() => setAdding(false)}
        />
      )}

      {editing && (
        <McpAddForm
          initial={editing}
          onAdded={() => {
            setEditing(null);
            void reload();
          }}
          onCancel={() => setEditing(null)}
        />
      )}

      {rows.length === 0 && !adding && (
        <p className="text-xs text-muted-foreground">{t('providerSetup.noMcpServers')}</p>
      )}

      {rows.map((row) => (
        <div
          key={row.name}
          className={`rounded px-2 py-1.5 border ${
            row.status === 'proposed'
              ? 'border-amber-500/60 border-dashed bg-amber-500/5'
              : 'border-border'
          }`}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm text-foreground truncate flex items-center gap-1.5">
                {row.name}
                {row.status === 'proposed' && (
                  <span className="shrink-0 text-[0.714rem] uppercase tracking-wide text-amber-600 dark:text-amber-400 border border-amber-500/50 rounded px-1 py-px">
                    {t('providerSetup.mcpProposed')}
                  </span>
                )}
              </p>
              <p className="text-xs text-muted-foreground truncate">
                {row.transport === 'stdio'
                  ? `${row.command ?? ''} ${(row.args ?? []).join(' ')}`.trim()
                  : (row.url ?? '')}
              </p>
              {(row.envKeys?.length || row.headerKeys?.length) && (
                <p className="text-xs text-muted-foreground">
                  {row.envKeys?.length ? `env: ${row.envKeys.join(', ')}` : ''}
                  {row.headerKeys?.length ? `headers: ${row.headerKeys.join(', ')}` : ''}
                  {t('providerSetup.valuesHidden')}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {row.status === 'proposed' && (
                <button
                  onClick={() => void approve(row.name)}
                  className="px-2 py-1 text-xs rounded border border-amber-500/60 text-amber-700 dark:text-amber-300 hover:bg-amber-500/10"
                >
                  {t('providerSetup.mcpApprove')}
                </button>
              )}
              <button
                onClick={() => void test(row.name)}
                className="px-2 py-1 text-xs rounded border border-border text-muted-foreground hover:text-foreground"
              >
                {t('providerSetup.test')}
              </button>
              <button
                onClick={() => {
                  setAdding(false);
                  setEditing(row);
                }}
                className="px-2 py-1 text-xs rounded border border-border text-muted-foreground hover:text-foreground"
              >
                {t('providerSetup.edit')}
              </button>
              <button
                onClick={() => void remove(row.name)}
                className="px-2 py-1 text-xs rounded border border-border text-muted-foreground hover:text-red-500"
              >
                {row.status === 'proposed' ? t('providerSetup.mcpReject') : t('providerSetup.remove')}
              </button>
            </div>
          </div>
          {row.status === 'proposed' && (
            <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
              {t('providerSetup.mcpProposedHint')}
            </p>
          )}
          {status[row.name] && (
            <p
              className={`mt-1 text-xs ${
                status[row.name]?.ok ? 'text-green-600 dark:text-green-400' : 'text-red-500'
              }`}
            >
              {status[row.name]?.text}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
