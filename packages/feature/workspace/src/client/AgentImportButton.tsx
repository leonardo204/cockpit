'use client';

/**
 * Phase 3 (P3-M7) — bringing an agent in, with the one question that matters.
 *
 * Three steps, and the middle one is the point. Pick a `.naby.json`; the server
 * PARSES it and reports what it carries without writing anything; then the user
 * decides. A colleague's persona is untrusted content — it can carry a prompt
 * injection in its instructions and unreviewed claims in its memory — so what it
 * contains has to be visible before it lands, not after.
 *
 * THE QUESTION: "is this your own export?" It decides whether the imported growth
 * record counts. A ledger measures how well an agent predicts ONE person, and
 * nothing in a file can prove whose history it is: a colleague's perfect record
 * says nothing about whether the agent knows YOU, while your own from an old
 * laptop is exactly your history. Only the user knows which this is, so it is
 * asked. Unchecked (the default) the agent arrives as an egg and earns its stage
 * here — which is also why an imported agent cannot be `@`-addressed on arrival.
 *
 * What the answer never changes: the learned facts go into that agent's own
 * INSTRUCTIONS and never into naby's memory of the user (the write gate forbids
 * external content from writing user scope at all), the agent is always a custom
 * one, and any stage the file claims is shown as a claim and believed by nothing.
 */

import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@cockpit/shared-ui';

type ImportWire = {
  report: {
    name: string;
    renamedFrom?: string;
    factsInlined: number;
    skippedFacts: number;
    ledgerRows: number;
    ledgerCounts: boolean;
    claimedStage?: string;
    promptLooksSecret: boolean;
    warnings: string[];
  };
  origin: { agentId?: string; kind?: string; exportedAt?: number };
  applied: boolean;
  ledgerWritten?: number;
};

export function AgentImportButton({ onImported }: { onImported: () => void }) {
  const { t } = useTranslation();
  const fileRef = useRef<HTMLInputElement>(null);
  // The file's text is held here between the preview and the apply so the user is
  // not asked to pick it twice.
  const [sidecar, setSidecar] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportWire | null>(null);
  const [trustLedger, setTrustLedger] = useState(false);
  const [busy, setBusy] = useState(false);

  const post = useCallback(
    async (body: Record<string, unknown>): Promise<ImportWire | null> => {
      try {
        const res = await fetch('/api/naby', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'agent.import', ...body }),
        });
        const json = (await res.json().catch(() => null)) as
          | { ok?: boolean; import?: ImportWire; error?: string }
          | null;
        if (!res.ok || !json?.ok || !json.import) {
          toast(json?.error || t('agentImport.failed', { defaultValue: 'That file could not be read.' }), 'error');
          return null;
        }
        return json.import;
      } catch {
        toast(t('agentImport.failed', { defaultValue: 'That file could not be read.' }), 'error');
        return null;
      }
    },
    [t],
  );

  const pick = useCallback(
    async (file: File) => {
      setBusy(true);
      try {
        const text = await file.text();
        const result = await post({ sidecar: text });
        if (result) {
          setSidecar(text);
          setPreview(result);
          setTrustLedger(false);
        }
      } finally {
        setBusy(false);
        // Cleared so picking the SAME file again still fires a change event.
        if (fileRef.current) fileRef.current.value = '';
      }
    },
    [post],
  );

  const apply = useCallback(async () => {
    if (!sidecar) return;
    setBusy(true);
    const result = await post({ sidecar, apply: true, trustLedger });
    setBusy(false);
    if (!result) return;
    setSidecar(null);
    setPreview(null);
    onImported();
    toast(
      t('agentImport.done', {
        defaultValue: 'Imported @{{name}} with {{count}} learned fact(s) in its instructions.',
        name: result.report.name,
        count: result.report.factsInlined,
      }),
      'success',
    );
  }, [sidecar, trustLedger, post, onImported, t]);

  const cancel = useCallback(() => {
    setSidecar(null);
    setPreview(null);
  }, []);

  if (!preview) {
    return (
      <div>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void pick(f);
          }}
        />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className="text-xs px-2.5 py-1 rounded border border-border hover:bg-brand/10 hover:border-brand/40 text-foreground disabled:opacity-50"
        >
          {t('agentImport.button', { defaultValue: 'Import an agent…' })}
        </button>
      </div>
    );
  }

  const r = preview.report;
  return (
    <div
      className="space-y-2 rounded-lg border border-sky-500/50 bg-sky-500/10 p-3"
      data-testid="agent-import-confirm"
    >
      <div className="text-xs font-medium text-sky-800 dark:text-sky-200">
        {t('agentImport.title', {
          defaultValue: 'This file was written somewhere else. Here is what it carries.',
        })}
      </div>

      <ul className="space-y-0.5 text-[11px] text-foreground">
        <li className="font-mono">@{r.name}</li>
        {r.renamedFrom ? (
          <li className="text-muted-foreground">
            {t('agentImport.renamed', {
              defaultValue: '"{{from}}" is taken here, so it comes in under a new name. Nothing is overwritten.',
              from: r.renamedFrom,
            })}
          </li>
        ) : null}
        <li>
          {t('agentImport.facts', {
            defaultValue:
              '{{count}} learned fact(s), which go into this agent\'s own instructions — not into naby\'s memory of you',
            count: r.factsInlined,
          })}
        </li>
        <li>
          {t('agentImport.ledger', {
            defaultValue: '{{count}} row(s) of growth record',
            count: r.ledgerRows,
          })}
        </li>
        {r.claimedStage ? (
          <li className="text-muted-foreground">
            {t('agentImport.claimed', {
              defaultValue: 'The file says it reached "{{stage}}" — that is its claim, and nothing here acts on it.',
              stage: t(`growth.stage.${r.claimedStage}`, { defaultValue: r.claimedStage }),
            })}
          </li>
        ) : null}
      </ul>

      {/* THE QUESTION */}
      <label className="flex cursor-pointer items-start gap-1.5 rounded border border-border bg-background/60 px-2 py-1.5">
        <input
          type="checkbox"
          checked={trustLedger}
          onChange={(e) => setTrustLedger(e.target.checked)}
          className="mt-0.5"
          data-testid="agent-import-trust"
        />
        <span className="text-[11px] leading-relaxed text-foreground">
          {t('agentImport.trustLabel', { defaultValue: 'This is my own export.' })}
          <span className="block text-muted-foreground">
            {trustLedger
              ? t('agentImport.trustOn', {
                  defaultValue:
                    'The growth record counts, and the stage is recomputed from it — not from what the file claims.',
                })
              : t('agentImport.trustOff', {
                  defaultValue:
                    'The record is kept but does not count: the agent starts over here and cannot be called with @ until it earns it.',
                })}
          </span>
        </span>
      </label>

      {r.promptLooksSecret ? (
        <div className="rounded border border-red-500/50 bg-red-500/10 px-2 py-1.5 text-[11px] leading-relaxed text-red-700 dark:text-red-300">
          {t('agentImport.promptWarning', {
            defaultValue:
              "This agent's instructions look like they contain a credential. Read them before importing.",
          })}
        </div>
      ) : null}

      {r.warnings.length > 0 ? (
        <details className="rounded border border-border bg-background/60 px-2 py-1.5">
          <summary className="cursor-pointer text-[10px] font-medium text-muted-foreground hover:text-foreground">
            {t('agentImport.skipped', {
              defaultValue: '{{count}} thing(s) this machine will not take',
              count: r.warnings.length,
            })}
          </summary>
          <ul className="mt-1 space-y-0.5 text-[10px] text-muted-foreground">
            {r.warnings.map((w, i) => (
              <li key={`${i}:${w}`}>{w}</li>
            ))}
          </ul>
        </details>
      ) : null}

      <div className="flex gap-1.5">
        <button
          onClick={() => void apply()}
          disabled={busy}
          className="text-xs px-2.5 py-1 rounded border border-emerald-500/50 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/15 disabled:opacity-50"
        >
          {t('agentImport.confirm', { defaultValue: 'Import' })}
        </button>
        <button
          onClick={cancel}
          disabled={busy}
          className="text-xs px-2.5 py-1 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-50"
        >
          {t('agentImport.cancel', { defaultValue: 'Cancel' })}
        </button>
      </div>
    </div>
  );
}
