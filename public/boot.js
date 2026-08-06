// Runs before React hydrates (see app/layout.tsx <Script strategy="beforeInteractive">).
// Three jobs:
//   1. Redirect narrow viewports to the mobile route /m (before first paint).
//   2. Apply the persisted theme class to <html> before first paint to avoid FOUC.
//   3. Unregister any leftover Service Workers from the PWA era (PWA has been removed).
(function () {
  // Mobile redirect — runs first and bails out the rest on redirect.
  // Signal is VIEWPORT WIDTH (not User-Agent): it's what actually decides whether the
  // desktop 3-panel layout fits. Runs synchronously in <head> before the body paints,
  // so the desktop UI never flashes. Escape hatch: the /m "use desktop" action sets
  // `cockpit-force-desktop` in localStorage, which suppresses the redirect thereafter.
  try {
    var path = window.location.pathname;
    var onMobileRoute = path === '/m' || path.indexOf('/m/') === 0;
    var forceDesktop = false;
    try { forceDesktop = !!localStorage.getItem('cockpit-force-desktop'); } catch (_e) {}
    // Never redirect inside an iframe: the desktop shell embeds /project in a
    // frame that is 42px (sidebar) narrower than the window, so a tablet-width
    // top page (e.g. 768px iPad) would otherwise nest the mobile UI inside the
    // desktop shell — and drop the sessionId in the process. The media query is
    // only meaningful for the top-level viewport.
    var isTopWindow = true;
    try { isTopWindow = window.self === window.top; } catch (_e) {}
    if (
      isTopWindow &&
      !onMobileRoute &&
      !forceDesktop &&
      window.matchMedia &&
      window.matchMedia('(max-width: 767px)').matches
    ) {
      window.location.replace('/m' + window.location.search);
      return; // stop further boot work; the page is navigating away
    }
  } catch (_e) {}

  try {
    // Theme precedence: localStorage → server-persisted value → 'dark'.
    //
    // The server value (`window.__cockpitServerTheme`, injected immediately
    // before this script by app/layout.tsx — see shared-utils/bootTheme.ts)
    // exists because the desktop shell boots Next on an EPHEMERAL PORT, and
    // localStorage is per-origin INCLUDING the port: every restart hands us an
    // empty store. localStorage still wins when it has a value — within a
    // session it is the newer of the two writes.
    var stored = null;
    try { stored = localStorage.getItem('theme'); } catch (_e) {}
    var theme = stored || window.__cockpitServerTheme || 'dark';
    var resolved = theme;
    if (theme === 'system') {
      resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.classList.add(resolved);
  } catch (_e) {}

  try {
    // FONTS — the same story as the theme, one preference later (see
    // shared-utils/fontSettings.ts). The four custom properties are applied to
    // <html> HERE, before first paint, so the app never renders one frame in the
    // default face/size and then snaps to the user's.
    //
    // WHAT IS READ IS ALREADY DERIVED. localStorage holds `{settings, vars}` and
    // the server injects `vars` only, so this file carries no font-stack table
    // of its own — the presets are defined once, in TypeScript, where they are
    // unit-tested. Precedence matches the theme's: localStorage (the newer write
    // within a session) → the server value (what survives the port change) →
    // nothing at all, which leaves the defaults declared in globals.css.
    var KEYS = ['--app-font-sans', '--app-font-mono', '--app-font-scale', '--chat-text-scale'];
    var vars = null;
    try {
      var rawFonts = localStorage.getItem('fonts');
      if (rawFonts) vars = (JSON.parse(rawFonts) || {}).vars || null;
    } catch (_e) {}
    if (!vars) vars = window.__cockpitServerFontVars || null;
    if (vars) {
      for (var i = 0; i < KEYS.length; i++) {
        var v = vars[KEYS[i]];
        // Whitelisted names only: a corrupt or hand-written storage entry can
        // set these four properties and nothing else.
        if (typeof v === 'string' && v) document.documentElement.style.setProperty(KEYS[i], v);
      }
    }
  } catch (_e) {}

  // Clean up legacy Service Workers from the old PWA era, but KEEP our
  // push-only SW (/push-sw.js) — it powers Web Push notifications and does no
  // caching, so it doesn't reintroduce the offline behavior we removed.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(function (regs) {
      regs.forEach(function (r) {
        var url = (r.active && r.active.scriptURL) || '';
        if (url.indexOf('/push-sw.js') === -1) r.unregister();
      });
    });
  }
})();
