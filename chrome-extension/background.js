/**
 * Cockpit Bridge - Background Service Worker
 *
 * iframe Cookie injection: use declarativeNetRequest dynamic rules to inject the Cookie header at the network layer
 * Does not modify the global cookie store; only adds the Cookie at the request level
 */

// =========================================================================
// iframe Cookie injection
//
// Idea: cross-site requests from an iframe do not carry SameSite=Lax cookies.
// Use chrome.cookies.getAll to read all cookies for the target domain,
// then set the Cookie request header at the network layer via declarativeNetRequest dynamic rules.
// The cookie store is not modified; only request headers are affected.
//
// The dynamic rules use requestDomains to scope the domain, tabIds to scope the Cockpit tab,
// and resourceTypes to cover sub_frame + sub-resources (XHR/script/css/image, etc.).
// =========================================================================

// On startup, clean up session rules left over from last time (after the extension reloads, the in-memory map is lost but the rules are still in effect)
chrome.declarativeNetRequest.getSessionRules().then(rules => {
  if (rules.length) {
    const ids = rules.map(r => r.id);
    chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
    console.log(`[Cockpit Bridge] 启动清理: 移除 ${ids.length} 条残留 session 规则`);
  }
});

// =========================================================================
// Cockpit iframe tracking + cookie injection ordering guarantee
//
// Two-layer guarantee mechanism:
//   Layer 1: externally_connectable (BrowserBubble → background direct connection)
//     → the iframe src is only set after `await prepareCookies()` returns
//     → cookie rules are 100% ready before the first request
//
//   Layer 2: webNavigation.onBeforeNavigate (fallback + frame tracking)
//     → records frames carrying _cockpit=1, for content script check-frame queries
//     → also triggers injectCookiesForUrl as a fallback (refresh scenarios, etc.)
//
// DNR static rule #3 strips the _cockpit=1 parameter at the network layer, so the server never sees it.
// =========================================================================
const cockpitFrames = new Set(); // "tabId-frameId"

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  // Only care about iframes (frameId > 0)
  if (details.frameId === 0) return;

  const key = `${details.tabId}-${details.frameId}`;

  if (details.url.includes('_cockpit=1')) {
    cockpitFrames.add(key);

    // Fallback injection: only triggers when externally_connectable has not pre-created the rules
    // Avoids duplicate injectCookiesForUrl calls causing a gap of "delete old rules first → asynchronously create new rules"
    try {
      const domain = new URL(details.url).hostname;
      const ruleKey = `${domain}:${details.tabId || 'all'}`;
      if (domainRuleMap.has(ruleKey)) {
        console.log(`[Cockpit Bridge] 追踪 frame: ${key}, Cookie 规则已由 prepare-iframe 创建，跳过`);
      } else {
        console.log(`[Cockpit Bridge] 追踪 frame: ${key}, 兜底创建 Cookie 规则`);
        injectCookiesForUrl(details.url, details.tabId);
      }
    } catch {
      injectCookiesForUrl(details.url, details.tabId);
    }
  }
});

// When a tab is closed, clean up all records for that tab
chrome.tabs.onRemoved.addListener((tabId) => {
  for (const key of cockpitFrames) {
    if (key.startsWith(`${tabId}-`)) {
      cockpitFrames.delete(key);
    }
  }
});

// Map of domains that already have injected cookies → list of rule IDs
let nextRuleId = 1000;
const domainRuleMap = new Map(); // "domain:tabId" → [ruleId, ruleId]


async function injectCookiesForUrl(url, tabId) {
  try {
    const urlObj = new URL(url);
    const domain = urlObj.hostname;
    const key = `${domain}:${tabId || 'all'}`;

    // If rules already exist, clean them up first
    if (domainRuleMap.has(key)) {
      const oldIds = domainRuleMap.get(key);
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: oldIds,
      });
    }

    // Read cookies for this domain and all of its parent domains
    // e.g. api.github.com needs to collect:
    //   domain=api.github.com  (exact match)
    //   domain=.github.com     (parent domain, obtained via getAll({ domain: 'github.com' }))
    //   domain=.com is not needed (public suffix, and it cannot have cookies anyway)
    const domainParts = domain.split('.');
    const domainsToQuery = [];
    for (let i = 0; i < domainParts.length - 1; i++) {
      domainsToQuery.push(domainParts.slice(i).join('.'));
    }
    // Collect all cookies with deduplication
    const cookieMap = new Map(); // name+domain+path → cookie (deduplicated)
    for (const d of domainsToQuery) {
      const result = await chrome.cookies.getAll({ domain: d });
      for (const c of result) {
        // Verify the cookie's domain actually matches the current domain
        // .github.com matches api.github.com ✓
        // .example.com does not match api.github.com ✗
        const cookieDomain = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
        if (domain === cookieDomain || domain.endsWith('.' + cookieDomain)) {
          cookieMap.set(`${c.name}|${c.domain}|${c.path}`, c);
        }
      }
    }
    const cookies = Array.from(cookieMap.values());
    if (!cookies.length) {
      console.log(`[Cockpit Bridge] ${domain}: 无 Cookie，不注入`);
      return;
    }

    // Filter for cookies blocked by the browser (Lax/Strict/unset)
    // The browser only auto-sends SameSite=None cookies; the rest we need to append ourselves
    // Using append does not override the None versions the browser sends; same-name cookies coexisting is equivalent to a normal top-level visit
    const blockedCookies = cookies.filter(c => c.sameSite !== 'none');

    if (!blockedCookies.length) {
      console.log(`[Cockpit Bridge] ${domain}: 全部 ${cookies.length} 条 Cookie 均为 SameSite=None（浏览器自动发送），不注入`);
      return;
    }

    // Group cookies by their effective domain
    // Cookies for .google.com → requestDomains: ['google.com'] (covers accounts.google.com and all other subdomains)
    // Cookies for console.cloud.google.com → requestDomains: ['console.cloud.google.com']
    const domainGroups = new Map(); // effectiveDomain → [cookie, ...]
    for (const c of blockedCookies) {
      const effectiveDomain = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
      if (!domainGroups.has(effectiveDomain)) {
        domainGroups.set(effectiveDomain, []);
      }
      domainGroups.get(effectiveDomain).push(c);
    }

    const SUB_RESOURCE_TYPES = [
      'xmlhttprequest', 'script', 'stylesheet', 'image',
      'font', 'media', 'websocket', 'other',
    ];

    const ruleIds = [];
    const logLines = [];

    for (const [effectiveDomain, groupCookies] of domainGroups) {
      const cookieStr = groupCookies.map(c => `${c.name}=${c.value}`).join('; ');

      const cookieAction = {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Cookie', operation: 'append', value: cookieStr },
        ],
      };

      // Rule A: sub_frame (iframe document load)
      const ruleIdA = nextRuleId++;
      const conditionA = {
        requestDomains: [effectiveDomain],
        resourceTypes: ['sub_frame'],
      };

      // Rule B: sub-resources (XHR/script/css etc., only those initiated inside the iframe)
      const ruleIdB = nextRuleId++;
      const conditionB = {
        requestDomains: [effectiveDomain],
        resourceTypes: SUB_RESOURCE_TYPES,
        excludedInitiatorDomains: ['localhost', '127.0.0.1'],
      };

      if (tabId) {
        conditionA.tabIds = [tabId];
        conditionB.tabIds = [tabId];
      }

      ruleIds.push(ruleIdA, ruleIdB);

      await chrome.declarativeNetRequest.updateSessionRules({
        addRules: [
          { id: ruleIdA, priority: 2, action: cookieAction, condition: conditionA },
          { id: ruleIdB, priority: 2, action: cookieAction, condition: conditionB },
        ],
      });

      logLines.push(`  ├─ ${effectiveDomain}: ${groupCookies.length} 条 Cookie (覆盖所有子域名)`);
    }

    domainRuleMap.set(key, ruleIds);

    const noneCount = cookies.filter(c => c.sameSite === 'none').length;
    console.log(`[Cockpit Bridge] ${domain}: Cookie 注入规则已创建 (tab=${tabId || 'all'})\n` +
      `  ├─ 追加: ${blockedCookies.length} 条 (Lax/Strict/未设置), 分 ${domainGroups.size} 个域名组\n` +
      logLines.join('\n') + '\n' +
      `  ├─ 浏览器自动发送: ${noneCount} 条 SameSite=None\n` +
      `  └─ 范围: 仅 Cockpit 标签页，不影响其他标签页`
    );
  } catch (e) {
    console.warn('[Cockpit Bridge] Cookie 注入失败:', e);
  }
}

// Listen for messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'cockpit:reload') {
    chrome.runtime.reload();
    return;
  }

  if (message.type === 'cockpit:inject-cookies') {
    const tabId = sender.tab ? sender.tab.id : null;
    injectCookiesForUrl(message.url, tabId).then(() => sendResponse({ ok: true }));
    return true;
  }

  // content script asks whether the current frame is a Cockpit iframe (handles redirect scenarios)
  if (message.type === 'cockpit:check-frame') {
    const key = `${sender.tab?.id}-${sender.frameId}`;
    const isCockpit = cockpitFrames.has(key);
    console.log(`[Cockpit Bridge] check-frame: ${key} → ${isCockpit}`);
    sendResponse({ isCockpit });
    return;
  }

  // evaluate: run JS in the main world (bypasses the page's CSP restrictions)
  // allFrames: true → execute in all frames (solves the cross-origin iframe access problem)
  if (message.type === 'cockpit:evaluate') {
    const tabId = sender.tab?.id;
    const frameId = sender.frameId ?? 0;
    if (!tabId) {
      sendResponse({ ok: false, error: 'No tab ID available' });
      return;
    }
    const target = message.allFrames
      ? { tabId, allFrames: true }
      : { tabId, frameIds: [frameId] };
    chrome.scripting.executeScript({
      target,
      world: 'MAIN',
      func: async (code) => {
        // Chrome extension messaging has an implicit ~8 KiB truncation point at
        // sendResponse's structured clone boundary (reproduced in session 6910d071
        // where evaluate output stopped exactly at 8192 bytes). To avoid large
        // results being silently truncated, we evaluate the result in the MAIN
        // world first; if the serialized form is > CHUNK_THRESHOLD, we stash the
        // full payload in a Map on the page's window and only return a descriptor
        // to the upper layer. The cock-browser CLI recognizes this descriptor and
        // reads it in chunks via the evaluate_chunk action, reassembling the full
        // content — transparent to the caller.
        const CHUNK_THRESHOLD = 6000;

        const maybeChunk = (data) => {
          let serialized;
          const isString = typeof data === 'string';
          try {
            serialized = isString
              ? data
              : (data === null || data === undefined)
                ? ''
                : JSON.stringify(data);
          } catch {
            // Not serializable (circular references, etc.) — return as-is and let the upper layer handle it via the original path
            return { ok: true, data };
          }
          if (!serialized || serialized.length <= CHUNK_THRESHOLD) {
            return { ok: true, data };
          }
          const W = window;
          if (!W.__cockpit_eval_stash_v1__) W.__cockpit_eval_stash_v1__ = new Map();
          const stash = W.__cockpit_eval_stash_v1__;
          // 10 min GC: prevents large payloads from piling up on long-lived session pages
          const cutoff = Date.now() - 10 * 60 * 1000;
          for (const [k, v] of stash) {
            if (v.created < cutoff) stash.delete(k);
          }
          const token =
            'ck-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
          stash.set(token, { payload: serialized, isString, created: Date.now() });
          return {
            ok: true,
            data: {
              __cockpit_chunked: true,
              token,
              totalBytes: serialized.length,
              isString,
            },
          };
        };

        // Layer 1: direct eval — covers expressions, multiple statements, IIFEs, template literals, etc.
        // eval automatically returns the value of the last expression (similar to CDP replMode)
        try {
          const result = (0, eval)(code);
          const data = result instanceof Promise ? await result : result;
          return maybeChunk(data);
        } catch (e1) {
          // Layer 2: AsyncFunction fallback — covers code containing top-level await
          try {
            const AF = Object.getPrototypeOf(async function(){}).constructor;
            const data = await new AF(code)();
            return maybeChunk(data);
          } catch {
            return { ok: false, error: e1.message };
          }
        }
      },
      args: [message.js],
    })
      .then(results => {
        if (message.allFrames) {
          // Multiple frames: collect all non-undefined results
          const all = (results || [])
            .map((r, i) => ({ frameId: r.frameId, ...r.result }))
            .filter(r => r.ok && r.data !== undefined);
          sendResponse({ ok: true, data: all.length === 1 ? all[0].data : all });
        } else {
          const r = results?.[0]?.result;
          if (r?.ok) sendResponse({ ok: true, data: r.data });
          else sendResponse({ ok: false, error: r?.error || 'Execution failed' });
        }
      })
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true; // async sendResponse
  }

  // Screenshot: automation.js requests a capture of the current tab's visible area
  if (message.type === 'cockpit:capture-tab') {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: 'No tab ID available' });
      return;
    }
    chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' })
      .then(dataUrl => sendResponse({ ok: true, dataUrl }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true; // async sendResponse
  }

});

// =========================================================================
// externally_connectable: direct communication from the Cockpit page
//
// Before setting the iframe src, BrowserBubble directly calls
//   chrome.runtime.sendMessage(extensionId, { type: 'prepare-iframe', url })
// and waits for the cookie rules to be ready before rendering the iframe,
// completely eliminating the timing race.
// =========================================================================
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  // Security check: only accept messages from localhost
  if (!sender.url || !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(sender.url)) {
    sendResponse({ ok: false, error: 'unauthorized' });
    return;
  }

  if (message.type === 'reload') {
    console.log('[Cockpit Bridge] externally_connectable: reload requested');
    sendResponse({ ok: true });
    chrome.runtime.reload();
    return;
  }

  if (message.type === 'prepare-iframe') {
    const tabId = sender.tab ? sender.tab.id : null;
    console.log(`[Cockpit Bridge] externally_connectable: prepare-iframe url=${message.url}, tabId=${tabId}`);
    injectCookiesForUrl(message.url, tabId).then(() => {
      sendResponse({ ok: true });
    });
    return true; // async sendResponse
  }

  sendResponse({ ok: false, error: 'unknown type' });
});

// =========================================================================
// [调试] onSendHeaders = the final headers actually sent to the server, after all modifications are done
//        extraHeaders = required in order to see the Cookie header (Chrome 79+ restriction)
// =========================================================================
chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    if (details.type !== 'sub_frame') return;

    const headers = {};
    for (const h of (details.requestHeaders || [])) {
      const name = h.name.toLowerCase();
      if (name.startsWith('sec-fetch-') || name === 'cookie') {
        headers[h.name] = name === 'cookie'
          ? `${(h.value || '').length} chars`
          : h.value;
      }
    }

    console.log(`[调试] sub_frame 最终请求头:\n` +
      `  URL: ${details.url}\n` +
      `  initiator: ${details.initiator || 'none'}\n` +
      `  tabId: ${details.tabId}\n` +
      `  headers: ${JSON.stringify(headers, null, 2)}`
    );
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders', 'extraHeaders']
);
