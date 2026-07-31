'use client';

/**
 * Phase 3 (P3-M6) — exporting a grown agent, with consent.
 *
 * Two steps on purpose. The first click only ASKS the server to build the pair
 * and returns a report; nothing is written and nothing has left the machine. The
 * user then sees what the files actually contain — how many learned facts, how
 * many rows were withheld and why — and only a second click saves them.
 *
 * WHY NOT ONE CLICK. This is the moment what naby learned about a person leaves
 * their machine. "It exported successfully" is not informed consent about that;
 * knowing it carries 12 things it learned about you, that 3 unreviewed notes and
 * 1 credential-shaped row were dropped, and that the file records a stage but
 * cannot grant one — that is.
 *
 * Saved through a Blob download rather than a server-side write: the browser's own
 * save dialog decides where the file lands, so this adds no filesystem-write path
 * (and no path validation to get wrong), and it works the same in the packaged app
 * and in a plain browser.
 */

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@cockpit/shared-ui';

/** The wire shape of `agent.export`. Declared locally — the panel is an HTTP
 *  client, matching how the rest of this package reads naby actions. */
type ExportWire = {
  markdownName: string;
  markdown: string;
  sidecarName: string;
  sidecar: string;
  report: {
    memoriesIncluded: number;
    droppedProposed: number;
    droppedSession: number;
    droppedSecret: number;
    ledgerRows: number;
    redactedLedgerFields: number;
    stage: 'egg' | 'larva' | 'pupa' | 'butterfly';
    promptLooksSecret: boolean;
  };
};

function saveFile(name: string, content: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on the next tick: revoking synchronously can cancel the download in
  // some browsers before it has read the blob.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function AgentExportButton({ agentId, cwd }: { agentId: string; cwd?: string }) {
  const { t } = useTranslation();
  const [pending, setPending] = useState<ExportWire | null>(null);
  const [busy, setBusy] = useState(false);

  const prepare = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/naby', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'agent.export', agentId, ...(cwd ? { cwd } : {}) }),
      });
      const json = (await res.json().catch(() => null)) as
        | { ok?: boolean; export?: ExportWire; error?: string }
        | null;
      if (!res.ok || !json?.ok || !json.export) {
        toast(json?.error || t('agentExport.failed', { defaultValue: 'Could not prepare the export.' }), 'error');
        return;
      }
      setPending(json.export);
    } catch {
      toast(t('agentExport.failed', { defaultValue: 'Could not prepare the export.' }), 'error');
    } finally {
      setBusy(false);
    }
  }, [agentId, cwd, t]);

  const save = useCallback(() => {
    if (!pending) return;
    saveFile(pending.markdownName, pending.markdown, 'text/markdown;charset=utf-8');
    saveFile(pending.sidecarName, pending.sidecar, 'application/json;charset=utf-8');
    setPending(null);
    toast(t('agentExport.saved', { defaultValue: 'Both files were saved.' }), 'success');
  }, [pending, t]);

  if (!pending) {
    return (
      <button
        onClick={() => void prepare()}
        disabled={busy}
        className="text-xs px-2 py-1 rounded border border-border hover:bg-brand/10 hover:border-brand/40 text-foreground disabled:opacity-50"
      >
        {t('agentExport.button', { defaultValue: 'Export' })}
      </button>
    );
  }

  const r = pending.report;
  const withheld: string[] = [];
  if (r.droppedProposed > 0) {
    withheld.push(
      t('agentExport.droppedProposed', {
        defaultValue: '{{count}} unreviewed note(s) stay behind',
        count: r.droppedProposed,
      }),
    );
  }
  if (r.droppedSession > 0) {
    withheld.push(
      t('agentExport.droppedSession', {
        defaultValue: '{{count}} conversation-only note(s) stay behind',
        count: r.droppedSession,
      }),
    );
  }
  if (r.droppedSecret > 0) {
    withheld.push(
      t('agentExport.droppedSecret', {
        defaultValue: '{{count}} credential-shaped note(s) stay behind',
        count: r.droppedSecret,
      }),
    );
  }
  if (r.redactedLedgerFields > 0) {
    withheld.push(
      t('agentExport.redacted', {
        defaultValue: '{{count}} place(s) in the record are masked',
        count: r.redactedLedgerFields,
      }),
    );
  }

  return (
    // A LEFT ACCENT, not a box. This confirmation opens inside the agent row,
    // which is already the one border the list is allowed; an amber rectangle in
    // there was card-in-card. The 2px amber edge keeps the "read this before you
    // click" weight without a fourth nested rectangle.
    <div
      className="mt-2 space-y-2 border-l-2 border-amber-500/60 pl-2.5"
      data-testid="agent-export-confirm"
    >
      <div className="text-xs font-medium text-amber-800 dark:text-amber-200">
        {t('agentExport.title', {
          defaultValue: 'These files contain what naby has learned about you.',
        })}
      </div>

      <ul className="space-y-0.5 text-[11px] text-foreground">
        <li>
          {t('agentExport.included', {
            defaultValue: '{{count}} confirmed thing(s) it learned',
            count: r.memoriesIncluded,
          })}
        </li>
        <li>
          {t('agentExport.ledger', {
            defaultValue: '{{count}} row(s) of growth record',
            count: r.ledgerRows,
          })}
        </li>
        <li className="text-muted-foreground">
          {t('agentExport.stage', {
            defaultValue: 'Reached the "{{stage}}" stage here — recorded as history, and it grants nothing where the file lands.',
            stage: t(`growth.stage.${r.stage}`, { defaultValue: r.stage }),
          })}
        </li>
      </ul>

      {/* A heading over its list, not a box around it: "Left out" is already the
          label that separates these lines from the ones above. */}
      {withheld.length > 0 ? (
        <div>
          <div className="text-[10px] font-medium text-muted-foreground">
            {t('agentExport.withheld', { defaultValue: 'Left out' })}
          </div>
          <ul className="mt-0.5 space-y-0.5 text-[11px] text-muted-foreground">
            {withheld.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {r.promptLooksSecret ? (
        <p className="text-[11px] leading-relaxed text-red-700 dark:text-red-300">
          {t('agentExport.promptWarning', {
            defaultValue:
              "This agent's own instructions look like they contain a credential. It is not removed — that would change how the agent behaves — so check it before saving.",
          })}
        </p>
      ) : null}

      <div className="text-[10px] font-mono text-muted-foreground break-all">
        {pending.markdownName} · {pending.sidecarName}
      </div>

      <div className="flex gap-1.5">
        <button
          onClick={save}
          className="text-xs px-2.5 py-1 rounded border border-emerald-500/50 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/15"
        >
          {t('agentExport.save', { defaultValue: 'Save both files' })}
        </button>
        <button
          onClick={() => setPending(null)}
          className="text-xs px-2.5 py-1 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent"
        >
          {t('agentExport.cancel', { defaultValue: 'Cancel' })}
        </button>
      </div>
    </div>
  );
}
