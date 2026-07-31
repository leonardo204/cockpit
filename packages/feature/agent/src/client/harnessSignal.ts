/**
 * Recognising the "harness changed, re-read it" signal.
 *
 * WHY THIS IS A MODULE AND NOT AN INLINE `if`. The composer's "/" palette is
 * fetched once per iframe mount. The Settings modal that enables a skill lives
 * in the TOP window and the composer lives in a per-project iframe that never
 * unmounts, so the ONLY thing that makes a freshly enabled skill appear is this
 * message arriving and being recognised. An inline predicate inside a
 * `useEffect` is unreachable from a test — jsdom can dispatch the event, but the
 * assertion then depends on a rendered ChatInput, its Effect runtime and its
 * fetch. Pulled out here, the matching rule is a pure function with a test, and
 * the effect around it stays three lines.
 *
 * BOTH ENVELOPE SHAPES ARE ACCEPTED because the bus emits both: the v1
 * compatibility shape `{ type: "HARNESS_CHANGED" }` and the v2 shape
 * `{ topic: "harness-changed", msg }`. A publisher that later drops the v1 half
 * must not silently stop reaching this listener.
 */
import { Topics } from '@cockpit/effect-services';

const TOPIC = Topics.HarnessChanged;

/** True when `data` is a harness-changed notification in either bus shape. */
export function isHarnessChangedMessage(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  return d.type === TOPIC.legacyType || d.topic === TOPIC.id;
}
