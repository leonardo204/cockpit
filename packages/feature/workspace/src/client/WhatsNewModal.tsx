'use client';

/**
 * "What changed" — the release notes, on the first launch after an update.
 *
 * THREE PIECES, and they are separate for a reason:
 *
 *   WhatsNewModal   the overlay itself. Given entries, it renders them. It has
 *                   no idea whether this is a first launch.
 *   WhatsNewGate    the first-launch path. Asks the bridge two questions, hands
 *                   the answers to `planWhatsNew`, and does what it says.
 *                   Mounted once, beside the onboarding wizard.
 *   WhatsNewButton  the re-open path, in Settings → Updates. Same modal, the
 *                   whole archive, and it never records anything.
 *
 * IT DOES NOT GATE STARTUP. The gate renders `null` until two IPC round trips
 * come back, and nothing waits on it: it is a sibling of the workspace, not a
 * wrapper around it. A bridge that never answers costs the user the popup and
 * nothing else.
 *
 * IT DOES NOT FIGHT ONBOARDING. Two independent guards, because the failure is
 * a brand-new user being handed a changelog on top of a setup wizard:
 *   1. `planWhatsNew`'s fresh-install rule — no watermark means nothing is
 *      shown, which is every genuinely new user.
 *   2. This gate additionally waits for `onboarding.onboarded`, which catches
 *      the case rule 1 does not: someone who SKIPPED the wizard without a key
 *      (so it is still up) and later updates. Nothing is shown and nothing is
 *      recorded on such a launch, so the notes are simply announced on the
 *      first launch after they finish setting up.
 * The overlay is `z-50`, under the wizard's `z-[60]`, so even if both were ever
 * on screen the wizard is the one in front.
 *
 * PORTALED, like every other overlay here: the workspace wraps its panels in a
 * `translateX` container and several hosts are `overflow-hidden`, so an
 * in-place fixed overlay gets clipped (shell/CLAUDE.md).
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MarkdownRenderer, Portal, useEscToClose } from '@cockpit/shared-ui';
import { RELEASE_NOTES_MARKDOWN } from './releaseNotes';
import {
  allNotesUpTo,
  bodyFor,
  parseReleaseNotes,
  planWhatsNew,
  type ReleaseNote,
} from './releaseNotesOps';

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

interface WhatsNewBridge {
  get(): Promise<Result<{ currentVersion: string; lastSeenVersion: string | null }>>;
  markSeen(version: string): Promise<Result<void>>;
}

interface OnboardingBridge {
  state(): Promise<Result<{ onboarded?: boolean }>>;
}

function bridge(): { whatsNew?: WhatsNewBridge; onboarding?: OnboardingBridge } | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    naby?: { whatsNew?: WhatsNewBridge; onboarding?: OnboardingBridge };
  };
  return w.naby ?? null;
}

/**
 * Parsed ONCE per bundle rather than per mount. The changelog is a module-level
 * constant, so re-parsing it on every render of a modal that is opened at most
 * twice a release would be work for nothing.
 */
const ALL_NOTES: ReleaseNote[] = parseReleaseNotes(RELEASE_NOTES_MARKDOWN);

// ---------------------------------------------------------------------------
// The overlay
// ---------------------------------------------------------------------------

export function WhatsNewModal({
  entries,
  version,
  /** `true` when this was opened by the app after an update, rather than by the
   *  user from Settings. Only the subtitle differs. */
  afterUpdate = false,
  onClose,
}: {
  entries: ReleaseNote[];
  version: string;
  afterUpdate?: boolean;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  useEscToClose(onClose);

  return (
    <Portal>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-0 md:p-4"
        onClick={onClose}
      >
        <div
          data-testid="whats-new-modal"
          className="bg-card shadow-xl w-full max-w-lg h-full md:h-auto md:max-h-[80vh] rounded-none md:rounded-lg flex flex-col overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-3 border-b border-border">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-foreground">{t('whatsNew.title')}</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {afterUpdate
                  ? t('whatsNew.updatedTo', { version })
                  : t('whatsNew.currentVersion', { version })}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              title={t('common.close')}
              className="p-1 rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* EVERY entry in the range, newest first, in ONE scroll. A user who
              skipped 1.22 → 1.25 is owed all four, and a four-step wizard would
              make them click three times to reach the release they are actually
              on. The newest is at the top because it is the one they came for. */}
          <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-5">
            {entries.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t('whatsNew.empty')}</p>
            ) : (
              entries.map((entry) => (
                <section key={entry.version} data-testid="whats-new-entry" className="space-y-1.5">
                  <div className="flex items-baseline gap-2">
                    <h3 className="text-xs font-semibold text-foreground">v{entry.version}</h3>
                    {/* rem, not px: an arbitrary px size would sit outside the
                        global font scale (fontSettings.test.ts). */}
                    {entry.date && (
                      <span className="text-[0.6875rem] text-muted-foreground">{entry.date}</span>
                    )}
                  </div>
                  <MarkdownRenderer content={bodyFor(entry, i18n.language)} />
                </section>
              ))
            )}
          </div>

          <div className="flex justify-end px-5 py-3 border-t border-border">
            <button
              type="button"
              data-testid="whats-new-dismiss"
              onClick={onClose}
              className="px-3 py-1.5 text-xs rounded-md bg-brand text-white hover:opacity-90 transition-opacity"
            >
              {t('whatsNew.dismiss')}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}

// ---------------------------------------------------------------------------
// First launch after an update
// ---------------------------------------------------------------------------

export function WhatsNewGate() {
  const [shown, setShown] = useState<{ entries: ReleaseNote[]; version: string } | null>(null);

  useEffect(() => {
    const api = bridge();
    if (!api?.whatsNew) return;
    let alive = true;

    void (async () => {
      // Guard 2 (see the header): a wizard that is still up owns the screen.
      // Nothing is recorded on this launch either, so the notes survive to the
      // launch after setup finishes.
      const onboarding = api.onboarding ? await api.onboarding.state() : null;
      if (onboarding && (!onboarding.ok || onboarding.value.onboarded !== true)) return;
      if (!alive) return;

      const res = await api.whatsNew!.get();
      if (!alive || !res.ok) return;

      const plan = planWhatsNew({
        currentVersion: res.value.currentVersion,
        lastSeenVersion: res.value.lastSeenVersion,
        notes: ALL_NOTES,
      });

      if (plan.recordSilently) {
        // The fresh-install path, and the upgrade nobody wrote notes for. The
        // user is told nothing; the watermark moves so the NEXT upgrade is the
        // one that speaks.
        await api.whatsNew!.markSeen(plan.recordSilently);
        return;
      }
      if (!alive || plan.entries.length === 0) return;
      setShown({ entries: plan.entries, version: res.value.currentVersion });
    })();

    return () => {
      alive = false;
    };
  }, []);

  /**
   * Dismissal is the acknowledgement — by the button, the ✕, Escape or the
   * backdrop, all of which arrive here. Recording BEFORE hiding, and awaiting
   * nothing: the write is a rename onto a two-line JSON file, and a popup that
   * waits for the disk before closing would feel broken.
   */
  const dismiss = useCallback(() => {
    const version = shown?.version;
    setShown(null);
    if (version) void bridge()?.whatsNew?.markSeen(version);
  }, [shown]);

  if (!shown) return null;
  return (
    <WhatsNewModal entries={shown.entries} version={shown.version} afterUpdate onClose={dismiss} />
  );
}

// ---------------------------------------------------------------------------
// Re-open, from Settings → Updates
// ---------------------------------------------------------------------------

/**
 * So a mis-click is not the end of it. Shows the ARCHIVE — every entry up to
 * the running version — rather than only the newest, because a user who came
 * looking for this is asking a question the newest entry alone may not answer.
 *
 * It records nothing. Re-reading is not dismissing, and the first-launch popup
 * has already recorded by the time this button can be pressed.
 */
export function WhatsNewButton() {
  const { t } = useTranslation();
  const [version, setVersion] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const api = bridge();
    if (!api?.whatsNew) return;
    let alive = true;
    void api.whatsNew.get().then((res) => {
      if (alive && res.ok) setVersion(res.value.currentVersion);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!version) return null;

  return (
    <>
      <button
        type="button"
        data-testid="whats-new-reopen"
        onClick={() => setOpen(true)}
        className="px-3 py-1.5 text-xs rounded-md bg-accent text-foreground hover:bg-accent/80 transition-colors"
      >
        {t('whatsNew.reopen')}
      </button>
      {open && (
        <WhatsNewModal
          entries={allNotesUpTo(ALL_NOTES, version)}
          version={version}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
