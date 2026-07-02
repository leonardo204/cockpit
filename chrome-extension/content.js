/**
 * Cockpit Bridge - Content Script
 *
 * Injected into all pages (including inside iframes), but only activates in iframes directly owned by Cockpit.
 *
 * Features:
 * 1. Intercept target="_blank" link clicks → postMessage notifies the parent page to create a new bubble
 * 2. Override window.open → postMessage notifies the parent page to create a new bubble
 * 3. Watch page URL changes (pushState/replaceState/popstate) → notify the parent page to update the current bubble's URL
 *
 * How Cockpit iframes are identified:
 * BrowserBubble appends a _cockpit=1 parameter to the iframe src,
 * a static DNR rule strips that parameter at the network layer (the server never sees it),
 * background records frames carrying _cockpit=1 via webNavigation.onBeforeNavigate,
 * and the content script confirms its identity by querying background with a check-frame message.
 *
 * How cookies are pre-injected:
 * BrowserBubble calls background's prepare-iframe directly via externally_connectable;
 * once the await returns, the cookie rules are ready, and only then is the iframe src set. No timing race.
 */

(function () {
  'use strict';

  const LOG_PREFIX = '[Cockpit Bridge]';

  // ====================================================================
  // Top-level page: expose the extension ID only on Cockpit pages (for externally_connectable to use)
  // ====================================================================
  if (window === window.top) {
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(window.location.origin)) {
      // Expose the extension ID via DOM attributes (CSP-safe, no inline script needed)
      const id = chrome.runtime.id;
      const version = (() => { try { return chrome.runtime.getManifest().version; } catch { return 'unknown'; } })();

      // Expose bridge info via a <meta> tag (DOM is shared across isolated worlds)
      // Do not modify <html> attributes, to avoid React hydration mismatch
      function injectBridgeMeta() {
        const head = document.head || document.documentElement;
        const meta = document.createElement('meta');
        meta.name = 'cockpit-bridge';
        meta.dataset.id = id;
        meta.dataset.version = version;
        head.appendChild(meta);
        console.log(LOG_PREFIX, '顶层页面 bridge meta 已注入:', id);
      }
      if (document.head) {
        injectBridgeMeta();
      } else {
        document.addEventListener('DOMContentLoaded', injectBridgeMeta, { once: true });
      }

    }
    return;
  }

  // ====================================================================
  // Inside an iframe: query background to confirm whether this is a Cockpit iframe
  // ====================================================================

  // Save a reference to the real parent (before the disguise script overrides it; the isolated world is unaffected)
  const realParent = window.parent;

  // DNR has already stripped the _cockpit=1 parameter at the network layer, so the content script cannot see it.
  // Identity is always confirmed through background's cockpitFrames tracking set.
  chrome.runtime.sendMessage({ type: 'cockpit:check-frame' }, (response) => {
    if (chrome.runtime.lastError) return; // Extension not ready yet, ignore
    if (response?.isCockpit) {
      activateCockpitBridge();
    }
  });

  // ====================================================================
  // Bridge activation logic
  // ====================================================================
  function activateCockpitBridge() {
    console.log(LOG_PREFIX,
      `Cockpit iframe 激活: ${window.location.href}\n` +
      `  ├─ 伪装: window.top/parent/frameElement 已覆盖\n` +
      `  ├─ 拦截: target="_blank" 链接、window.open → 新气泡\n` +
      `  ├─ 监听: pushState/replaceState/popstate → URL 同步\n` +
      `  └─ Cookie: 由 externally_connectable 预注入，无时序竞争`
    );

    // ----------------------------------------------------------------
    // 0a. Disguise as the top-level window (inject an external script into the main world, bypassing CSP)
    //     CSP allows chrome-extension:// origins, so an external script is used instead of an inline one
    // ----------------------------------------------------------------
    const disguiseScript = document.createElement('script');
    disguiseScript.src = chrome.runtime.getURL('disguise.js');
    (document.documentElement || document).prepend(disguiseScript);
    disguiseScript.onload = () => disguiseScript.remove();

    // Inject network interception into the Main World (must run before any page scripts)
    const networkScript = document.createElement('script');
    networkScript.src = chrome.runtime.getURL('network-capture.js');
    (document.documentElement || document).prepend(networkScript);
    networkScript.onload = () => networkScript.remove();

    // ----------------------------------------------------------------
    // 1. Supplemental cookie injection: the domain may change after SPA navigation, so notify background to add rules
    //    Cookies for the initial load were already pre-injected via externally_connectable
    // ----------------------------------------------------------------

    const COCKPIT_MSG_PREFIX = 'cockpit:';

    // ----------------------------------------------------------------
    // 2. Send messages to the parent page (using the saved real parent reference)
    // ----------------------------------------------------------------
    function notifyParent(type, data) {
      try {
        const msg = { type: COCKPIT_MSG_PREFIX + type, ...data };
        realParent.postMessage(msg, '*');
        console.log(LOG_PREFIX, '→ postMessage', type, data);
      } catch (e) {
        console.warn(LOG_PREFIX, 'postMessage 失败', e);
      }
    }

    // ----------------------------------------------------------------
    // 3. Intercept <a target="_blank"> clicks
    // ----------------------------------------------------------------
    document.addEventListener(
      'click',
      function (e) {
        let anchor = e.target;
        while (anchor && anchor.tagName !== 'A') {
          anchor = anchor.parentElement;
        }
        if (!anchor) return;

        const href = anchor.href;
        if (!href || href.startsWith('javascript:') || href.startsWith('#')) return;

        const target = anchor.target;
        if (target === '_blank' || (target && target !== '_self' && target !== '_top' && target !== '_parent')) {
          e.preventDefault();
          e.stopPropagation();
          console.log(LOG_PREFIX, '拦截新标签链接:', href);
          notifyParent('new-tab', { url: href });
        }
      },
      true,
    );

    // ----------------------------------------------------------------
    // 4. Override window.open → intercept and notify
    // ----------------------------------------------------------------
    const originalOpen = window.open;
    window.open = function (url, target, features) {
      if (url) {
        let absoluteUrl;
        try {
          absoluteUrl = new URL(url, window.location.href).href;
        } catch {
          absoluteUrl = url;
        }
        console.log(LOG_PREFIX, '拦截 window.open:', absoluteUrl);
        notifyParent('new-tab', { url: absoluteUrl });
        return null;
      }
      return originalOpen.call(this, url, target, features);
    };

    // ----------------------------------------------------------------
    // 5. Watch in-page navigation (SPA pushState / replaceState / popstate)
    // ----------------------------------------------------------------
    let lastUrl = window.location.href;

    function checkUrlChange() {
      const currentUrl = window.location.href;
      if (currentUrl !== lastUrl) {
        console.log(LOG_PREFIX, 'URL 变化:', lastUrl, '→', currentUrl);
        lastUrl = currentUrl;
        notifyParent('navigate', { url: currentUrl });
        // Re-inject cookies when the URL changes (cookies may differ per domain or path)
        try {
          chrome.runtime.sendMessage({ type: 'cockpit:inject-cookies', url: currentUrl });
        } catch (e) { /* ignore */ }
      }
    }

    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function (...args) {
      originalPushState.apply(this, args);
      checkUrlChange();
    };

    history.replaceState = function (...args) {
      originalReplaceState.apply(this, args);
      checkUrlChange();
    };

    window.addEventListener('popstate', checkUrlChange);
    window.addEventListener('hashchange', checkUrlChange);

    // ----------------------------------------------------------------
    // 6. Notify the current URL once the page has finished loading
    // ----------------------------------------------------------------
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        notifyParent('loaded', { url: window.location.href });
      });
    } else {
      notifyParent('loaded', { url: window.location.href });
    }

    // ----------------------------------------------------------------
    // 7. Load the automation layer (automation.js) for CLI control
    //    Loaded via import() in the isolated world (keeps chrome.runtime access)
    //    automation.js listens for cockpit:cmd postMessages, performs DOM operations, and returns results
    // ----------------------------------------------------------------
    import(chrome.runtime.getURL('automation.js'))
      .then(mod => {
        if (mod.initAutomation) {
          mod.initAutomation(realParent, chrome);
          console.log(LOG_PREFIX, 'Automation layer activated (isolated world)');
        }
      })
      .catch(e => console.warn(LOG_PREFIX, 'Failed to load automation layer:', e));
  }
})();
