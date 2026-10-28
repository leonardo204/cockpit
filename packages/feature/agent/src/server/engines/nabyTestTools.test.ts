import { afterEach, describe, expect, it } from 'vitest';
import { buildToolset, Outbox, withoutTestTools } from '../../../../../../../dist/naby-runtime.mjs';

// send_message "delivers" into an in-memory outbox nobody reads. Offered to a
// real model it reported work handed to @aside as sent while nothing happened.
describe('spike fixtures never reach a real turn', () => {
  const saved = process.env.NABY_TEST_TOOLS;
  afterEach(() => {
    process.env.NABY_TEST_TOOLS = saved;
  });

  it('strips echo_note and send_message without the opt-in', () => {
    delete process.env.NABY_TEST_TOOLS;
    const tools = withoutTestTools(buildToolset(new Outbox()));
    const names = tools.toolSchemas.map((s: { name: string }) => s.name);
    expect(names).not.toContain('send_message');
    expect(names).not.toContain('echo_note');
    expect(tools.executors.send_message).toBeUndefined();
    expect(names).toContain('fetch_url');
  });

  it('keeps them for suites that opt in', () => {
    process.env.NABY_TEST_TOOLS = '1';
    const names = withoutTestTools(buildToolset(new Outbox())).toolSchemas.map((s: { name: string }) => s.name);
    expect(names).toContain('send_message');
  });
});
