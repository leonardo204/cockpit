/**
 * Disguise as the top-level window (injected into the iframe's main world)
 * so the site's JS cannot detect that it is running inside an iframe.
 *
 * Loaded by content.js via <script src="chrome-extension://xxx/disguise.js">,
 * bypassing CSP restrictions on inline scripts.
 */
(function () {
  try {
    Object.defineProperty(window, 'top', { get: function () { return window; } });
    Object.defineProperty(window, 'parent', { get: function () { return window; } });
    Object.defineProperty(window, 'frameElement', { get: function () { return null; } });
  } catch (e) { /* ignore */ }
})();
