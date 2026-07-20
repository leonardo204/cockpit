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

/** Azure's apiVersion is the one config field with a sane default to offer. */
const CONFIG_PLACEHOLDERS: Record<string, string> = {
  region: 'us-east-1',
  resource: 'my-azure-resource',
  deployment: 'my-deployment-name',
  apiVersion: '2024-10-21',
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

  const missing = row.configFields.filter((f) => !config[f]?.trim());
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
      } finally {
        setBusy(false);
      }
    },
    [config, key, model, onSaved, row.kind, row.label],
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
          API key {row.stored && <span className="text-muted-foreground">— a key is already saved</span>}
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
          placeholder={row.stored ? 'Paste a new key to replace the saved one' : 'Paste your API key'}
          className={inputClass}
        />
        <p className="mt-1 text-xs text-muted-foreground">Where to find it: {row.keyHelp}</p>
      </div>

      <div>
        <label className="block text-xs font-medium text-foreground mb-1">Model</label>
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder={row.defaultModel || row.modelMeaning}
          className={inputClass}
        />
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
        <div className="rounded border border-amber-500/50 bg-amber-500/10 p-2 space-y-2">
          <p className="text-xs text-amber-600 dark:text-amber-400">⚠ {insecureWarning}</p>
          <button
            onClick={() => void save(true)}
            disabled={busy}
            className="px-2 py-1 text-xs rounded border border-amber-500/60 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20"
          >
            Save it anyway — I accept the risk
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
          {busy ? 'Saving…' : 'Save'}
        </button>
        {row.stored && (
          <button
            onClick={() => void clear()}
            disabled={busy}
            className="px-3 py-1.5 text-xs rounded border border-border text-muted-foreground hover:text-foreground"
          >
            Remove key
          </button>
        )}
        {saved && <span className="text-xs text-green-600 dark:text-green-400">Saved</span>}
        {missing.length > 0 && (
          <span className="text-xs text-muted-foreground">still needs: {missing.join(', ')}</span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Insecure-backend banner — the design §4.1 warning, in the UI.
// ---------------------------------------------------------------------------

function SecurityBanner({ security }: { security: Security }) {
  if (security.secure) return null;
  return (
    <div className="rounded border border-amber-500/50 bg-amber-500/10 p-2">
      <p className="text-xs text-amber-600 dark:text-amber-400">
        ⚠ Keys cannot be stored securely on this computer (credential store:{' '}
        <code>{security.backend}</code>).{security.warning ? ` ${security.warning}` : ''}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings section
// ---------------------------------------------------------------------------

export function NabyProviderSettings({ isOpen }: { isOpen: boolean }) {
  const { data, unavailable, reload } = useProviders(isOpen);
  const [expanded, setExpanded] = useState<string | null>(null);

  if (unavailable) {
    return (
      <p className="text-xs text-muted-foreground">
        Provider keys are managed by the Naby desktop app. Running in a browser, keys come from the
        environment instead.
      </p>
    );
  }
  if (!data) return <p className="text-xs text-muted-foreground">Loading…</p>;

  return (
    <div className="space-y-2">
      <SecurityBanner security={data.security} />
      {data.providers.map((row) => (
        <div key={row.kind} className="border border-border rounded">
          <button
            onClick={() => setExpanded(expanded === row.kind ? null : row.kind)}
            className="w-full flex items-center justify-between px-2 py-2 text-left hover:bg-accent/50"
          >
            <span className="text-sm text-foreground">{row.label}</span>
            <span className="text-xs">
              {row.stored ? (
                <span className="text-green-600 dark:text-green-400">key saved</span>
              ) : (
                <span className="text-muted-foreground">not configured</span>
              )}
            </span>
          </button>
          {expanded === row.kind && (
            <div className="px-2 pb-2">
              <ProviderForm row={row} onSaved={() => void reload()} autoFocus />
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
  const [needed, setNeeded] = useState(false);
  const [checked, setChecked] = useState(false);
  const { data, reload } = useProviders(needed);
  const [choice, setChoice] = useState<string | null>(null);

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

  const selected = useMemo(
    () => data?.providers.find((p) => p.kind === choice) ?? null,
    [choice, data],
  );

  // Outside the desktop app, or already set up: render nothing at all.
  if (!checked || !needed) return null;

  const skip = async () => {
    await bridge()?.onboarding.complete();
    setNeeded(false);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-background">
      <div className="w-full max-w-lg mx-4 rounded-lg border border-border bg-card p-5 space-y-4">
        <div>
          <h1 className="text-lg font-medium text-foreground">Welcome to Naby</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Naby talks to an AI provider on your behalf. Pick the one you have an account with and
            paste its API key — that is the entire setup. The key is stored in this computer&apos;s
            secure credential store and is only ever sent to the provider you choose.
          </p>
        </div>

        {data && <SecurityBanner security={data.security} />}

        {!selected && (
          <div className="space-y-1">
            {(data?.providers ?? []).map((row) => (
              <button
                key={row.kind}
                onClick={() => setChoice(row.kind)}
                className="w-full flex items-center justify-between px-3 py-2 rounded border border-border hover:border-brand hover:bg-brand/5 text-left"
              >
                <span className="text-sm text-foreground">{row.label}</span>
                {row.stored && (
                  <span className="text-xs text-green-600 dark:text-green-400">key saved</span>
                )}
              </button>
            ))}
            {!data && <p className="text-xs text-muted-foreground">Loading providers…</p>}
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
                ← choose a different provider
              </button>
            </div>
            <ProviderForm
              row={selected}
              autoFocus
              onSaved={() => {
                // Reloading first means "did that actually store a key" is
                // answered by the vault, not assumed from a click.
                void reload().then(() => void refreshState());
              }}
            />
          </div>
        )}

        <div className="flex items-center justify-between pt-1 border-t border-border">
          <button
            onClick={() => void skip()}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Skip for now
          </button>
          <span className="text-xs text-muted-foreground">
            You can change this later in Settings → AI provider.
          </span>
        </div>
      </div>
    </div>
  );
}
