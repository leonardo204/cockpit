#!/usr/bin/env node

import { accessSync, cpSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { hasClaudeBinary } from '../scripts/claudeBinary.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');


// Warn (don't fail) if the Claude Agent SDK's native binary didn't land — the
// chat engine needs it. npm can skip this optional platform sub-package during
// an in-place `npm i -g` upgrade; catching it here turns a mid-chat runtime
// error into an install-time hint. See scripts/claudeBinary.mjs.
try {
  if (!hasClaudeBinary()) {
    const plat = `${process.platform}-${process.arch}`;
    console.warn(`[postinstall] Warning: Claude native binary (${plat}) is missing — chat will not work.`);
    console.warn('[postinstall] Fix: npm uninstall -g @surething/cockpit && npm install -g @surething/cockpit');
  }
} catch (err) {
  console.warn('[postinstall] Claude binary check failed:', err?.message ?? err);
}

if (process.platform !== 'win32') {
  // node-pty: spawn-helper needs the executable bit
  try {
    const spawnHelper = join(
      projectRoot,
      `node_modules/node-pty/prebuilds/${process.platform}-${process.arch}/spawn-helper`,
    );
    accessSync(spawnHelper);
    execSync(`chmod +x "${spawnHelper}"`);
  } catch {}
}

// F1-03 chat-first trim: postinstall used to stage two things into ~/.cockpit/
// for npm installs — chrome-extension/ (the browser bridge for feature-console's
// browser bubbles) and kernels/jupyter_bridge.py (feature-console's Jupyter
// bubbles). Both features are deleted, so both source trees are gone and there
// is nothing left to stage.
