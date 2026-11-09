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

  function isGuardActive () {
    if (!settings.enabled) return false;
    if (isInsideGuidedUploadModal()) return false;
    return true;
  }

  // 1. Patch EventTarget.prototype.addEventListener at document_start so any `dragenter`,
  //    `dragover`, or `drop` listener registered by AEM Assets View is skipped on file drags!
  const DND_EVENTS = new Set(['dragenter', 'dragover', 'dragleave', 'drop']);
  const origAddEventListener = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (DND_EVENTS.has(type) && typeof listener === 'function' && !listener.__guInternal) {
      const wrapped = function (event) {
        if (isGuardActive() && isFileDragEvent(event)) {
          // Swallow native page listener for file drag/drop
          return undefined;
        }
        return listener.apply(this, arguments);
      };
      return origAddEventListener.call(this, type, wrapped, options);
    }
    return origAddEventListener.call(this, type, listener, options);
  };

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
          background: rgba(13, 102, 208, 0.16);
          backdrop-filter: blur(2px);
          font-family: adobe-clean, "Source Sans Pro", -apple-system, BlinkMacSystemFont, sans-serif;
        }
        .card {
          background: #ffffff;
          color: #1d1d1d;
          border: 2px dashed #1473e6;
          border-radius: 14px;
          padding: 28px 36px;
          box-shadow: 0 12px 40px rgba(0, 0, 0, 0.28);
          text-align: center;
          max-width: 520px;
        }
        .badge {
          display: inline-block;
          background: #1473e6;
          color: #ffffff;
          font-size: 11px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          padding: 4px 10px;
          border-radius: 999px;
          margin-bottom: 10px;
        }
        h3 {
          margin: 0 0 8px;
          font-size: 18px;
          font-weight: 800;
        }
        p {
          margin: 0;
          font-size: 13.5px;
          color: #505050;
          line-height: 1.45;
        }
      </style>
      <div class="card">
        <div class="badge">🛡️ Upload Governance Active</div>
        <h3>Drop to Open Guided Upload Wizard</h3>
        <p>
          Direct ungoverned upload is blocked. Dropping your files or folders here will open
          <b>Guided Upload</b> with your folder hierarchy preserved and folder metadata schema enforced.
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
          background: #0d66d0;
          color: #fff;
          padding: 12px 18px;
          border-radius: 8px;
          font-size: 13px;
          font-weight: 600;
          box-shadow: 0 6px 20px rgba(0, 0, 0, 0.3);
        }
      </style>
      <div class="toast">${message}</div>
    `;
    (document.body || document.documentElement).appendChild(toastHost);
    setTimeout(() => {
      if (toastHost) {
        toastHost.remove();
        toastHost = null;
      }
    }, 4500);
  }

  function onDragEnter (e) {
    if (!isGuardActive() || !isFileDragEvent(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    dragDepth++;
    showDropOverlay();
  }
  onDragEnter.__guInternal = true;

  function onDragOver (e) {
    if (!isGuardActive() || !isFileDragEvent(e)) return;
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
    if (!isGuardActive()) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0 || e.relatedTarget === null) {
      hideDropOverlay();
    }
  }
  onDragLeave.__guInternal = true;

  async function onDrop (e) {
    if (!isGuardActive() || !isFileDragEvent(e)) return;

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
      showStatusBanner('🛡️ Direct drop blocked — click "Add assets" to use Guided Upload.');
      return;
    }

    // Synchronously capture FileSystemEntry roots before the first await!
    const snapshot = reader.captureDropSnapshotSync(e.dataTransfer);

    try {
      const items = await reader.resolveSnapshotToItems(snapshot);
      if (items.length > 0) {
        showStatusBanner(`🛡️ Handing off ${items.length} file(s) to Guided Upload Wizard…`);
        bridge.stageDroppedFilesAndOpenModal(items);
      } else {
        showStatusBanner('🛡️ Direct drop intercepted — opening Guided Upload Wizard…');
        bridge.stageDroppedFilesAndOpenModal([]);
      }
    } catch (err) {
      console.error('[Guided Upload Guardrail] Error reading dropped items:', err);
      showStatusBanner('🛡️ Direct drop intercepted — opening Guided Upload Wizard…');
      bridge.stageDroppedFilesAndOpenModal([]);
    }
  }
  onDrop.__guInternal = true;

  for (const target of [window, document]) {
    origAddEventListener.call(target, 'dragenter', onDragEnter, true);
    origAddEventListener.call(target, 'dragover', onDragOver, true);
    origAddEventListener.call(target, 'dragleave', onDragLeave, true);
    origAddEventListener.call(target, 'drop', onDrop, true);
  }
})();
