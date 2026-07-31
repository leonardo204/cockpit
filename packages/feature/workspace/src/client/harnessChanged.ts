'use client';

/**
 * "A harness item's visibility changed — re-read anything derived from it."
 *
 * WHY THIS IS ITS OWN MODULE. Two panels mutate the harness: NabyHarnessReview
 * (import, enable/disable, delete, revert) and NabyCommandManager (create, edit,
 * delete, enable/disable). They are separate surfaces for good reasons — one is
 * review of IMPORTED items of every kind, the other is CRUD over the user's own
 * commands — but they feed the same "/" palette, so an announcement that lives
 * inside one of them is an announcement the other will forget. It did: the
 * palette fix landed on the review panel first and the command panel kept the
 * original bug, where creating a command left it invisible until the app
 * restarted.
 *
 * WHY BOTH DIRECTIONS. `IframeBus.publish` posts to `window.parent`, which from
 * the top window — where the Settings modal renders — is the window it was sent
 * from, so no child iframe ever hears it. The composer that draws the palette
 * lives in one of those child iframes and is never unmounted. `announceTopic`
 * therefore publishes upward AND broadcasts downward; either half alone
 * reproduces the bug for one of the two possible placements of the modal.
 *
 * Callers must invoke this only on SUCCESS. Announcing from a `finally` would
 * refetch after a failed mutation too, which is harmless in itself but hides a
 * broken write behind a refresh that looks like it did something.
 */
import { announceTopic } from '@cockpit/effect-react';
import { Topics } from '@cockpit/effect-services';

export function announceHarnessChanged(): void {
  announceTopic(Topics.HarnessChanged, {});
}
