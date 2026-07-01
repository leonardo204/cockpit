'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * Fades + rises its children into view once, when they scroll near the
 * viewport. Progressive-enhancement by design:
 *
 *  - The hidden initial state lives in CSS under `.js-reveal [data-reveal]`.
 *    We only add `js-reveal` to <html> here, from an effect, so server-rendered
 *    / no-JS / crawler views keep everything visible.
 *  - If IntersectionObserver is missing we simply reveal immediately.
 *  - `prefers-reduced-motion` disables the motion (handled in CSS).
 *
 * Used to wrap the below-the-fold homepage sections. The Hero is intentionally
 * left unwrapped so the LCP content paints instantly.
 */
export function Reveal({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (typeof IntersectionObserver === 'undefined') {
      el.classList.add('is-visible');
      return;
    }

    document.documentElement.classList.add('js-reveal');

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            io.unobserve(entry.target);
          }
        }
      },
      // A small fixed bottom inset delays the reveal until the section has
      // entered a touch — but keep it in px (not %) and modest so the last
      // sections above the footer still clear it when scrolled to the bottom.
      { rootMargin: '0px 0px -60px 0px', threshold: 0 },
    );

    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={ref} data-reveal>
      {children}
    </div>
  );
}
