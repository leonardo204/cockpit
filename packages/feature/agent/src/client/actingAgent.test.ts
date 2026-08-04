import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ASSUMED_ACTING_AGENT,
  actingAgentFromInit,
  thinkingDisplayName,
} from './actingAgent';

/**
 * WHO THE THINKING BUBBLE NAMES.
 *
 * The bubble said "Claude가 생각하는 중…" — the engine brand — for every ordinary
 * turn, while the same product had just greeted the user as 나비 two bubbles
 * above. Whichever model answers, it is the same naby; the engine is already
 * named in the session toolbar. So the label names the AGENT, and the brand
 * survives only where there is no agent at all.
 *
 * Half of this is a pure rule (below) and half is wiring across three files, so
 * the wiring gets SOURCE assertions: dropping `onActingAgent` in Chat leaves a
 * bubble that still renders, saying the wrong name, with nothing to fail.
 */

/** The `packages/` root — this file sits at packages/feature/agent/src/client. */
const ROOT = join(__dirname, '../../../..');

function dict(locale: string): Record<string, Record<string, string>> {
  return JSON.parse(readFileSync(join(ROOT, 'shared/i18n/locales', `${locale}.json`), 'utf8'));
}

function source(relPath: string): string {
  return readFileSync(join(ROOT, relPath), 'utf8');
}

describe('the name in the "… is thinking" bubble', () => {
  it('is the localized persona name for a persona turn — not the stored handle', () => {
    // The persona's row is named `naby`, but an install that hit the name-collision
    // concession keeps `persona`, and a Korean user should read 나비 in either case.
    expect(
      thinkingDisplayName({
        acting: { name: 'naby', persona: true },
        personaLabel: '나비',
        engineName: 'Claude',
      }),
    ).toBe('나비');
    expect(
      thinkingDisplayName({
        acting: { name: 'persona', persona: true },
        personaLabel: '나비',
        engineName: 'Claude',
      }),
    ).toBe('나비');
  });

  it('is the agent\'s own name when the turn was addressed to a different agent', () => {
    // `@researcher …` — an imported/custom agent answers as itself, and saying 나비
    // would be a plain lie about who is doing the work.
    expect(
      thinkingDisplayName({
        acting: { name: 'researcher', persona: false },
        personaLabel: '나비',
        engineName: 'Claude',
      }),
    ).toBe('researcher');
  });

  it('falls back to the engine brand ONLY when no agent identity exists', () => {
    expect(
      thinkingDisplayName({ acting: null, personaLabel: '나비', engineName: 'Claude' }),
    ).toBe('Claude');
    expect(
      thinkingDisplayName({ acting: null, personaLabel: 'naby', engineName: 'AI' }),
    ).toBe('AI');
  });

  it('never renders an empty label', () => {
    // A missing translation must not blank the bubble; the handle is the backstop.
    expect(
      thinkingDisplayName({ acting: { name: 'naby', persona: true }, personaLabel: '', engineName: 'Claude' }),
    ).toBe('naby');
  });

  it('assumes the persona until the turn reports in', () => {
    // Every unaddressed turn IS the persona's (the engine's growthSubject falls
    // back to it), so the pre-init default must not be the brand — that is exactly
    // the flip this fix removes.
    expect(ASSUMED_ACTING_AGENT.persona).toBe(true);
    expect(
      thinkingDisplayName({ acting: ASSUMED_ACTING_AGENT, personaLabel: '나비', engineName: 'Claude' }),
    ).toBe('나비');
  });
});

describe('reading the acting agent off system/init', () => {
  it('takes the agent the server reported', () => {
    expect(actingAgentFromInit({ acting_agent: { name: 'naby', persona: true } }))
      .toEqual({ name: 'naby', persona: true });
    expect(actingAgentFromInit({ acting_agent: { name: 'researcher', persona: false } }))
      .toEqual({ name: 'researcher', persona: false });
  });

  it('is null when the event carries none — the engine-brand path', () => {
    expect(actingAgentFromInit({})).toBeNull();
    expect(actingAgentFromInit(null)).toBeNull();
    expect(actingAgentFromInit(undefined)).toBeNull();
  });

  it('degrades rather than rendering a malformed field', () => {
    // It crosses a wire. "[object Object] is thinking" is worse than the brand.
    expect(actingAgentFromInit({ acting_agent: 'naby' })).toBeNull();
    expect(actingAgentFromInit({ acting_agent: { name: '' } })).toBeNull();
    expect(actingAgentFromInit({ acting_agent: { name: 7 } })).toBeNull();
    // A truthy-but-not-true `persona` is not a persona: only the server's boolean is.
    expect(actingAgentFromInit({ acting_agent: { name: 'x', persona: 'yes' } }))
      .toEqual({ name: 'x', persona: false });
  });
});

describe('the sentence itself, in both locales', () => {
  it('reads as the agent speaking once the persona name is interpolated', () => {
    expect(dict('ko').chat!.thinking.replace('{{name}}', dict('ko').chat!.personaName))
      .toBe('나비가 생각하는 중…');
    expect(dict('en').chat!.thinking.replace('{{name}}', dict('en').chat!.personaName))
      .toBe('naby is thinking…');
  });

  it('names naby the way each locale already names it elsewhere', () => {
    expect(dict('ko').chat!.personaName).toBe('나비');
    expect(dict('en').chat!.personaName).toBe('naby');
  });
});

describe('the wiring, which no unit test in this tree can see', () => {
  it('has the engine report the acting agent on the turn it already reports the model on', () => {
    const engine = source('feature/agent/src/server/engines/naby.ts');
    // On `system/init`, from `growthSubject` — which IS `routedAgent ?? persona`,
    // so an ordinary turn reports the persona and an `@name` turn reports that
    // agent. Deriving it any other way would re-implement routing.
    expect(engine).toMatch(/acting_agent:\s*\{\s*\n\s*name: growthSubject\.name/);
    expect(engine).toContain('persona: isBuiltinPersona(growthSubject)');
  });

  it('threads it through the existing init handler, not a channel of its own', () => {
    const stream = source('feature/agent/src/client/useChatStream.ts');
    expect(stream).toContain('actingAgentFromInit(event)');
    // Fired on EVERY init, including a null: a turn on an engine with no agent
    // identity must not keep naming the previous turn's agent.
    expect(stream).toContain('onActingAgentRef.current?.(actingAgentFromInit(event))');
  });

  it('is what Chat hands the bubble', () => {
    const chat = source('feature/agent/src/client/Chat.tsx');
    expect(chat).toContain('onActingAgent: handleActingAgent');
    expect(chat).toContain('thinkingDisplayName({');
    expect(chat).toContain("personaLabel: t('chat.personaName'");
    // The brand is passed as the FALLBACK argument and nowhere else.
    expect(chat).toContain('engineName: engineBrand');
    expect(chat).toContain('thinkingName={thinkingName}');
  });

  it('says the same thing on the phone', () => {
    // The mobile screen renders the SAME MessageList and passed it nothing, so it
    // showed the generic "AI is thinking" — the same mistake, quieter.
    const mobile = source('feature/agent/src/client/mobile/MobileChat.tsx');
    expect(mobile).toContain('onActingAgent: setActingAgent');
    expect(mobile).toContain('thinkingName={thinkingName}');
    expect(mobile).toContain('thinkingDisplayName({');
  });

  it('leaves the bubble itself with one sentence per case', () => {
    const list = source('feature/agent/src/client/MessageList.tsx');
    expect(list).toContain("t('chat.thinking', { name: thinkingName || GENERIC_ENGINE_NAME })");
  });
});
