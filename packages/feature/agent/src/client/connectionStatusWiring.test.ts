import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * WIRING OF THE CHAT STATUS BAR AND THE UPDATE POPUP (org-harness-sync §3.1,
 * §3.9). Source assertions, for the reason the rest of this suite gives: the
 * pieces live in different frames (project iframes vs the top window) and jsdom
 * has no layout, so what is at risk is a mount point or a message quietly
 * dropped, not a computation.
 */

const pkgs = join(__dirname, '../../../..');
const read = (rel: string) => readFileSync(join(pkgs, rel), 'utf8');

describe('the status bar sits under the composer', () => {
  const chat = read('feature/agent/src/client/Chat.tsx');
  it('is rendered right after <ChatInput …/>, and not in the selection popup', () => {
    const input = chat.indexOf('<ChatInput');
    const bar = chat.indexOf('<ConnectionStatusBar />');
    expect(input).toBeGreaterThan(0);
    expect(bar).toBeGreaterThan(input);
    expect(chat.slice(input, bar)).not.toContain('<div');
    expect(chat).toContain('{!ephemeral && <ConnectionStatusBar />}');
  });
  it('is positioned, so it paints above the composer padding it tucks into', () => {
    const bar = read('feature/agent/src/client/ConnectionStatusBar.tsx');
    expect(bar).toMatch(/className="relative flex items-center[^"]*-mt-3/);
  });
  it('always shows both items — no hide rule (the org harness is mandatory)', () => {
    const bar = read('feature/agent/src/client/ConnectionStatusBar.tsx');
    expect(bar).not.toMatch(/connectionsBarVisible|showAtlassianItem|showSkillHubItem/);
    expect(bar).toContain('if (!status) return null;');
    expect(bar).toContain('testId="connection-status-atlassian"');
    expect(bar).toContain('testId="connection-status-skillhub"');
    const view = read('feature/agent/src/client/connectionStatusView.ts');
    expect(view).not.toMatch(/export function (connectionsBarVisible|showAtlassianItem|showSkillHubItem)/);
    expect(view).not.toContain("return 'neutral'");
  });
  it('reads the shared poller and the shared sign-in, and opens Settings → Harness', () => {
    const bar = read('feature/agent/src/client/ConnectionStatusBar.tsx');
    expect(bar).toContain('useConnectionStatus()');
    expect(bar).toContain('startAtlassianLoginFlow');
    expect(bar).toContain("publishTopic(Topics.OpenSettings, { section: 'harness' })");
    expect(bar).toContain('publishTopic(Topics.OpenSettings, skillHubClick(s))');
    expect(bar).toContain('<StatusDot');
  });
  it('asks the light action, not the whole GET', () => {
    const store = read('feature/agent/src/client/connectionStatus.ts');
    expect(store).toContain("action: 'status.connections'");
    expect(store).not.toMatch(/fetch\('\/api\/naby'\s*\)/);
  });
});

describe('the Settings card and the sign-in button tell the bars', () => {
  it('the button uses the shared sign-in requests and announces the result', () => {
    const btn = read('feature/workspace/src/client/AtlassianLoginButton.tsx');
    expect(btn).toContain('startAtlassianLoginFlow');
    expect(btn).toContain('cancelAtlassianLoginFlow');
    expect(btn).toContain('announceConnectionsChanged()');
    expect(btn).not.toContain("action: 'atlassian.login'");
  });
  it('the card announces after a mutation (sync, toggle, choices)', () => {
    const card = read('feature/workspace/src/client/NabyOrgHarnessSettings.tsx');
    expect(card).toContain('announceConnectionsChanged()');
    expect(card).toContain('orgUpdateLogRows(view)');
  });
  it('the announce goes both ways across frames', () => {
    const login = read('feature/agent/src/client/atlassianLogin.ts');
    expect(login).toContain('announceTopic(Topics.ConnectionsChanged');
  });
});

describe('the update popup lives in the top window', () => {
  const ws = read('feature/workspace/src/client/Workspace.tsx');
  it('Workspace mounts it and reads the global-state push', () => {
    expect(ws).toContain('<OrgUpdateToast');
    expect(ws).toContain('useOrgUpdateNotice()');
    const hook = read('feature/workspace/src/client/useOrgUpdateNotice.ts');
    expect(hook).toContain("url: '/ws/global-state'");
    expect(hook).toContain("action: 'orgHarness.ackUpdate'");
  });
  it('"Details" acks and opens Settings on the Harness section', () => {
    expect(ws).toContain("openSettings('harness')");
    const modal = read('feature/workspace/src/client/SettingsModal.tsx');
    expect(modal).toContain('requestedSection');
  });
  it('OPEN_SETTINGS honours a requested section', () => {
    expect(ws).toMatch(/OPEN_SETTINGS[\s\S]{0,200}event\.data\.section/);
  });
  it('a requested focus reaches the Skill Hub key row in Connections', () => {
    expect(ws).toMatch(/OPEN_SETTINGS[\s\S]{0,300}event\.data\.focus/);
    const modal = read('feature/workspace/src/client/SettingsModal.tsx');
    expect(modal).toContain('requestSettingsFocus(anchor)');
    expect(modal).toContain('clearSettingsFocus()');
    expect(modal).not.toMatch(/setInterval/);
    const focus = read('feature/workspace/src/client/settingsFocus.ts');
    expect(focus).toContain('[data-settings-anchor=');
    expect(focus).toContain('scrollIntoView');
    const rows = read('feature/workspace/src/client/NabyProviderSetup.tsx');
    expect(rows).toContain('data-settings-anchor={`system-mcp:${preset.name}`}');
    expect(rows).toContain('claimSettingsFocus(`system-mcp:${preset.name}`, rowRef.current)');
  });
  it('the popup does not auto-dismiss (once per version must be seen)', () => {
    const toast = read('feature/agent/src/client/OrgUpdateToast.tsx');
    expect(toast).not.toContain('setTimeout');
  });
});

describe('the push carries the notice from every sender', () => {
  it('the watcher push and the route push both include orgUpdate', () => {
    const shell = join(pkgs, '..');
    const handler = readFileSync(join(shell, 'src/lib/effect/globalStateHandler.ts'), 'utf8');
    const route = readFileSync(join(shell, 'src/app/api/global-state/route.ts'), 'utf8');
    expect(handler).toContain('data: { sessions, orgUpdate }');
    expect(route).toContain('data: { sessions, orgUpdate }');
  });
});

describe('one StatusDot, one set of colors', () => {
  it('RunningJobsIndicator uses the shared dot, not a private copy', () => {
    const jobs = read('feature/workspace/src/client/RunningJobsIndicator.tsx');
    expect(jobs).toContain("from '@cockpit/shared-ui'");
    expect(jobs).not.toMatch(/function StatusDot/);
    expect(jobs).not.toContain('bg-emerald-500');
  });
  it('the success and warning tokens exist in both themes and are registered', () => {
    const css = readFileSync(join(pkgs, '..', 'src/app/globals.css'), 'utf8');
    expect(css.match(/--success: var\(--green-9\);/g)?.length).toBe(2);
    expect(css.match(/--warning: var\(--amber-9\);/g)?.length).toBe(2);
    expect(css).toContain('--color-success: hsl(var(--success));');
    expect(css).toContain('--color-warning: hsl(var(--warning));');
  });
});
