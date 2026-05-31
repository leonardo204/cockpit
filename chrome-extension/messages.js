/**
 * Extension-side error templates.
 *
 * Used by automation.js. Generated strings are returned to the CLI as
 * `data.error` and printed verbatim — so they MUST be self-contained and
 * include actionable next steps with generic examples (no case-specific
 * selectors or API paths).
 *
 * The CLI side has its own copy in bin/cock-browser.messages.mjs; this file
 * stays in sync manually (only ~3 templates here, drift risk is low).
 */

const EXAMPLES = Object.freeze({
  selectorSubmit: 'button[type="submit"]',
  selectorAriaSave: 'button[aria-label="Save"]',
  textSignIn: 'Sign in',
  textSave: 'Save',
});

function staleRefMsg(ref, currentEpoch, kind) {
  return `Element ref "${ref}" is stale (current snapshot v=${currentEpoch}; kind: ${kind}).
  Refs are valid only until the next snapshot / re-render / route change.
  Fix one of:
    1. Re-run \`snapshot\` to get fresh refs (look for v=${currentEpoch} in the banner).
    2. Use a CSS selector or visible text directly:
       cockpit browser <id> click --text "${EXAMPLES.textSignIn}"
       cockpit browser <id> click --selector '${EXAMPLES.selectorSubmit}'
    3. Drop to evaluate:
       cockpit browser <id> evaluate "(() => document.querySelector('${EXAMPLES.selectorAriaSave}').click())()"`;
}

function unknownActionMsg(action, suggestions) {
  const hint = suggestions && suggestions.length
    ? `\n  Did you mean: ${suggestions.join(', ')}?`
    : '';
  return `Unknown action "${action}".${hint}
  Run: cockpit browser --help-all`;
}

// Expose on globalThis so automation.js (loaded as module) can use them
// without an explicit import path that differs by build mode.
if (typeof window !== 'undefined') {
  window.__cockpitBrowserMessages = { staleRefMsg, unknownActionMsg, EXAMPLES };
}
export { staleRefMsg, unknownActionMsg, EXAMPLES };
