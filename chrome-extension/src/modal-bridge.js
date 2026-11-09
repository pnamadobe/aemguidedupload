// Bridges dropped File trees from the AEM Assets View host window into the App Builder
// Guided Upload modal iframe and triggers opening the modal on drop.
(() => {
  'use strict';
  if (globalThis.__guModalBridge) return;

  const HANDOFF_NS = '__GUIDED_UPLOAD__';
  const PENDING_TTL_MS = 30000;

  let pendingBatch = null;

  function parseAssetsViewLocation (href = location.href) {
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
      const folderPath = m ? decodeURIComponent(m[1]).replace(/\/+$/, '') : '/content/dam';
      const isBrowseView = /\/assets\/browse/i.test(u.hash) || /\/assets\/browse/i.test(u.pathname);
      return { aemAuthorUrl, folderPath: folderPath || '/content/dam', isBrowseView };
    } catch (e) {
      return { aemAuthorUrl: '', folderPath: '/content/dam', isBrowseView: false };
    }
  }

  function findAndClickAddAssetsButton () {
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], sp-button, sp-action-button'));
    for (const el of candidates) {
      const label = (el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
      const dataId = (el.getAttribute('data-id') || el.getAttribute('id') || '').toLowerCase();
      if (/^add\s+assets$/i.test(label) || dataId === 'addassets' || dataId === 'add-assets') {
        el.click();
        return true;
      }
    }
    return false;
  }

  function broadcastOpenModalToExtensionFrames (folderPath, aemAuthorUrl) {
    const msg = {
      [HANDOFF_NS]: 'OPEN_MODAL_FROM_DROP',
      folderPath,
      aemAuthorUrl
    };
    const iframes = Array.from(document.querySelectorAll('iframe'));
    let sent = 0;
    for (const frame of iframes) {
      try {
        if (frame.contentWindow) {
          frame.contentWindow.postMessage(msg, '*');
          sent++;
        }
      } catch (e) {
        // ignore cross-origin access errors
      }
    }
    return sent > 0;
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
    if (data[HANDOFF_NS] === 'MODAL_READY' && event.source) {
      if (deliverPendingBatchToFrame(event.source)) {
        // Clear pending batch slightly after delivery so duplicate MODAL_READY pings still work
        setTimeout(() => {
          pendingBatch = null;
        }, 1200);
      }
    }
  });

  function stageDroppedFilesAndOpenModal (items = []) {
    const { folderPath, aemAuthorUrl } = parseAssetsViewLocation(location.href);
    pendingBatch = {
      createdAt: Date.now(),
      folderPath,
      aemAuthorUrl,
      items
    };

    // 1. If the Guided Upload modal iframe is already open on the page, push directly to it
    const iframes = Array.from(document.querySelectorAll('iframe'));
    for (const frame of iframes) {
      const src = String(frame.getAttribute('src') || '');
      if (src.includes('modal-guided-upload')) {
        deliverPendingBatchToFrame(frame.contentWindow);
        return;
      }
    }

    // 2. Message the ExtensionRegistration iframe directly AND click "Add assets" if needed
    const messaged = broadcastOpenModalToExtensionFrames(folderPath, aemAuthorUrl);
    if (!messaged) {
      findAndClickAddAssetsButton();
    }
  }

  globalThis.__guModalBridge = {
    parseAssetsViewLocation,
    stageDroppedFilesAndOpenModal
  };
})();
