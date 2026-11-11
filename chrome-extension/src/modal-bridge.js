// Bridges dropped File trees from any AEM Assets View frame into the App Builder
// Guided Upload modal iframe and triggers opening the modal on drop.
(() => {
  'use strict';
  if (globalThis.__guModalBridge) return;

  const HANDOFF_NS = '__GUIDED_UPLOAD__';
  const PENDING_TTL_MS = 45000;

  let pendingBatch = null;
  let pendingUploadRefresh = null;
  let lastKnownModal = null;
  let lastRefreshTriggeredAt = 0;
  let noStoreUntil = 0;
  let refreshToastHost = null;
  let refreshToastTimer = null;
  let lastKnownContext = {
    aemAuthorUrl: '',
    folderPath: '/content/dam'
  };

  const TRUSTED_HOST_ORIGINS = [
    /^https:\/\/experience\.adobe\.com$/i,
    /^https:\/\/experience-stage\.adobe\.com$/i,
    /^https:\/\/[a-z0-9-]+\.adobeaemcloud\.com$/i
  ];

  const TRUSTED_EXTENSION_ORIGINS = [
    /^https:\/\/[a-z0-9-]+\.adobeio-static\.net$/i,
    /^https?:\/\/localhost(?::\d+)?$/i,
    /^https?:\/\/127\.0\.0\.1(?::\d+)?$/i
  ];

  function isTrustedHostOrigin (origin = '') {
    const s = String(origin || '').trim();
    return Boolean(s) && TRUSTED_HOST_ORIGINS.some((re) => re.test(s));
  }

  function isTrustedExtensionOrigin (origin = '') {
    const s = String(origin || '').trim();
    return Boolean(s) && TRUSTED_EXTENSION_ORIGINS.some((re) => re.test(s));
  }

  function isTrustedOrigin (origin = '') {
    return isTrustedHostOrigin(origin) || isTrustedExtensionOrigin(origin);
  }

  // Bypass browser HTTP cache on repository/folder-listing fetches right after an upload completes
  try {
    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function (input, init) {
        if (Date.now() < noStoreUntil) {
          const urlStr = typeof input === 'string' ? input : (input && input.url) || '';
          if (/\/adobe\/repository|\/api\/assets|\/content\/dam/i.test(urlStr)) {
            init = { ...(init || {}), cache: 'no-store' };
          }
        }
        return origFetch.call(this, input, init);
      };
    }
  } catch (e) { /* ignore fetch hook errors */ }

  function extractContextFromUrlString (href = '') {
    try {
      const u = new URL(href);
      const repo =
        u.searchParams.get('repoId') ||
        new URLSearchParams((u.hash.split('?')[1] || '')).get('repoId') ||
        '';
      const aemAuthorUrl = /^author-[a-z0-9-]+\.adobeaemcloud\.com$/i.test(repo)
        ? `https://${repo}`
        : (/^https:\/\/author-[a-z0-9-]+\.adobeaemcloud\.com/i.test(u.origin) ? u.origin : '');
      const m = u.hash.match(/\/assets\/browse(\/content\/dam(?:\/[^?#]*)?)/i);
      const folderPath = m ? decodeURIComponent(m[1]).replace(/\/+$/, '') : '';
      return { aemAuthorUrl, folderPath };
    } catch (e) {
      return { aemAuthorUrl: '', folderPath: '' };
    }
  }

  function parseAssetsViewLocation () {
    const candidates = [location.href];
    try {
      if (window.top && window.top !== window && window.top.location?.href) {
        candidates.unshift(window.top.location.href);
      }
    } catch (e) { /* cross-origin top */ }
    try {
      if (window.parent && window.parent !== window && window.parent.location?.href) {
        candidates.unshift(window.parent.location.href);
      }
    } catch (e) { /* cross-origin parent */ }
    if (document.referrer) {
      candidates.push(document.referrer);
    }

    let aemAuthorUrl = lastKnownContext.aemAuthorUrl || '';
    let folderPath = '';

    for (const c of candidates) {
      const parsed = extractContextFromUrlString(c);
      if (parsed.aemAuthorUrl && !aemAuthorUrl) aemAuthorUrl = parsed.aemAuthorUrl;
      if (parsed.folderPath && !folderPath) folderPath = parsed.folderPath;
    }

    if (folderPath) lastKnownContext.folderPath = folderPath;
    if (aemAuthorUrl) lastKnownContext.aemAuthorUrl = aemAuthorUrl;

    return {
      aemAuthorUrl: aemAuthorUrl || '',
      folderPath: folderPath || lastKnownContext.folderPath || '/content/dam'
    };
  }

  /**
   * Recursively walks all open Shadow DOM roots and light DOM to find matching elements.
   */
  function queryAllDeep (root = document, visited = new Set()) {
    const out = [];
    if (!root || visited.has(root)) return out;
    visited.add(root);

    const nodes = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (const el of nodes) {
      out.push(el);
      if (el.shadowRoot) {
        out.push(...queryAllDeep(el.shadowRoot, visited));
      }
    }
    return out;
  }

  function findAndClickAddAssetsButton () {
    const allElements = queryAllDeep(document);
    for (const el of allElements) {
      const tag = (el.tagName || '').toLowerCase();
      const role = (el.getAttribute && el.getAttribute('role')) || '';
      if (tag !== 'button' && role !== 'button' && !tag.startsWith('sp-')) continue;

      const label = (
        el.textContent ||
        (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'))) ||
        ''
      ).trim();
      const dataId = (
        (el.getAttribute && (el.getAttribute('data-id') || el.getAttribute('data-testid') || el.getAttribute('id'))) ||
        ''
      ).toLowerCase();

      if (/^add\s+assets$/i.test(label) || dataId === 'addassets' || dataId === 'add-assets') {
        el.click();
        return true;
      }
    }
    return false;
  }

  /**
   * Broadcasts a metadata-only control message across frames in the window hierarchy.
   * NEVER use this function for messages containing `File` objects.
   */
  function broadcastToAllFrames (msg) {
    let rootWin = window;
    try {
      if (window.top) rootWin = window.top;
    } catch (e) { /* ignore */ }

    const visited = new Set();
    function walkFrames (win) {
      if (!win || visited.has(win)) return;
      visited.add(win);
      try {
        win.postMessage(msg, '*');
      } catch (e) { /* ignore */ }
      try {
        for (let i = 0; i < win.frames.length; i++) {
          walkFrames(win.frames[i]);
        }
      } catch (e) { /* ignore */ }
    }

    walkFrames(rootWin);
  }

  /**
   * Syncs `STAGE_BATCH` to `window.top` / `window.parent` using their exact `location.ancestorOrigins`
   * origin so Chrome never logs a targetOrigin mismatch error.
   */
  function syncBatchToHostAncestors (msg) {
    try {
      const ancestors = location.ancestorOrigins;
      if (!ancestors || !ancestors.length) return;
      const parentOrigin = ancestors[0];
      if (window.parent && window.parent !== window && isTrustedHostOrigin(parentOrigin)) {
        window.parent.postMessage(msg, parentOrigin);
      }
      const topOrigin = ancestors[ancestors.length - 1];
      if (window.top && window.top !== window && window.top !== window.parent && isTrustedHostOrigin(topOrigin)) {
        window.top.postMessage(msg, topOrigin);
      }
    } catch (e) { /* ignore */ }
  }

  function deliverPendingBatchToFrame (targetWindow, targetOrigin) {
    if (!pendingBatch || !targetWindow || !isTrustedExtensionOrigin(targetOrigin)) return false;
    if (Date.now() - pendingBatch.createdAt > PENDING_TTL_MS) {
      pendingBatch = null;
      return false;
    }
    try {
      targetWindow.postMessage(
        {
          [HANDOFF_NS]: 'DROPPED_FILES',
          folderPath: pendingBatch.folderPath,
          items: pendingBatch.items
        },
        targetOrigin
      );
      return true;
    } catch (e) {
      console.warn('[Guided Upload Guardrail] Failed to postMessage files to modal:', e);
      return false;
    }
  }

  window.addEventListener('message', (event) => {
    if (!event || !isTrustedOrigin(event.origin)) return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;

    if (data[HANDOFF_NS] === 'STAGE_BATCH' && Array.isArray(data.items)) {
      if (!isTrustedHostOrigin(event.origin)) return;
      pendingBatch = {
        createdAt: Date.now(),
        folderPath: data.folderPath || '/content/dam',
        aemAuthorUrl: data.aemAuthorUrl || '',
        items: data.items
      };
      return;
    }

    // Only deliver dropped File objects to the verified extension modal frame that sent MODAL_READY
    if (data[HANDOFF_NS] === 'MODAL_READY') {
      if (!isTrustedExtensionOrigin(event.origin) || !event.source) return;
      lastKnownModal = {
        win: event.source,
        origin: event.origin
      };
      if (deliverPendingBatchToFrame(event.source, event.origin)) {
        setTimeout(() => {
          pendingBatch = null;
        }, 1500);
      }
      return;
    }

    if (data[HANDOFF_NS] === 'UPLOAD_COMPLETED') {
      noStoreUntil = Date.now() + 30000;
      pendingUploadRefresh = {
        folderPath: data.folderPath || '/content/dam',
        baseFolder: data.baseFolder || data.folderPath || '/content/dam',
        completedCount: data.completedCount || (Array.isArray(data.assets) ? data.assets.length : 1),
        assets: Array.isArray(data.assets) ? data.assets : [],
        completedAt: Date.now()
      };
      if (!data.__relayed) {
        broadcastToAllFrames({
          ...data,
          [HANDOFF_NS]: 'UPLOAD_COMPLETED',
          __relayed: true
        });
      }
      watchForModalCloseAndRefresh();
      return;
    }

    if (data[HANDOFF_NS] === 'REFRESH_FOLDER_VIEW') {
      noStoreUntil = Date.now() + 15000;
      if (modalCloseWatcher) {
        clearInterval(modalCloseWatcher);
        modalCloseWatcher = null;
      }
      const summary = {
        folderPath: data.folderPath || (pendingUploadRefresh && pendingUploadRefresh.folderPath) || '/content/dam',
        baseFolder: data.baseFolder || (pendingUploadRefresh && pendingUploadRefresh.baseFolder) || '/content/dam',
        completedCount: data.completedCount || (pendingUploadRefresh && pendingUploadRefresh.completedCount) || 1,
        assets: Array.isArray(data.assets) && data.assets.length
          ? data.assets
          : ((pendingUploadRefresh && pendingUploadRefresh.assets) || [])
      };
      pendingUploadRefresh = null;

      if (!data.__relayed) {
        broadcastToAllFrames({
          ...data,
          ...summary,
          [HANDOFF_NS]: 'REFRESH_FOLDER_VIEW',
          __relayed: true
        });
      }
      refreshAssetsViewFolder(summary);
    }
  });

  let modalCloseWatcher = null;

  function isModalIframePresent () {
    const all = queryAllDeep(document);
    for (const el of all) {
      if (!el || (el.tagName || '').toLowerCase() !== 'iframe') continue;
      const src = (el.getAttribute && el.getAttribute('src')) || el.src || '';
      if (/modal-guided-upload/i.test(src)) return true;
    }
    return false;
  }

  function watchForModalCloseAndRefresh () {
    if (modalCloseWatcher) clearInterval(modalCloseWatcher);
    let sawModal = isModalIframePresent();
    let ticks = 0;
    modalCloseWatcher = setInterval(() => {
      ticks++;
      if (!pendingUploadRefresh || ticks > 150) {
        clearInterval(modalCloseWatcher);
        modalCloseWatcher = null;
        return;
      }
      const present = isModalIframePresent();
      if (present) {
        sawModal = true;
      } else if (sawModal && !present) {
        clearInterval(modalCloseWatcher);
        modalCloseWatcher = null;
        const summary = pendingUploadRefresh;
        pendingUploadRefresh = null;
        broadcastToAllFrames({
          ...summary,
          [HANDOFF_NS]: 'REFRESH_FOLDER_VIEW',
          __relayed: true
        });
        refreshAssetsViewFolder(summary);
      }
    }, 350);
  }

  function showRefreshToast (message, variant = 'info', durationMs = 5000) {
    let isTop = false;
    try {
      isTop = window.top === window;
    } catch (e) { /* cross-origin */ }
    if (!isTop) return;

    if (refreshToastTimer) {
      clearTimeout(refreshToastTimer);
      refreshToastTimer = null;
    }
    if (refreshToastHost) {
      refreshToastHost.remove();
      refreshToastHost = null;
    }

    const bg = variant === 'positive' ? '#12805c' : '#0d66d0';
    refreshToastHost = document.createElement('div');
    const shadow = refreshToastHost.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host {
          all: initial;
          position: fixed;
          bottom: 24px;
          right: 24px;
          z-index: 2147483647;
          font-family: adobe-clean, "Source Sans Pro", -apple-system, BlinkMacSystemFont, sans-serif;
        }
        .toast {
          background: ${bg};
          color: #ffffff;
          padding: 12px 18px;
          border-radius: 8px;
          font-size: 13px;
          font-weight: 600;
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
          display: flex;
          align-items: center;
          gap: 10px;
        }
      </style>
      <div class="toast"></div>
    `;
    const toastEl = shadow.querySelector('.toast');
    if (toastEl) toastEl.textContent = message;
    (document.body || document.documentElement).appendChild(refreshToastHost);

    refreshToastTimer = setTimeout(() => {
      if (refreshToastHost) {
        refreshToastHost.remove();
        refreshToastHost = null;
      }
    }, durationMs);
  }

  function highlightExpectedItemsInDom (expectedNames = []) {
    if (!expectedNames.length) return false;
    const lowerTargets = expectedNames.map((n) => String(n || '').toLowerCase()).filter(Boolean);
    if (!lowerTargets.length) return false;

    const all = queryAllDeep(document);
    let matchedEl = null;

    for (const el of all) {
      if (!el || el.nodeType !== 1) continue;
      const text = (el.textContent || '').trim().toLowerCase();
      const aria = ((el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'))) || '').trim().toLowerCase();
      const isDirectMatch = lowerTargets.some(
        (t) => text === t || aria === t || aria.includes(t)
      );
      if (isDirectMatch) {
        const card = (el.closest && (
          el.closest('[role="row"]') ||
          el.closest('[role="gridcell"]') ||
          el.closest('[role="listitem"]') ||
          el.closest('sp-card') ||
          el.closest('article')
        )) || el;
        try {
          card.style.outline = '2px solid #12805c';
          card.style.boxShadow = '0 0 0 4px rgba(18, 128, 92, 0.25)';
          card.style.borderRadius = '6px';
          card.style.transition = 'outline 0.3s ease, box-shadow 0.3s ease';
          setTimeout(() => {
            try {
              card.style.outline = '';
              card.style.boxShadow = '';
            } catch (e) { /* ignore */ }
          }, 6000);
        } catch (e) { /* ignore style errors */ }
        if (!matchedEl) matchedEl = card;
      }
    }

    if (matchedEl && typeof matchedEl.scrollIntoView === 'function') {
      try {
        matchedEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } catch (e) { /* ignore */ }
      return true;
    }
    return false;
  }

  function refreshAssetsViewFolder (summary = {}) {
    const now = Date.now();
    if (now - lastRefreshTriggeredAt < 4000) return;

    const currentHash = location.hash || '';
    const match = currentHash.match(/^(#?[^?]*\/assets\/browse)(\/content\/dam(?:\/[^?#]*)?)?(\?.*)?$/i);
    if (!match) return;

    lastRefreshTriggeredAt = now;
    noStoreUntil = Date.now() + 15000;

    const prefix = match[1];
    const currentFolder = match[2] ? decodeURIComponent(match[2]).replace(/\/+$/, '') : '/content/dam';
    const querySuffix = match[3] || '';
    const targetFolder = (summary.folderPath && summary.folderPath.startsWith('/content/dam'))
      ? summary.folderPath.replace(/\/+$/, '')
      : currentFolder;

    const count = Number(summary.completedCount) || 1;
    const assets = Array.isArray(summary.assets) ? summary.assets : [];

    // Names to look for in the refreshed folder view (either file names or newly created direct subfolder names)
    const expectedNames = [];
    for (const a of assets) {
      if (a.targetFolder === targetFolder && a.fileName) {
        expectedNames.push(a.fileName);
      } else if (a.targetFolder && a.targetFolder.startsWith(targetFolder + '/')) {
        const relSub = a.targetFolder.slice(targetFolder.length + 1).split('/')[0];
        if (relSub) expectedNames.push(relSub);
      } else if (a.fileName) {
        expectedNames.push(a.fileName);
      }
    }

    const encodePath = (p) => String(p || '/content/dam')
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/');

    const targetHash = `${prefix}${encodePath(targetFolder)}${querySuffix}`;
    const parentFolder = targetFolder !== '/content/dam'
      ? (targetFolder.split('/').slice(0, -1).join('/') || '/content/dam')
      : '/content/dam';
    const bounceHash = targetFolder !== '/content/dam'
      ? `${prefix}${encodePath(parentFolder)}${querySuffix}`
      : `${prefix}${querySuffix}`;

    // Single fast SPA route bounce so React Router re-fetches the target folder contents without a page reload
    setTimeout(() => {
      try {
        location.hash = bounceHash;
      } catch (e) { /* ignore */ }
      setTimeout(() => {
        try {
          location.hash = targetHash;
        } catch (e) { /* ignore */ }
        const firstLabel = expectedNames[0] ? `"${expectedNames[0]}"` : `${count} asset(s)`;
        showRefreshToast(
          `✓ Uploaded ${firstLabel}${count > 1 ? ` (+${count - 1} more)` : ''} to ${targetFolder}`,
          'positive',
          5000
        );
      }, 140);
    }, 80);

    // Optional non-intrusive card highlight once the refreshed grid renders
    let attempts = 0;
    const poll = setInterval(() => {
      attempts++;
      if (highlightExpectedItemsInDom(expectedNames) || attempts >= 6) {
        clearInterval(poll);
      }
    }, 400);
  }

  function stageDroppedFilesAndOpenModal (items = []) {
    const { folderPath, aemAuthorUrl } = parseAssetsViewLocation();
    pendingBatch = {
      createdAt: Date.now(),
      folderPath,
      aemAuthorUrl,
      items
    };

    // 0. Sync pendingBatch to parent/top host frame using exact ancestorOrigins
    syncBatchToHostAncestors({
      [HANDOFF_NS]: 'STAGE_BATCH',
      folderPath,
      aemAuthorUrl,
      items
    });

    // 1. If the Guided Upload modal is already open, send DROPPED_FILES exclusively to its verified origin
    if (lastKnownModal && lastKnownModal.win && isTrustedExtensionOrigin(lastKnownModal.origin)) {
      deliverPendingBatchToFrame(lastKnownModal.win, lastKnownModal.origin);
    }

    // 2. Broadcast metadata-only OPEN_MODAL_FROM_DROP (contains zero File objects) to open the modal
    broadcastToAllFrames({
      [HANDOFF_NS]: 'OPEN_MODAL_FROM_DROP',
      folderPath
    });

    // 3. Also attempt clicking the "Add assets" button in this frame if present
    findAndClickAddAssetsButton();
  }

  globalThis.__guModalBridge = {
    parseAssetsViewLocation,
    stageDroppedFilesAndOpenModal,
    broadcastToAllFrames
  };
})();
