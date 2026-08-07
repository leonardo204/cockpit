import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  setActiveComposerSetter,
  clearActiveComposerSetter,
  setComposerText,
} from './fileRefBus';

/**
 * Resend / Edit on a user message.
 *
 * RESEND dispatches the same content (and rehydrated images) as a NEW turn,
 * through the same path a typed message takes. EDIT loads the message into the
 * active tab's composer via a bus channel that REPLACES the draft — a sibling
 * of the file-ref inserter, and under the same single-registrant discipline,
 * because every tab keeps its ChatInput mounted and a broadcast would write
 * into all of them at once.
 */

const CLIENT = __dirname;
const read = (name: string) => readFileSync(join(CLIENT, name), 'utf8');

describe('composer replace channel (fileRefBus)', () => {
  const noop = () => {};
  afterEach(() => {
    // The module singleton survives between tests; always relinquish.
    clearActiveComposerSetter(noop);
  });

  it('delivers to the registered setter and reports handling', () => {
    let got: string | null = null;
    const fn = (text: string) => { got = text; };
    setActiveComposerSetter(fn);
    expect(setComposerText('fix the login bug')).toBe(true);
    expect(got).toBe('fix the login bug');
    clearActiveComposerSetter(fn);
  });

  it('reports unhandled when no composer is registered', () => {
    expect(setComposerText('orphan')).toBe(false);
  });

  it('clear is guarded: a stale cleanup cannot evict the newly-active tab', () => {
    const outgoing = () => {};
    let got: string | null = null;
    const incoming = (text: string) => { got = text; };
    setActiveComposerSetter(outgoing);
    // Tab switch: the incoming input registers BEFORE the outgoing cleanup runs.
    setActiveComposerSetter(incoming);
    clearActiveComposerSetter(outgoing);
    expect(setComposerText('still here')).toBe(true);
    expect(got).toBe('still here');
    clearActiveComposerSetter(incoming);
  });
});

describe('resend / edit — wiring', () => {
  it('the user bubble offers resend and edit, gated on the interactive-chat signal', () => {
    const src = read('MessageBubble.tsx');
    // Both controls exist and only render when a resend sink was provided —
    // read-only surfaces (subagent transcript modal) pass none and keep Copy only.
    expect(src).toMatch(/onResend=\{isUser && onResendMessage && message\.content \? handleResend : undefined\}/);
    expect(src).toMatch(/onEdit=\{isUser && onResendMessage && message\.content \? handleEdit : undefined\}/);
    // Resend stands down while a run streams (one active run per session).
    expect(src).toContain('resendDisabled={isLoading}');
    // Edit goes through the composer-replace channel, not the caret inserter.
    expect(src).toContain('setComposerText(message.content)');
  });

  it('the list threads the resend sink down to each bubble', () => {
    const src = read('MessageList.tsx');
    expect(src).toMatch(/<MessageBubble[\s\S]{0,500}onResendMessage=\{onResendMessage\}/);
  });

  it('Chat resends through the same dispatch as typing, and guards the 409', () => {
    const src = read('Chat.tsx');
    const handler = /const handleResendMessage = useCallback\(\(message: ChatMessage\) => \{[\s\S]*?\}, \[[^\]]*\]\);/.exec(src)?.[0];
    expect(handler, 'handleResendMessage was renamed — re-point this guard').toBeDefined();
    // Same path as a typed message (so "/plan …" is still consumed as a command).
    expect(handler).toContain('wrappedHandleSend(message.content, images)');
    // One active run per session — a concurrent send would 409.
    expect(handler).toContain('if (isLoading || liveRunning) return;');
    expect(src).toContain('onResendMessage={handleResendMessage}');
  });

  it('the composer registers the replace setter only while its tab is active', () => {
    const src = read('ChatInput.tsx');
    const effect = /useEffect\(\(\) => \{\s*if \(!isActive\) return;[\s\S]*?\}, \[isActive, insertAtCaret, replaceDraft\]\);/.exec(src)?.[0];
    expect(effect, 'the registration effect was reshaped — re-point this guard').toBeDefined();
    expect(effect).toContain('setActiveComposerSetter(replaceDraft)');
    expect(effect).toContain('clearActiveComposerSetter(replaceDraft)');
  });
});
