'use client';

/**
 * The one place a settings panel is allowed to keep its long explanation.
 *
 * WHY IT EXISTS. Every panel in this modal opened with a paragraph, and the
 * paragraphs kept growing: a sentence to say what the panel is, another to say
 * how it works, another for the caveat, another for the syntax. Read one at a
 * time each addition looks harmless. Read together — which is how the user meets
 * them — the Agents pane opened with three paragraphs before a single control,
 * and the harness list rendered a full frontmatter description plus a body
 * preview plus a provenance path on every card.
 *
 * The rule the panels now follow is the one every published guideline agrees on
 * (NN/g progressive disclosure, Microsoft's settings guidance, Material's
 * three-line ceiling on list items, GOV.UK hint text, Polaris "weigh every
 * word"): the visible description is ONE sentence, and everything that only
 * elaborates it waits behind a single expander. Not two levels of expander, and
 * not a second copy of the same sentence somewhere else on the page — one place.
 *
 * WHY A COMPONENT AND NOT SIX HAND-ROLLED `<details>`. Because six copies is how
 * the panels got here. A shared component makes the collapsed-by-default
 * behaviour, the summary label and the flat styling one decision instead of six,
 * and gives `settingsLayout.test.ts` a single file to assert against.
 *
 * FLAT, LIKE EVERYTHING ELSE IN THIS PANE. No border and no tint: the disclosure
 * frequently opens INSIDE something that already has a border (a list-item card),
 * and a bordered box one pixel inside another border is exactly the "네모가 너무
 * 많다" this modal was rebuilt to remove. It separates its content with a rule
 * instead.
 *
 * Module scope for the same reason as SettingsSection: a component declared
 * during render is a new type each time, remounting everything below it.
 */
import { useTranslation } from 'react-i18next';

interface SettingsDetailsProps {
  /** The supplemental prose. Anything task-critical belongs OUTSIDE this. */
  children: React.ReactNode;
  /** Override the shared "Details" label where a more specific one reads better. */
  label?: string;
}

export function SettingsDetails({ children, label }: SettingsDetailsProps) {
  const { t } = useTranslation();
  return (
    <details className="mt-1">
      <summary className="cursor-pointer select-none text-[10px] text-muted-foreground hover:text-foreground">
        {label ?? t('settings.moreDetails')}
      </summary>
      <div className="mt-1.5 border-t border-border pt-1.5 text-[11px] leading-relaxed text-muted-foreground space-y-1">
        {children}
      </div>
    </details>
  );
}
