'use client';

import i18n from '@cockpit/shared-i18n';

// Migrated from src/components/shared/Toast.tsx.
// Translatable defaults inside confirm() come from the shared i18n
// dictionary at @cockpit/shared-i18n. The host's app/I18nProvider drives
// the language; this primitive just reads from i18n.t() like any other
// consumer.
//
// This module is deliberately NOT a React component. `toast()` is called from
// event handlers, promise chains and non-React helpers (72 call sites), so it
// builds DOM against a singleton container on document.body. That also makes it
// work unchanged inside the project iframes, which have their own React roots
// but share this document.
//
// A parallel React `ToastProvider`/`useToast` pair used to live here with zero
// consumers. It was removed along with its mount in workspace/Providers.tsx.

type ToastType = 'success' | 'error' | 'info';

/** Auto-dismiss delay for a toast nobody touches. */
const TOAST_DURATION_MS = 4000;
/**
 * Delay re-armed when the pointer leaves a hovered toast. Shorter than the full
 * duration because the user has already read it — same trade SessionCompleteToast
 * makes.
 */
const TOAST_RESUME_MS = 2000;
/** Must match the `toastIn` animation in globals.css. */
const TOAST_ENTER_MS = 350;
/** Must match the `toastOut` animation in globals.css. */
const TOAST_EXIT_MS = 200;
/** A fourth toast pushes the oldest out rather than growing the stack. */
const MAX_VISIBLE_TOASTS = 3;

// ============================================
// confirm() - Custom confirm dialog (replaces window.confirm)
// ============================================

export function confirm(message: string, options?: {
  title?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}): Promise<boolean> {
  const {
    title = i18n.t('confirm.title', { defaultValue: 'Confirm' }),
    confirmText = i18n.t('confirm.ok', { defaultValue: 'OK' }),
    cancelText = i18n.t('confirm.cancel', { defaultValue: 'Cancel' }),
    danger = false,
  } = options || {};

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-[200] flex items-center justify-center';
    overlay.style.animation = 'confirmFadeIn 0.15s ease-out';

    const cleanup = (result: boolean) => {
      overlay.style.animation = 'confirmFadeOut 0.12s ease-in';
      overlay.addEventListener('animationend', () => {
        document.body.removeChild(overlay);
        resolve(result);
      }, { once: true });
    };

    // Close on background click
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) cleanup(false);
    });

    // ESC to close
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        document.removeEventListener('keydown', handleKey, true);
        cleanup(false);
      } else if (e.key === 'Enter') {
        e.stopPropagation();
        document.removeEventListener('keydown', handleKey, true);
        cleanup(true);
      }
    };
    document.addEventListener('keydown', handleKey, true);

    const confirmBtnClass = danger
      ? 'bg-red-9 hover:bg-red-10 text-white'
      : 'bg-brand hover:bg-brand/90 text-white';

    // The four caller-supplied strings are filled in as text below, not
    // interpolated here: `message` regularly carries a server error or a file
    // name, and the i18n singleton runs with `escapeValue: false`.
    overlay.innerHTML = `
      <div class="fixed inset-0 bg-black/50"></div>
      <div class="relative bg-card border border-border rounded-xl shadow-2xl p-6 max-w-sm w-full mx-4" style="animation: confirmScaleIn 0.15s ease-out">
        <div data-slot="title" class="text-base font-medium text-foreground mb-2"></div>
        <div data-slot="message" class="text-sm text-muted-foreground mb-6 whitespace-pre-wrap"></div>
        <div class="flex justify-end gap-3">
          <button data-action="cancel" class="px-4 py-2 text-sm rounded-lg border border-border text-foreground hover:bg-accent transition-colors"></button>
          <button data-action="confirm" class="px-4 py-2 text-sm rounded-lg ${confirmBtnClass} transition-colors"></button>
        </div>
      </div>
    `;

    overlay.querySelector('[data-slot="title"]')!.textContent = title;
    overlay.querySelector('[data-slot="message"]')!.textContent = message;

    const cancelBtn = overlay.querySelector('[data-action="cancel"]')!;
    cancelBtn.textContent = cancelText;
    cancelBtn.addEventListener('click', () => {
      document.removeEventListener('keydown', handleKey, true);
      cleanup(false);
    });

    const confirmBtn = overlay.querySelector('[data-action="confirm"]')!;
    confirmBtn.textContent = confirmText;
    confirmBtn.addEventListener('click', () => {
      document.removeEventListener('keydown', handleKey, true);
      cleanup(true);
    });

    document.body.appendChild(overlay);

    // Auto-focus the confirm button
    (confirmBtn as HTMLButtonElement).focus();
  });
}

// ============================================
// toast() — standalone, no Provider needed
// ============================================

let toastContainer: HTMLDivElement | null = null;

/**
 * The stack lives at the bottom-right corner, 24px in, and grows UPWARD:
 * `flex-col-reverse` puts the first DOM child nearest the corner, and each new
 * toast is prepended, so the newest is always the one closest to the corner and
 * the older ones drift up and out. The container itself is click-through
 * (`pointer-events-none`) — only the cards take the pointer, so a toast never
 * swallows a click meant for the UI beneath it.
 */
function getToastContainer(): HTMLDivElement {
  // `isConnected` matters: a hot reload or a torn-down iframe document can drop
  // the node while the module-level reference survives.
  if (!toastContainer || !toastContainer.isConnected) {
    toastContainer = document.createElement('div');
    toastContainer.id = 'toast-container';
    toastContainer.className =
      'fixed bottom-6 right-6 z-[100] flex flex-col-reverse items-end gap-2.5 pointer-events-none';
    toastContainer.setAttribute('role', 'status');
    toastContainer.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastContainer);
  }
  return toastContainer;
}

/**
 * Status is carried by the icon alone — the surface stays `bg-popover`, the same
 * card every other floating panel uses, so a toast reads as part of the app
 * rather than as a colored banner. That is why there is no `bg-green-9` /
 * `bg-red-9` / white-on-color path here any more.
 */
const TOAST_ICON: Record<ToastType, { className: string; paths: string }> = {
  success: {
    className: 'text-brand',
    paths: '<circle cx="12" cy="12" r="9" /><path d="m8.5 12.5 2.5 2.5 4.5-5" />',
  },
  error: {
    className: 'text-destructive',
    paths: '<circle cx="12" cy="12" r="9" /><path d="m15 9-6 6M9 9l6 6" />',
  },
  info: {
    className: 'text-muted-foreground',
    paths: '<circle cx="12" cy="12" r="9" /><path d="M12 16.5v-5M12 8h.01" />',
  },
};

/** `Date.now()` collided whenever two toasts fired inside the same millisecond. */
let toastSeq = 0;

/**
 * Each live toast's own dismiss closure, so the stack cap can retire the oldest
 * card through the same path a click or a timeout takes — one exit animation,
 * one timer cleared, one removal.
 */
const dismissers = new WeakMap<HTMLElement, () => void>();

export function toast(message: string, type: ToastType = 'success') {
  const container = getToastContainer();

  const el = document.createElement('div');
  el.id = `toast-${++toastSeq}`;
  el.className =
    'toast-surface group pointer-events-auto flex items-start gap-2.5 w-[356px] max-w-[calc(100vw-2rem)] ' +
    'px-4 py-3 rounded-lg border border-border bg-popover text-[0.929rem] leading-snug text-foreground';
  el.style.animation = `toastIn ${TOAST_ENTER_MS}ms cubic-bezier(0.16, 1, 0.3, 1)`;

  const icon = TOAST_ICON[type] ?? TOAST_ICON.info;
  el.innerHTML = `
    <svg class="w-[18px] h-[18px] shrink-0 mt-px ${icon.className}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24" aria-hidden="true">${icon.paths}</svg>
    <span data-slot="message" class="flex-1 min-w-0 break-words"></span>
    <button data-action="dismiss" type="button" class="shrink-0 -mr-1.5 -mt-0.5 p-1 rounded text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-visible:opacity-100 hover:text-foreground">
      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 18 18 6M6 6l12 12" /></svg>
    </button>
  `;

  // SECURITY: the message is set as TEXT, never as markup. All 72 call sites
  // pass an i18n `t()` result, and the shared i18n singleton is configured with
  // `interpolation.escapeValue: false` — so an interpolated server error, agent
  // name or file path used to reach innerHTML verbatim. None of the call sites
  // passes markup on purpose (audited), so there is no HTML path to preserve.
  el.querySelector('[data-slot="message"]')!.textContent = message;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let leaving = false;

  const dismiss = () => {
    if (leaving) return;
    leaving = true;
    clearTimeout(timer);
    // Marks the node as on its way out so the stack cap below does not count it
    // and does not try to evict it a second time.
    el.dataset.leaving = 'true';
    el.style.animation = `toastOut ${TOAST_EXIT_MS}ms cubic-bezier(0.4, 0, 1, 1) forwards`;
    setTimeout(() => el.remove(), TOAST_EXIT_MS);
  };

  const arm = (delay: number) => {
    clearTimeout(timer);
    timer = setTimeout(dismiss, delay);
  };

  // Hover pauses the countdown and leaving re-arms it, mirroring
  // SessionCompleteToast — a toast must never disappear out from under a pointer
  // that is on its way to the close button.
  el.addEventListener('mouseenter', () => {
    if (!leaving) clearTimeout(timer);
  });
  el.addEventListener('mouseleave', () => {
    if (!leaving) arm(TOAST_RESUME_MS);
  });
  el.querySelector('[data-action="dismiss"]')!.addEventListener('click', dismiss);
  dismissers.set(el, dismiss);

  container.prepend(el);
  arm(TOAST_DURATION_MS);

  // Cap the stack: with `flex-col-reverse` + prepend, the oldest live toast is
  // the last child. Evicting it now (rather than waiting out its timer) keeps
  // the corner readable when a loop fires a burst of results.
  const live = () =>
    Array.from(container.children).filter(
      (c) => !(c as HTMLElement).dataset.leaving
    ) as HTMLElement[];
  let stack = live();
  while (stack.length > MAX_VISIBLE_TOASTS) {
    const oldest = stack[stack.length - 1];
    const retire = dismissers.get(oldest);
    // No closure on file means the node did not come from here (a stray child in
    // a shared document). Drop it outright rather than looping forever.
    if (retire) retire();
    else oldest.remove();
    stack = live();
  }
}
