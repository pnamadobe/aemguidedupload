// Capture-phase Drag-and-Drop Interceptor for AEM Assets View.
// Blocks raw, ungoverned drag-and-drop uploads on the browse grid and hands off
// dropped files + folder hierarchies to the Guided Upload wizard modal.
(() => {
  'use strict';
  if (globalThis.__guDndGuardInstalled) return;
  globalThis.__guDndGuardInstalled = true;

  // Never intercept inside the Guided Upload modal iframe itself!
  const isInsideGuidedUploadModal = () =>
    /modal-guided-upload/i.test(location.hash || '') ||
    /modal-guided-upload/i.test(location.href || '');

  const DEFAULTS = {
    enabled: true,
    handoffOnDrop: true
  };

  let settings = { ...DEFAULTS };
  let dragDepth = 0;
  let overlayHost = null;
  let toastHost = null;

  try {
    chrome.storage?.sync.get(DEFAULTS, (stored) => {
      settings = { ...DEFAULTS, ...stored };
    });
    chrome.storage?.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      for (const k of Object.keys(changes)) {
        if (k in DEFAULTS) settings[k] = changes[k].newValue ?? DEFAULTS[k];
      }
    });
  } catch (e) {
    // fallback to defaults
  }

  function isAssetsViewBrowseActive () {
    if (isInsideGuidedUploadModal()) return false;
    const bridge = globalThis.__guModalBridge;
    if (!bridge) return false;
    const { isBrowseView } = bridge.parseAssetsViewLocation(location.href);
    return isBrowseView;
  }

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
          background: rgba(13, 102, 208, 0.14);
          backdrop-filter: blur(2px);
          font-family: adobe-clean, "Source Sans Pro", -apple-system, BlinkMacSystemFont, sans-serif;
        }
        .card {
          background: #ffffff;
          color: #1d1d1d;
          border: 2px dashed #1473e6;
          border-radius: 14px;
          padding: 28px 36px;
          box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
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
    }, 4000);
  }

  function onDragEnter (e) {
    if (!settings.enabled || !isAssetsViewBrowseActive()) return;
    const reader = globalThis.__guFolderReader;
    if (!reader || !reader.hasFilePayload(e.dataTransfer)) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    dragDepth++;
    showDropOverlay();
  }

  function onDragOver (e) {
    if (!settings.enabled || !isAssetsViewBrowseActive()) return;
    const reader = globalThis.__guFolderReader;
    if (!reader || !reader.hasFilePayload(e.dataTransfer)) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy';
    }
    showDropOverlay();
  }

  function onDragLeave (e) {
    if (!settings.enabled || !isAssetsViewBrowseActive()) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0 || e.relatedTarget === null) {
      hideDropOverlay();
    }
  }

  async function onDrop (e) {
    if (!settings.enabled || !isAssetsViewBrowseActive()) return;
    const reader = globalThis.__guFolderReader;
    const bridge = globalThis.__guModalBridge;
    if (!reader || !reader.hasFilePayload(e.dataTransfer)) return;

    // 1. Block AEM Assets View's built-in ungoverned dropzone immediately in capture phase
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    hideDropOverlay();

    if (!settings.handoffOnDrop || !bridge) {
      showStatusBanner('🛡️ Direct drop blocked — click "Add assets" to use Guided Upload.');
      return;
    }

    // 2. Synchronously capture FileSystemEntry roots before the first await!
    const snapshot = reader.captureDropSnapshotSync(e.dataTransfer);

    // 3. Recursively read dropped files & nested folders, then hand off to Guided Upload Modal
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

  window.addEventListener('dragenter', onDragEnter, true);
  window.addEventListener('dragover', onDragOver, true);
  window.addEventListener('dragleave', onDragLeave, true);
  window.addEventListener('drop', onDrop, true);
})();
