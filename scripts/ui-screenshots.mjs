#!/usr/bin/env node
/**
 * Look-and-feel screenshots (specs/shell-look-and-feel.md section 6.2).
 *
 * Captures the surfaces MAC-M0 restyled, in light AND dark, from a RUNNING prod
 * server (`node server.mjs`, distDir `.next-prod` — the dev server 500s on
 * `/api/naby`). Output is for a human to put beside the prototype
 * (`demo/multi-agent-chat/index.html`); no pixel diffing.
 *
 * Usage:
 *   node scripts/ui-screenshots.mjs --base http://127.0.0.1:3457 --out /tmp/shots
 *     [--themes light,dark] [--width 1440] [--height 900] [--locale ko-KR]
 *
 * Start the server against a THROWAWAY store, never the real one:
 *   HOME=<tmp> NABY_HOME=<tmp>/.naby NABY_DB_PATH=<tmp>/app.db \
 *   COCKPIT_HOME=<tmp>/.cockpit COCKPIT_NO_OPEN=1 PORT=<port> node server.mjs
 *
 * What it captures, per theme:
 *   window          the whole window with the sidebar
 *   chat            the chat column (if a session exists, its messages)
 *   bubbles         the message list only (user + naby pair, if any)
 *   approval        the tool approval card. Injected CLIENT-SIDE by dispatching
 *                   the same `naby:approval_request` window event the engine
 *                   bridge sends — nothing reaches the server, nothing is approved.
 *   settings-general, settings-naby, settings-memory
 *
 * With `--participants` (multi-agent-chat MAC-M3), also — against a store seeded
 * with at least one participant and a session holding it:
 *   mac-chat            roster in the header + participant bubble, routing hidden
 *   mac-chat-routing    the same with "show routing" on (toggled back off after)
 *   mac-roster-menu     the roster's `+` menu
 *   mac-palette         the `@` palette (participants first, outside ones greyed)
 *   mac-proposal        naby's add-a-participant card, injected client-side as a
 *                       `naby:approval_request` with source 'participant_proposal'
 *                       (nothing reaches the server, nothing is approved)
 *   mac-settings-participants, mac-editor   Settings › naby › Participants and
 *                       the editor opened on the first participant
 *
 * With `--import <file>` (MAC-M4), also — in Settings › naby › Participants:
 *   mac-import-preview  the import preview for that file (badges, decisions,
 *                       mapping table)
 *   mac-import-losses   the same, scrolled to the loss report
 *   mac-imported-card   after pressing Import: the new card with its origin badge
 * The import WRITES a participant into the store the server was started on —
 * use the throwaway store below. A second theme imports again and shows the
 * rename (`-imported`).
 *
 * A surface that is not reachable (no project open, no session) is skipped with
 * a log line, not failed: the script is a camera, not a test.
 *
 * Playwright is not a dependency of this package. The script uses a local
 * install if there is one and otherwise the global one (`npm root -g`); it never
 * installs anything.
 */
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const base = arg('base', process.env.UI_SHOTS_BASE || '');
const out = arg('out', process.env.UI_SHOTS_OUT || '');
const themes = arg('themes', 'light,dark').split(',').map((s) => s.trim()).filter(Boolean);
const width = Number(arg('width', '1440'));
const height = Number(arg('height', '900'));
const locale = arg('locale', 'ko-KR');
const participants = process.argv.includes('--participants');
const importFile = arg('import', '');

if (!base || !out) {
  console.error('usage: node scripts/ui-screenshots.mjs --base <url> --out <dir> [--themes light,dark]');
  process.exit(2);
}

function loadPlaywright() {
  const here = createRequire(import.meta.url);
  try {
    return here('playwright');
  } catch {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return createRequire(join(globalRoot, '/'))('playwright');
  }
}

const { chromium } = loadPlaywright();
mkdirSync(out, { recursive: true });

const SETTINGS_LABEL = { 'ko-KR': '설정', en: 'Settings' };
const NAV_LABEL = {
  'ko-KR': { general: '일반', naby: '나비', memory: '기억' },
  en: { general: 'General', naby: 'Naby', memory: 'Memory' },
};
const lang = locale.startsWith('ko') ? 'ko-KR' : 'en';

const settle = (page, ms = 800) => page.waitForTimeout(ms);

/** multi-agent-chat (MAC-M3) shots. `frame` hosts the chat; `page` the window. */
async function participantShots(page, frame, theme) {
  const screen = frame.locator('#chat-screen');
  if (!(await frame.locator('[data-testid="participant-roster"]').count())) {
    console.log(`[${theme}] no participant roster (no participants in the store); skipping mac-* chat shots`);
    return;
  }
  await shoot(screen, `${theme}-mac-chat`);

  const toggle = frame.locator('[data-testid="show-routing-toggle"]').first();
  if (await toggle.count()) {
    await toggle.click();
    await settle(page, 700);
    await shoot(screen, `${theme}-mac-chat-routing`);
    await toggle.click(); // leave the stored preference as it was
    await settle(page, 400);
  }

  const add = frame.locator('[data-testid="roster-add"]').first();
  if (await add.count()) {
    await add.click();
    await settle(page, 500);
    await shoot(screen, `${theme}-mac-roster-menu`);
    await page.keyboard.press('Escape');
    await settle(page, 300);
  }

  // The `@` palette: session participants first, outside ones greyed.
  const box = frame.locator('#chat-screen textarea').first();
  if (await box.count()) {
    await box.click();
    await box.fill('@');
    await settle(page, 900);
    await shoot(screen, `${theme}-mac-palette`);
    await box.fill('');
    await settle(page, 300);
  }

  await frame.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent('naby:approval_request', {
        detail: {
          approvalId: 'ui-screenshot-proposal',
          tool_name: 'participant.add',
          source: 'participant_proposal',
          input: {
            agentId: 'ui-screenshot',
            name: 'reviewer',
            displayName: '리뷰어',
            avatar: { kind: 'emoji', value: '🔍' },
            description: '코드 변경과 PR을 읽고 위험한 부분을 짚는다. 리뷰가 필요할 때 부른다.',
            reason: '사용자가 PR 리뷰를 부탁했고, 이 대화에는 리뷰어가 없어요.',
          },
        },
      }),
    );
  });
  await settle(page, 600);
  if (await frame.locator('[data-testid="participant-proposal"]').count()) {
    await shoot(screen, `${theme}-mac-proposal`);
  } else {
    console.log(`[${theme}] proposal card did not render; skipping`);
  }
  await frame.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent('naby:approval_resolved', { detail: { approvalId: 'ui-screenshot-proposal', decision: 'deny' } }),
    );
  });
  await settle(page, 400);
  if (await frame.locator('[data-testid="proposal-outcome"]').count()) {
    await shoot(screen, `${theme}-mac-proposal-declined`);
  }
}

/** Settings › naby › Participants, then the editor on the first participant. */
async function participantSettingsShots(page, theme) {
  const section = page.locator('[data-testid="participant-section"]').first();
  if (!(await section.count())) {
    console.log(`[${theme}] no participant section in settings; skipping`);
    return;
  }
  await section.scrollIntoViewIfNeeded();
  await settle(page, 500);
  await shoot(page, `${theme}-mac-settings-participants`);
  const edit = section.locator('button', { hasText: lang === 'ko-KR' ? '편집' : 'Edit' }).first();
  if (await edit.count()) {
    await edit.click();
    await settle(page, 900);
    const editor = page.locator('[data-testid="participant-editor"]').first();
    await editor.scrollIntoViewIfNeeded();
    await shoot(page, `${theme}-mac-editor`);
    // The lower sections, one screen further down.
    const lower = page.locator('[data-editor-section="guardrails"]').first();
    if (await lower.count()) {
      await lower.scrollIntoViewIfNeeded();
      await settle(page, 400);
      await shoot(page, `${theme}-mac-editor-lower`);
    }
  }
}

/** MAC-M4: Settings › naby › Participants › Import, with `importFile`. */
async function participantImportShots(page, theme) {
  const section = page.locator('[data-testid="participant-section"]').first();
  if (!(await section.count())) {
    console.log(`[${theme}] no participant section in settings; skipping import shots`);
    return;
  }
  await section.scrollIntoViewIfNeeded();
  const open = page.locator('[data-testid="participant-import"]').first();
  if (!(await open.count())) {
    console.log(`[${theme}] no import button; skipping import shots`);
    return;
  }
  await open.click();
  await settle(page, 600);
  await page.locator('[data-testid="participant-import-picker"] input[type="file"]').first().setInputFiles(importFile);
  const preview = page.locator('[data-testid="participant-import-preview"]').first();
  try {
    await preview.waitFor({ timeout: 15000 });
  } catch {
    console.log(`[${theme}] import preview did not render; skipping`);
    return;
  }
  await preview.scrollIntoViewIfNeeded();
  await preview.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await settle(page, 600);
  await shoot(page, `${theme}-mac-import-preview`);
  const losses = page.locator('[data-testid="import-losses"]').first();
  await losses.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await settle(page, 400);
  await shoot(page, `${theme}-mac-import-losses`);
  await page.locator('[data-testid="import-confirm"]').first().click();
  const badge = page.locator('[data-testid="participant-origin"]').last();
  try {
    await badge.waitFor({ timeout: 15000 });
  } catch {
    console.log(`[${theme}] imported card did not appear; skipping`);
    return;
  }
  await badge.evaluate((el) => el.closest('[data-participant-card]')?.scrollIntoView({ block: 'center' }));
  await settle(page, 900);
  await shoot(page, `${theme}-mac-imported-card`);
}

/** The frame that hosts the chat (the desktop shell embeds `/project` in an iframe). */
async function chatFrame(page) {
  for (const f of page.frames()) {
    if (await f.locator('#chat-screen').count().catch(() => 0)) return f;
  }
  return null;
}

async function shoot(target, name) {
  const file = join(out, `${name}.png`);
  await target.screenshot({ path: file });
  console.log(`saved ${file}`);
}

async function runTheme(browser, theme) {
  const ctx = await browser.newContext({ viewport: { width, height }, locale, colorScheme: theme });
  // boot.js reads `theme` from localStorage before first paint; seeding it is
  // the same thing the settings tile does, minus the server write.
  await ctx.addInitScript((t) => {
    try {
      localStorage.setItem('theme', t);
    } catch {
      /* storage blocked: the server value decides */
    }
  }, theme);
  const page = await ctx.newPage();
  await page.goto(base, { waitUntil: 'networkidle' });
  await settle(page, 1200);

  // Open the most recent session, if the sidebar lists one.
  const row = page.locator('[data-testid="sidebar-session-row"]').first();
  if (await row.count()) {
    await row.click();
    await page.waitForLoadState('networkidle');
    await settle(page, 2500);
  } else {
    console.log(`[${theme}] no session in the sidebar; chat shots show the empty state`);
  }

  await shoot(page, `${theme}-window`);

  const frame = await chatFrame(page);
  if (frame) {
    await shoot(frame.locator('#chat-screen'), `${theme}-chat`);
    const roles = frame.locator('[data-role]');
    if (await roles.count()) {
      // The scroll container that holds the bubbles.
      const list = frame.locator('#chat-screen .overflow-y-auto').first();
      await shoot((await list.count()) ? list : frame.locator('#chat-screen'), `${theme}-bubbles`);
    } else {
      console.log(`[${theme}] no messages; skipping bubbles`);
    }

    // Approval card — a client-side event only (see header).
    await frame.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent('naby:approval_request', {
          detail: {
            approvalId: 'ui-screenshot-approval',
            tool_name: 'Bash',
            input: { command: 'git status --short' },
          },
        }),
      );
    });
    await settle(page, 600);
    const card = frame.locator('[data-testid="tool-approval"]');
    if (await card.count()) {
      await shoot(frame.locator('#chat-screen'), `${theme}-approval`);
      await shoot(card, `${theme}-approval-card`);
      await frame.evaluate(() => {
        window.dispatchEvent(
          new CustomEvent('naby:approval_resolved', { detail: { approvalId: 'ui-screenshot-approval' } }),
        );
      });
    } else {
      console.log(`[${theme}] approval card did not render; skipping`);
    }
    if (participants) await participantShots(page, frame, theme);
  } else {
    console.log(`[${theme}] no chat frame (no project open); skipping chat, bubbles, approval`);
  }

  // Settings modal.
  const opener = page.locator(`[title="${SETTINGS_LABEL[lang] ?? SETTINGS_LABEL.en}"]`).first();
  if (await opener.count()) {
    await opener.click();
    await settle(page, 1000);
    for (const [key, label] of Object.entries(NAV_LABEL[lang] ?? NAV_LABEL.en)) {
      const tab = page.locator('nav button', { hasText: label }).first();
      if (!(await tab.count())) {
        console.log(`[${theme}] settings tab "${label}" not found; skipping`);
        continue;
      }
      await tab.click();
      await settle(page, 1200);
      await shoot(page, `${theme}-settings-${key}`);
      if (importFile && key === 'naby') await participantImportShots(page, theme);
      if (participants && key === 'naby') await participantSettingsShots(page, theme);
    }
    await page.keyboard.press('Escape');
  } else {
    console.log(`[${theme}] settings opener not found; skipping settings`);
  }

  await ctx.close();
}

const browser = await chromium.launch();
try {
  for (const theme of themes) await runTheme(browser, theme);
} finally {
  await browser.close();
}
