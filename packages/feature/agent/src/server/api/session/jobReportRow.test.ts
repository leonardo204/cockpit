import { describe, it, expect } from 'vitest';
import { buildJobReportPrompt, isJobReportPrompt } from '../../lib/backgroundJobReport';
import { toChatMessages } from './toChatMessages';

/**
 * A BACKGROUND JOB'S REPORT IS NOT SOMETHING THE USER SAID.
 *
 * It reports itself by DRIVING A TURN, and a turn's prompt is stored as a `user`
 * message — so the transcript drew backend bookkeeping in the reader's own
 * bubble, as if they had typed it.
 *
 * It is not naby's either, and that is the part worth being careful about: the
 * text is an instruction addressed TO naby ("tell the user how it went"), so
 * moving it to the assistant side would show naby instructing itself. It is a
 * system notice.
 */

const job = (over: Record<string, unknown> = {}) =>
  ({
    id: 'job-7',
    command: 'npm test',
    status: 'succeeded',
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_060_000,
    ...over,
  }) as never;

const userMsg = (content: string) => ({ role: 'user' as const, content });

describe('recognising the report', () => {
  it('recognises what the builder actually produces', () => {
    // The two read one constant, so they cannot drift — which is what makes
    // matching on text safe here at all.
    expect(isJobReportPrompt(buildJobReportPrompt(job()))).toBe(true);
  });

  it('recognises every outcome the builder can report', () => {
    for (const status of ['succeeded', 'failed', 'killed', 'weird']) {
      expect(isJobReportPrompt(buildJobReportPrompt(job({ status }))), status).toBe(true);
    }
  });

  it('does not mistake ordinary messages for one', () => {
    for (const text of [
      'the background job finished, can you check',
      '[system] something else entirely',
      '[system] The background job',
      'npm test',
      '',
    ]) {
      expect(isJobReportPrompt(text), text).toBe(false);
    }
  });
});

describe('how the transcript renders it', () => {
  const rows = toChatMessages([userMsg(buildJobReportPrompt(job()))] as never);

  it('is a system row, not the user’s bubble', () => {
    expect(rows[0]!.role).toBe('system');
  });

  it('is marked so the pill can say something a reader understands', () => {
    // Its own kind rather than plain `meta`: the pill's wording is localized in
    // the client, and the raw text is English and addressed to naby.
    expect(rows[0]!.systemEvent?.kind).toBe('job-report');
  });

  it('keeps the ORIGINAL, one click away', () => {
    // The detail modal shows `detail`. Nothing is hidden — it is only no longer
    // mistaken for something the user wrote.
    expect(rows[0]!.systemEvent?.detail).toBe(buildJobReportPrompt(job()));
    expect(rows[0]!.content).toBe(buildJobReportPrompt(job()));
  });

  it('leaves a real user message completely alone', () => {
    const real = toChatMessages([userMsg('테스트 좀 돌려줘')] as never);
    expect(real[0]!.role).toBe('user');
    expect(real[0]!.systemEvent).toBeUndefined();
  });
});
