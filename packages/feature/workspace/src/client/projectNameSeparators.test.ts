// Guards the Windows sidebar bug: a project name derived with `cwd.split('/')`
// shows the WHOLE path on Windows, where cwds use `\`. Every client place that
// turns a cwd into a project name goes through `projectNameFromCwd`, which
// splits on either separator. jsdom cannot tell these apart at render time, so
// the guard is a source assertion plus the helper's own behaviour.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectNameFromCwd } from '@cockpit/shared-utils';

const FEATURE = join(__dirname, '..', '..', '..');
const FILES = [
  'workspace/src/client/ProjectSidebar.tsx',
  'workspace/src/client/EmptyState.tsx',
  'workspace/src/client/sessionDoneNotify.ts',
  'agent/src/client/ScheduledTasksPanel.tsx',
  'agent/src/client/GlobalSessionMonitor.tsx',
  'agent/src/client/RecentSessionsModal.tsx',
  'agent/src/client/PinnedSessionsPanel.tsx',
  'agent/src/client/mobile/MobileChat.tsx',
  'agent/src/client/mobile/MobileSessionList.tsx',
];

describe('project names from cwds', () => {
  it('names a Windows cwd by its folder, like a POSIX one', () => {
    expect(projectNameFromCwd('C:\\Users\\me\\work\\naby')).toBe('naby');
    expect(projectNameFromCwd('C:\\Users\\me\\work\\naby\\')).toBe('naby');
    expect(projectNameFromCwd('/Users/me/work/naby')).toBe('naby');
  });

  it.each(FILES)('%s derives project names through projectNameFromCwd', (file) => {
    const src = readFileSync(join(FEATURE, file), 'utf8');
    expect(src).toContain('projectNameFromCwd(');
    expect(src).not.toMatch(/cwd\??\.split\('\/'\)/);
  });
});
