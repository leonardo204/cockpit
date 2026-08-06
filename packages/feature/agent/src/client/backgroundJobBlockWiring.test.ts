import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The background-job block has to be WIRED UP, and its clock has to stand down.
 *
 * Two mistakes this guards, neither of which any pure test can see and neither
 * of which jsdom could either (it has no layout and no tabs):
 *
 *   1. THE BLOCK IS NEVER DRAWN. `partitionBackgroundJobs` can be perfect and
 *      the transcript still silent if the bubble does not render the segment —
 *      which is exactly the state this whole change is fixing, so shipping it
 *      again would be quiet and complete.
 *   2. THE CLOCK TICKS IN EVERY TAB. All three panels and every open chat tab
 *      stay mounted (`display:none`, never unmounted), so a per-second interval
 *      that ignores `isActive` re-renders turns nobody can see — the render
 *      convention this file's neighbours all follow.
 */

const CLIENT = __dirname;
const read = (name: string) => readFileSync(join(CLIENT, name), 'utf8');

describe('background job block — wiring', () => {
  it('the bubble renders a background segment and passes tab visibility down', () => {
    const src = read('MessageBubble.tsx');
    expect(src).toContain("seg.kind === 'background'");
    expect(src).toContain('<BackgroundJobBlock');
    expect(src, 'the block must know whether its tab is on screen').toMatch(
      /<BackgroundJobBlock[\s\S]{0,240}isActive=\{isActive\}/
    );
    // And the partition has to run BEFORE the subagent grouping, on its output —
    // otherwise a shell job becomes a phantom "Subagent" block.
    expect(src).toContain('partitionBackgroundJobs(displayToolCalls, message.subagents');
    // …told whether the turn is over, so a finished turn stops claiming a job
    // is live (nothing is listening for its ending edge any more).
    expect(src).toContain('turnEnded: !message.isStreaming');
    expect(src).toContain('groupSubagentCalls(background.calls, background.tasks)');
    expect(src).toContain('background.jobs');
  });

  it('the list hands each bubble its tab’s visibility', () => {
    const src = read('MessageList.tsx');
    expect(src).toMatch(/<MessageBubble[\s\S]{0,400}isActive=\{isActive\}/);
  });

  it('the elapsed clock runs only while the job runs, in the visible tab', () => {
    const src = read('BackgroundJobBlock.tsx');
    const live = /const live =\s*([^;]+);/.exec(src)?.[1] ?? '';
    expect(live, 'the ticker gate was renamed or removed').toContain("job.status === 'running'");
    expect(live).toContain('isActive');
    // One interval, cleared, and keyed on that gate.
    expect(src).toMatch(/if \(!live\) return;[\s\S]{0,200}setInterval\(/);
    expect(src).toContain('clearInterval(id)');
    expect(src).toMatch(/\}, \[live\]\)/);
  });

  it('the block never invents an output it was not given', () => {
    // The ending edge carries a model-authored summary and an output-file path,
    // and neither crosses the runtime seam (see the runtime's rule and
    // spike-subagent c5). The block shows the spawning call and the outcome.
    const descriptor = /export interface BackgroundJob \{[\s\S]*?\n\}/.exec(
      read('backgroundJobs.ts')
    )?.[0];
    expect(descriptor, 'BackgroundJob was renamed — re-point this guard').toBeDefined();
    for (const field of ['summary', 'output_file', 'outputFile', 'outputTail']) {
      expect(descriptor, `${field} does not cross the seam`).not.toContain(field);
    }
    const src = read('BackgroundJobBlock.tsx');
    expect(src).not.toMatch(/job\.(summary|output)/);
  });
});
