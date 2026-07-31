'use client';

/**
 * One block of the Settings modal — a FLAT SECTION, not a box.
 *
 * It started as a card, and that was the wrong fix for the right problem. With
 * three sections on screen (Agents: agent list, Telegram escalation, Memory) the
 * headings floated and the controls ran together, so each section got a border
 * and a tint. But every naby panel underneath already draws its own bordered
 * intro, its own bordered sub-panels and its own bordered rows — so a card around
 * them produced boxes inside boxes inside boxes, and the user's reading of it was
 * simply "네모가 너무 많다".
 *
 * THE RULE THIS FILE NOW ENFORCES: a section is a text header plus its content.
 * Separation comes from spacing and typography first, then a full-width divider
 * between sections — never from wrapping. Borders are the LAST resort and belong
 * to a single interactive row or a repeated list item, not to a group.
 *
 * The divider itself is the PARENT's job (`divide-y divide-border` on the modal's
 * content pane): a rule drawn by the section would either double up between two
 * siblings or need to know whether it is first. `first:pt-0 / last:pb-0` here is
 * the matching half — the top section does not start with a gap, and a lone
 * section adds no padding at all.
 *
 * DO NOT PASS `subtitle` WHEN THE CHILD ALREADY DESCRIBES ITSELF. Most of the
 * naby panels open with their own description paragraph; a section subtitle on
 * top of that is the same sentence twice.
 *
 * Module scope, not nested inside SettingsModal: a component declared during
 * render is a new type on every render, which would unmount and remount every
 * panel below it (losing their fetched state) on each keystroke in the modal.
 */
interface SettingsSectionProps {
  title: string;
  /** Only for sections whose body does not introduce itself. */
  subtitle?: string;
  children: React.ReactNode;
}

export function SettingsSection({ title, subtitle, children }: SettingsSectionProps) {
  return (
    <section className="py-5 first:pt-0 last:pb-0">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {subtitle ? (
        <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
      ) : null}
      <div className="mt-3">{children}</div>
    </section>
  );
}
