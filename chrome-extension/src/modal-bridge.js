// Bridges dropped File trees from any AEM Assets View frame into the App Builder
// Guided Upload modal iframe and triggers opening the modal on drop.
(() => {
  'use strict';
  if (globalThis.__guModalBridge) return;

  const HANDOFF_NS = '__GUIDED_UPLOAD__';
  const PENDING_TTL_MS = 45000;

  let pendingBatch = null;
  let lastKnownContext = {
    aemAuthorUrl: '',
    folderPath: '/content/dam'
  };

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
   * Broadcasts a postMessage to EVERY frame in the window hierarchy via `win.frames`
   * (works even when `<iframe>` elements are encapsulated inside Shadow DOM!).
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

  function deliverPendingBatchToFrame (targetWindow) {
    if (!pendingBatch || !targetWindow) return false;
    if (Date.now() - pendingBatch.createdAt > PENDING_TTL_MS) {
      pendingBatch = null;
      return false;
    }
    try {
      targetWindow.postMessage(
        {
          [HANDOFF_NS]: 'DROPPED_FILES',
          folderPath: pendingBatch.folderPath,
          aemAuthorUrl: pendingBatch.aemAuthorUrl,
          items: pendingBatch.items
        },
        '*'
      );
      return true;
    } catch (e) {
      console.warn('[Guided Upload Guardrail] Failed to postMessage files to modal:', e);
      return false;
    }
  }

  window.addEventListener('message', (event) => {
    const data = event && event.data;
    if (!data || typeof data !== 'object') return;

    if (data[HANDOFF_NS] === 'STAGE_BATCH' && Array.isArray(data.items)) {
      pendingBatch = {
        createdAt: Date.now(),
        folderPath: data.folderPath || '/content/dam',
        aemAuthorUrl: data.aemAuthorUrl || '',
        items: data.items
      };
      return;
    }

    // If any frame signals MODAL_READY, deliver the staged batch to it and broadcast
    if (data[HANDOFF_NS] === 'MODAL_READY') {
      if (event.source && deliverPendingBatchToFrame(event.source)) {
        broadcastToAllFrames({
          [HANDOFF_NS]: 'DROPPED_FILES',
          folderPath: pendingBatch.folderPath,
          aemAuthorUrl: pendingBatch.aemAuthorUrl,
          items: pendingBatch.items
        });
        setTimeout(() => {
          pendingBatch = null;
        }, 1500);
      }
    }
  });

  function stageDroppedFilesAndOpenModal (items = []) {
    const { folderPath, aemAuthorUrl } = parseAssetsViewLocation();
    pendingBatch = {
      createdAt: Date.now(),
      folderPath,
      aemAuthorUrl,
      items
    };

    // 0. Sync pendingBatch across all frames so whichever frame receives MODAL_READY can answer
    broadcastToAllFrames({
      [HANDOFF_NS]: 'STAGE_BATCH',
      folderPath,
      aemAuthorUrl,
      items
    });

    // 1. Broadcast DROPPED_FILES in case the Guided Upload modal is already open
    broadcastToAllFrames({
      [HANDOFF_NS]: 'DROPPED_FILES',
      folderPath,
      aemAuthorUrl,
      items
    });

    // 2. Broadcast OPEN_MODAL_FROM_DROP to all frames (reaches ExtensionRegistration.js iframe even inside Shadow DOM)
    broadcastToAllFrames({
      [HANDOFF_NS]: 'OPEN_MODAL_FROM_DROP',
      folderPath,
      aemAuthorUrl
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
