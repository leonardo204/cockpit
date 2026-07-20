#!/usr/bin/env node

import { hasClaudeBinary } from '../scripts/claudeBinary.mjs';


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

// A node-pty spawn-helper chmod used to run here. node-pty was only ever needed by the
// PTY execution mode, which has been removed along with its dependency.

// F1-03 chat-first trim: postinstall used to stage two things into ~/.cockpit/
// for npm installs — chrome-extension/ (the browser bridge for feature-console's
// browser bubbles) and kernels/jupyter_bridge.py (feature-console's Jupyter
// bubbles). Both features are deleted, so both source trees are gone and there
// is nothing left to stage.
