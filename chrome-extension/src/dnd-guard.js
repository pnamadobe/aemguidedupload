// MAIN-world Capture-Phase & EventTarget.addEventListener Drag-and-Drop Guardrail.
// Runs at `document_start` in MAIN world before AEM Assets View's scripts load,
// ensuring native ungoverned drag-and-drop upload listeners never fire.
(() => {
  'use strict';
  if (globalThis.__guDndGuardInstalled) return;
  globalThis.__guDndGuardInstalled = true;

  const isInsideGuidedUploadModal = () =>
    /modal-guided-upload/i.test(location.hash || '') ||
    /modal-guided-upload/i.test(location.href || '') ||
    /\.adobeio-static\.net$/i.test(location.hostname || '');

  // Never intercept inside the Guided Upload modal iframe itself!
  if (isInsideGuidedUploadModal()) return;

  let settings = {
    enabled: true,
    handoffOnDrop: true
  };

  window.addEventListener('message', (e) => {
    if (!e || e.source !== window) return;
    if (e.data && e.data.__GU_SETTINGS__) {
      settings = { ...settings, ...e.data.__GU_SETTINGS__ };
    }
  });

  let dragDepth = 0;
  let overlayHost = null;
  let toastHost = null;
  let lastDropHandledAt = 0;

  function isFileDragEvent (e) {
    if (!e || !e.dataTransfer) return false;
    const types = e.dataTransfer.types ? Array.from(e.dataTransfer.types) : [];
    return types.includes('Files') || types.includes('application/x-moz-file');
  }

  function isAemAssetsViewUrl (urlStr = '') {
    if (!urlStr) return false;
    return (
      /[?&]repoId=author-p[a-z0-9-]+/i.test(urlStr) ||
      /\/assets\/browse/i.test(urlStr)
    );
  }

  function isGuardActive () {
    if (!settings.enabled) return false;
    if (isInsideGuidedUploadModal()) return false;

    if (isAemAssetsViewUrl(location.href)) return true;
    try {
      if (window.top && window.top !== window && isAemAssetsViewUrl(window.top.location.href)) {
        return true;
      }
    } catch (e) { /* cross-origin top */ }
    try {
      if (window.parent && window.parent !== window && isAemAssetsViewUrl(window.parent.location.href)) {
        return true;
      }
    } catch (e) { /* cross-origin parent */ }
    if (document.referrer && isAemAssetsViewUrl(document.referrer)) {
      return true;
    }
    return false;
  }

  // Register capture-phase listeners at document_start on `window` (runs before any page
  // scripts load, so `e.stopImmediatePropagation()` blocks all page drag/drop listeners
  // without monkey-patching EventTarget.prototype.addEventListener).

  function showDropOverlay () {
    if (overlayHost) return;
    overlayHost = document.createElement('div');
    overlayHost.setAttribute('data-gu-drop-overlay', 'true');
    const shadow = overlayHost.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host {
          all: initial;
          position: fixed;
          inset: 0;
          z-index: 2147483646;
          pointer-events: none;
          display: flex;
          align-items: center;
          justify-content: center;
          background: rgba(2, 101, 220, 0.08);
          backdrop-filter: blur(1.5px);
          font-family: adobe-clean, "Source Sans Pro", -apple-system, BlinkMacSystemFont, sans-serif;
        }
        .card {
          background: #ffffff;
          color: #1d1d1d;
          border: 1.5px dashed #0265dc;
          border-radius: 8px;
          padding: 28px 36px;
          box-shadow: 0 8px 28px rgba(0, 0, 0, 0.18);
          text-align: center;
          max-width: 460px;
        }
        .icon-wrap {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 44px;
          height: 44px;
          border-radius: 999px;
          background: rgba(2, 101, 220, 0.1);
          color: #0265dc;
          margin-bottom: 12px;
        }
        h3 {
          margin: 0 0 6px;
          font-size: 16px;
          font-weight: 700;
          color: #1d1d1d;
        }
        p {
          margin: 0;
          font-size: 13px;
          color: #505050;
          line-height: 1.45;
        }
      </style>
      <div class="card">
        <div class="icon-wrap">
          <svg width="22" height="22" viewBox="0 0 18 18" fill="currentColor" aria-hidden="true">
            <path d="M14.6,7.1C14.2,4.2,11.7,2,8.8,2C6.1,2,3.8,3.8,3.1,6.4C1.3,6.9,0,8.6,0,10.5C0,12.9,1.9,14.8,4.3,14.8H7v-4.3H5.1L9,6.2l3.9,4.3H11v4.3h3.2c2.1,0,3.8-1.7,3.8-3.8C18,9,16.5,7.3,14.6,7.1z"/>
          </svg>
        </div>
        <h3>Drop to Add Assets</h3>
        <p>
          Files and folder hierarchies will open in the upload dialog with folder metadata and naming applied.
        </p>
      </div>
    `;
    (document.body || document.documentElement).appendChild(overlayHost);
  }

  function hideDropOverlay () {
    dragDepth = 0;
    if (overlayHost) {
      overlayHost.remove();
      overlayHost = null;
    }
  }

  function showStatusBanner (message) {
    if (toastHost) toastHost.remove();
    toastHost = document.createElement('div');
    const shadow = toastHost.attachShadow({ mode: 'open' });
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
          background: #292929;
          color: #ffffff;
          padding: 10px 16px;
          border-radius: 6px;
          font-size: 13px;
          font-weight: 500;
          box-shadow: 0 4px 16px rgba(0, 0, 0, 0.24);
          display: flex;
          align-items: center;
          gap: 8px;
        }
      </style>
      <div class="toast"><span class="msg"></span></div>
    `;
    const msgEl = shadow.querySelector('.msg');
    if (msgEl) msgEl.textContent = message;
    (document.body || document.documentElement).appendChild(toastHost);
    setTimeout(() => {
      if (toastHost) {
        toastHost.remove();
        toastHost = null;
      }
    }, 4000);
  }

  function isBypassedEvent (e) {
    return Boolean((e && e.__guBypassGuard) || globalThis.__guBypassGuardActive);
  }

  function onDragEnter (e) {
    if (isBypassedEvent(e) || !isGuardActive() || !isFileDragEvent(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    dragDepth++;
    showDropOverlay();
  }
  onDragEnter.__guInternal = true;

  function onDragOver (e) {
    if (isBypassedEvent(e) || !isGuardActive() || !isFileDragEvent(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    try {
      e.dataTransfer.dropEffect = 'copy';
    } catch (err) { /* ignore */ }
    showDropOverlay();
  }
  onDragOver.__guInternal = true;

  function onDragLeave (e) {
    if (isBypassedEvent(e) || !isGuardActive()) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0 || e.relatedTarget === null) {
      hideDropOverlay();
    }
  }
  onDragLeave.__guInternal = true;

  async function onDrop (e) {
    if (isBypassedEvent(e) || !isGuardActive() || !isFileDragEvent(e)) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    hideDropOverlay();

    // Prevent duplicate handling between window and document capture listeners
    const now = Date.now();
    if (now - lastDropHandledAt < 300) return;
    lastDropHandledAt = now;

    const reader = globalThis.__guFolderReader;
    const bridge = globalThis.__guModalBridge;

    if (!settings.handoffOnDrop || !bridge || !reader) {
      showStatusBanner('Click "Add assets" to upload files with folder metadata.');
      return;
    }

    // Synchronously capture FileSystemEntry roots before the first await!
    const snapshot = reader.captureDropSnapshotSync(e.dataTransfer);

    try {
      const items = await reader.resolveSnapshotToItems(snapshot);
      if (items.length > 0) {
        showStatusBanner(`Loading ${items.length} asset${items.length === 1 ? '' : 's'} into Add Assets…`);
        bridge.stageDroppedFilesAndOpenModal(items);
      } else {
        showStatusBanner('Opening Add Assets…');
        bridge.stageDroppedFilesAndOpenModal([]);
      }
    } catch (err) {
      console.error('[Guided Upload Guardrail] Error reading dropped items:', err);
      showStatusBanner('Opening Add Assets…');
      bridge.stageDroppedFilesAndOpenModal([]);
    }
  }
  onDrop.__guInternal = true;

  for (const target of [window, document]) {
    target.addEventListener('dragenter', onDragEnter, true);
    target.addEventListener('dragover', onDragOver, true);
    target.addEventListener('dragleave', onDragLeave, true);
    target.addEventListener('drop', onDrop, true);
  }
})();
