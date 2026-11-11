// Bridges dropped File trees from any AEM Assets View frame into the App Builder
// Guided Upload modal iframe and triggers opening the modal on drop.
(() => {
  'use strict';
  if (globalThis.__guModalBridge) return;

  const HANDOFF_NS = '__GUIDED_UPLOAD__';
  const PENDING_TTL_MS = 45000;

  let pendingBatch = null;
  let pendingUploadRefresh = null;
  let stagedNativeUpload = null;
  let activeMetadataBatch = null;
  let metadataPollTimer = null;
  const handledHandoffIds = new Set();
  let lastRefreshTriggeredAt = 0;
  let noStoreUntil = 0;
  let refreshToastHost = null;
  let refreshToastTimer = null;
  let lastKnownContext = {
    aemAuthorUrl: '',
    folderPath: '/content/dam'
  };

  function extractCompleteUploadInfo (urlStr = '', body = null) {
    try {
      const u = new URL(urlStr, location.origin);
      const m = u.pathname.match(/(\/content\/dam\/.+)\.completeUpload\.json$/i);
      if (!m) return null;
      const targetFolder = decodeURIComponent(m[1]).replace(/\/+$/, '');
      let fileName = '';
      if (typeof body === 'string') {
        fileName = new URLSearchParams(body).get('fileName') || '';
      } else if (body instanceof URLSearchParams) {
        fileName = body.get('fileName') || '';
      } else if (typeof FormData !== 'undefined' && body instanceof FormData) {
        fileName = String(body.get('fileName') || '');
      }
      return fileName ? { targetFolder, fileName } : null;
    } catch (e) {
      return null;
    }
  }

  // Hook fetch + XMLHttpRequest to:
  // 1. Bypass browser HTTP cache on repository/folder-listing fetches right after an upload completes
  // 2. Detect when AEM's native OOTB Upload Manager finishes `.completeUpload.json` so we can
  //    immediately write governed Step 2 metadata to `jcr:content/metadata`.
  try {
    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function (input, init) {
        const urlStr = typeof input === 'string' ? input : (input && input.url) || '';
        if (Date.now() < noStoreUntil && /\/adobe\/repository|\/api\/assets|\/content\/dam/i.test(urlStr)) {
          init = { ...(init || {}), cache: 'no-store' };
        }
        const completeInfo = /\.completeUpload\.json/i.test(urlStr)
          ? extractCompleteUploadInfo(urlStr, init && init.body)
          : null;
        const p = origFetch.call(this, input, init);
        if (completeInfo) {
          p.then((res) => {
            if (res && res.ok) {
              broadcastToAllFrames({
                [HANDOFF_NS]: 'NATIVE_FILE_COMMITTED',
                targetFolder: completeInfo.targetFolder,
                fileName: completeInfo.fileName
              });
            }
          }).catch(() => {});
        }
        return p;
      };
    }
  } catch (e) { /* ignore fetch hook errors */ }

  try {
    const origXhrOpen = XMLHttpRequest.prototype.open;
    const origXhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__guUrl = String(url || '');
      return origXhrOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (body) {
      if (this.__guUrl && /\.completeUpload\.json/i.test(this.__guUrl)) {
        const info = extractCompleteUploadInfo(this.__guUrl, body);
        if (info) {
          this.addEventListener('load', () => {
            if (this.status >= 200 && this.status < 300) {
              broadcastToAllFrames({
                [HANDOFF_NS]: 'NATIVE_FILE_COMMITTED',
                targetFolder: info.targetFolder,
                fileName: info.fileName
              });
            }
          });
        }
      }
      return origXhrSend.call(this, body);
    };
  } catch (e) { /* ignore XHR hook errors */ }

  // Hook HTMLInputElement.prototype.click and window.showOpenFilePicker so when Guided Upload
  // hands off governed files to AEM's native "Add assets" handler, the governed File objects
  // are injected directly into AEM's OOTB Upload Manager without opening a second OS file dialog.
  try {
    const origInputClick = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function (...args) {
      if (
        this &&
        String(this.type || '').toLowerCase() === 'file' &&
        stagedNativeUpload &&
        Date.now() < stagedNativeUpload.expiresAt
      ) {
        const batch = stagedNativeUpload;
        stagedNativeUpload = null;
        broadcastToAllFrames({
          [HANDOFF_NS]: 'CLEAR_STAGED_NATIVE_UPLOAD',
          handoffId: batch.handoffId
        });
        try {
          const dt = new DataTransfer();
          for (const item of batch.files) {
            if (item.file) dt.items.add(item.file);
          }
          const filesSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files')?.set;
          if (filesSetter) {
            filesSetter.call(this, dt.files);
          } else {
            this.files = dt.files;
          }
          const inputEl = this;
          setTimeout(() => {
            try {
              inputEl.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
              inputEl.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
            } catch (err) {
              console.warn('[Guided Upload] Failed dispatching change on native file input:', err);
            }
          }, 25);
          showRefreshToast(
            `📤 AEM Upload Manager active — uploading ${batch.files.length} governed asset${batch.files.length === 1 ? '' : 's'}…`,
            'info',
            5000
          );
          return;
        } catch (err) {
          console.warn('[Guided Upload] Error injecting governed files into file input:', err);
        }
      }
      return origInputClick.apply(this, args);
    };

    if (typeof window.showOpenFilePicker === 'function') {
      const origShowPicker = window.showOpenFilePicker;
      window.showOpenFilePicker = async function (...args) {
        if (stagedNativeUpload && Date.now() < stagedNativeUpload.expiresAt) {
          const batch = stagedNativeUpload;
          stagedNativeUpload = null;
          broadcastToAllFrames({
            [HANDOFF_NS]: 'CLEAR_STAGED_NATIVE_UPLOAD',
            handoffId: batch.handoffId
          });
          showRefreshToast(
            `📤 AEM Upload Manager active — uploading ${batch.files.length} governed asset${batch.files.length === 1 ? '' : 's'}…`,
            'info',
            5000
          );
          return batch.files.map((item) => ({
            kind: 'file',
            name: item.file.name,
            getFile: async () => item.file,
            isSameEntry: async () => false,
            queryPermission: async () => 'granted',
            requestPermission: async () => 'granted'
          }));
        }
        return origShowPicker.apply(this, args);
      };
    }
  } catch (e) { /* ignore input hook errors */ }

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

    if (data[HANDOFF_NS] === 'CLEAR_STAGED_NATIVE_UPLOAD') {
      if (stagedNativeUpload && (!data.handoffId || stagedNativeUpload.handoffId === data.handoffId)) {
        stagedNativeUpload = null;
      }
      return;
    }

    if (data[HANDOFF_NS] === 'HANDOFF_TO_NATIVE_UPLOAD' && Array.isArray(data.files) && data.files.length > 0) {
      if (event.source && !data.__relayed) {
        try {
          event.source.postMessage(
            {
              [HANDOFF_NS]: 'NATIVE_UPLOAD_ACK',
              handoffId: data.handoffId || ''
            },
            '*'
          );
        } catch (e) { /* ignore */ }
      }

      if (!data.__relayed) {
        broadcastToAllFrames({
          [HANDOFF_NS]: 'ALLOW_NATIVE_ADD_ASSETS_ONCE',
          handoffId: data.handoffId || ''
        });
        broadcastToAllFrames({
          ...data,
          [HANDOFF_NS]: 'HANDOFF_TO_NATIVE_UPLOAD',
          __relayed: true
        });
      }

      handleNativeUploadHandoff(data);
      return;
    }

    if (data[HANDOFF_NS] === 'NATIVE_FILE_COMMITTED' && data.fileName) {
      handleNativeFileCommitted(data.targetFolder || '', data.fileName);
      return;
    }

    if (data[HANDOFF_NS] === 'REFRESH_FOLDER_VIEW') {
      noStoreUntil = Date.now() + 15000;
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

  function stripDuplicateSuffix (fileName = '') {
    const dot = fileName.lastIndexOf('.');
    const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
    const ext = dot > 0 ? fileName.slice(dot) : '';
    const cleanedStem = stem.replace(/(?:[-_]\d+|\s+\(\d+\))$/, '');
    return `${cleanedStem}${ext}`;
  }

  async function invokeApplyMetadataAction (batch, filesPayload, onlyIfCommittedSince = 0) {
    if (!batch || !batch.actionUrl || !filesPayload.length) return null;
    try {
      const headers = {
        'Content-Type': 'application/json',
        ...(batch.authHeaders || {})
      };
      const body = {
        op: 'applyMetadata',
        ...(batch.aemAuthorUrl ? { aemAuthorUrl: batch.aemAuthorUrl } : {}),
        sharedMetadata: batch.sharedMetadata || {},
        files: filesPayload,
        ...(onlyIfCommittedSince ? { onlyIfCommittedSince } : {})
      };
      const res = await fetch(batch.actionUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      });
      if (!res.ok) return null;
      const parsed = await res.json();
      return parsed && parsed.body ? parsed.body : parsed;
    } catch (e) {
      return null;
    }
  }

  async function handleNativeFileCommitted (targetFolder, committedFileName) {
    let isTop = false;
    try {
      isTop = window.top === window;
    } catch (e) { /* ignore */ }
    if (!isTop || !activeMetadataBatch) return;

    const batch = activeMetadataBatch;
    const baseName = stripDuplicateSuffix(committedFileName).toLowerCase();
    const exactLower = String(committedFileName).toLowerCase();

    const matched = batch.files.find((f) => {
      if (batch.appliedClientIds.has(f.clientId)) return false;
      const candidateLower = String(f.fileName || '').toLowerCase();
      return candidateLower === exactLower || candidateLower === baseName;
    });
    if (!matched) return;

    batch.appliedClientIds.add(matched.clientId);
    const resolvedFolder = targetFolder || matched.targetFolder || batch.baseFolder || '/content/dam';
    const result = await invokeApplyMetadataAction(batch, [
      {
        clientId: matched.clientId,
        fileName: committedFileName,
        targetFolder: resolvedFolder,
        metadata: matched.metadata || {}
      }
    ]);

    if (result && result.completedCount > 0) {
      noStoreUntil = Date.now() + 15000;
      const doneCount = batch.appliedClientIds.size;
      const totalCount = batch.files.length;
      showRefreshToast(
        `✓ Applied governed metadata & rights to "${committedFileName}" (${doneCount}/${totalCount})`,
        'positive',
        5500
      );
      if (doneCount >= totalCount && metadataPollTimer) {
        clearInterval(metadataPollTimer);
        metadataPollTimer = null;
      }
    } else {
      batch.appliedClientIds.delete(matched.clientId);
    }
  }

  function startMetadataWritebackPoller (batch) {
    let isTop = false;
    try {
      isTop = window.top === window;
    } catch (e) { /* ignore */ }
    if (!isTop) return;

    if (metadataPollTimer) {
      clearInterval(metadataPollTimer);
      metadataPollTimer = null;
    }

    let ticks = 0;
    metadataPollTimer = setInterval(async () => {
      ticks++;
      if (!activeMetadataBatch || activeMetadataBatch.handoffId !== batch.handoffId || ticks > 30) {
        clearInterval(metadataPollTimer);
        metadataPollTimer = null;
        return;
      }

      const remaining = batch.files.filter((f) => !batch.appliedClientIds.has(f.clientId));
      if (!remaining.length) {
        clearInterval(metadataPollTimer);
        metadataPollTimer = null;
        return;
      }

      const res = await invokeApplyMetadataAction(
        batch,
        remaining.map((f) => ({
          clientId: f.clientId,
          fileName: f.fileName,
          targetFolder: f.targetFolder || batch.baseFolder || '/content/dam',
          metadata: f.metadata || {}
        })),
        batch.handoffStartedAt
      );

      if (res && Array.isArray(res.assets) && res.assets.length > 0) {
        for (const a of res.assets) {
          if (a.clientId) batch.appliedClientIds.add(a.clientId);
        }
        noStoreUntil = Date.now() + 15000;
        const doneCount = batch.appliedClientIds.size;
        const totalCount = batch.files.length;
        const latestName = res.assets[res.assets.length - 1].fileName;
        showRefreshToast(
          `✓ Applied governed metadata & rights to "${latestName}" (${doneCount}/${totalCount})`,
          'positive',
          5500
        );
        if (doneCount >= totalCount) {
          clearInterval(metadataPollTimer);
          metadataPollTimer = null;
        }
      }
    }, 2800);
  }

  function buildVirtualFileSystemEntry (item) {
    const file = item.file;
    const relPath = item.subfolder ? `${item.subfolder}/${file.name}` : file.name;
    return {
      isFile: true,
      isDirectory: false,
      name: file.name,
      fullPath: `/${relPath}`,
      filesystem: { name: 'guided-upload' },
      file (successCb, errorCb) {
        Promise.resolve(file).then(successCb, errorCb);
      },
      getParent (cb) {
        if (typeof cb === 'function') cb(null);
      }
    };
  }

  function dispatchSyntheticDropToAssetsView (batch) {
    try {
      const dt = new DataTransfer();
      const virtualEntries = [];
      for (const item of batch.files) {
        if (item.file) {
          dt.items.add(item.file);
          virtualEntries.push(buildVirtualFileSystemEntry(item));
        }
      }

      // Attach webkitGetAsEntry on each DataTransferItem so folder-aware drop handlers receive FileSystemEntry objects
      try {
        if (dt.items && dt.items.length) {
          for (let i = 0; i < dt.items.length; i++) {
            const entry = virtualEntries[i];
            if (entry && dt.items[i]) {
              dt.items[i].webkitGetAsEntry = () => entry;
              dt.items[i].getAsEntry = () => entry;
            }
          }
        }
      } catch (e) { /* ignore */ }

      const all = queryAllDeep(document);
      const dropTarget =
        all.find((el) => el.getAttribute && (
          el.getAttribute('role') === 'grid' ||
          el.getAttribute('role') === 'main' ||
          /drop|grid|browse|assets/i.test(el.getAttribute('data-testid') || '')
        )) ||
        document.querySelector('main') ||
        document.body;

      if (!dropTarget) return false;

      globalThis.__guBypassGuardActive = true;
      try {
        for (const type of ['dragenter', 'dragover', 'drop']) {
          const ev = new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            dataTransfer: dt
          });
          ev.__guBypassGuard = true;
          dropTarget.dispatchEvent(ev);
        }
      } finally {
        globalThis.__guBypassGuardActive = false;
      }

      showRefreshToast(
        `📤 AEM Upload Manager active — uploading ${batch.files.length} governed asset${batch.files.length === 1 ? '' : 's'}…`,
        'info',
        5000
      );
      return true;
    } catch (e) {
      console.warn('[Guided Upload] Synthetic drop fallback failed:', e);
      return false;
    }
  }

  function handleNativeUploadHandoff (data = {}) {
    const handoffId = data.handoffId || `handoff-${Date.now()}`;
    const wrappedFiles = (data.files || []).map((item) => {
      const rawFile = item.file;
      let governedFile = rawFile;
      try {
        if (rawFile) {
          governedFile = new window.File([rawFile], item.fileName || rawFile.name, {
            type: item.mimeType || rawFile.type || 'application/octet-stream',
            lastModified: rawFile.lastModified || Date.now()
          });
          if (item.subfolder) {
            Object.defineProperty(governedFile, 'webkitRelativePath', {
              value: `${item.subfolder}/${governedFile.name}`,
              configurable: true
            });
          }
        }
      } catch (e) { /* use rawFile */ }
      return {
        ...item,
        file: governedFile
      };
    });

    const hasSubfolders = wrappedFiles.some((f) => Boolean(f.subfolder));
    const batch = {
      handoffId,
      expiresAt: Date.now() + 8000,
      baseFolder: data.baseFolder || '/content/dam',
      files: wrappedFiles,
      hasSubfolders,
      sharedMetadata: data.sharedMetadata || {},
      actionUrl: data.actionUrl || '',
      authHeaders: data.authHeaders || {},
      aemAuthorUrl: data.aemAuthorUrl || '',
      handoffStartedAt: Number(data.handoffStartedAt) || Date.now(),
      appliedClientIds: new Set()
    };

    // Arm `<input type="file">` / `showOpenFilePicker` interceptor in every frame
    stagedNativeUpload = batch;
    noStoreUntil = Date.now() + 45000;

    // Top frame tracks metadata writeback across `.completeUpload.json` hooks and timestamp polling
    try {
      if (window.top === window) {
        activeMetadataBatch = batch;
        startMetadataWritebackPoller(batch);
      }
    } catch (e) { /* ignore */ }

    if (handledHandoffIds.has(handoffId)) return;

    // Wait briefly for the Guided Upload modal to close, then invoke AEM's native "Add assets" handler
    setTimeout(() => {
      if (!stagedNativeUpload || stagedNativeUpload.handoffId !== handoffId) return;
      const clicked = !hasSubfolders && findAndClickAddAssetsButton();
      if (clicked) {
        handledHandoffIds.add(handoffId);
      }
      // If `<input type="file">.click()` was not intercepted within 600ms (or if uploading subfolders),
      // fall back to dispatching a synthetic drop event onto the Assets View browse grid.
      setTimeout(() => {
        if (!stagedNativeUpload || stagedNativeUpload.handoffId !== handoffId) return;
        const isBrowseFrame = /\/assets\/browse/i.test(location.href || '') || Boolean(findAndClickAddAssetsButton);
        if (isBrowseFrame && !handledHandoffIds.has(`${handoffId}:drop`)) {
          handledHandoffIds.add(`${handoffId}:drop`);
          const activeBatch = stagedNativeUpload;
          stagedNativeUpload = null;
          broadcastToAllFrames({
            [HANDOFF_NS]: 'CLEAR_STAGED_NATIVE_UPLOAD',
            handoffId
          });
          dispatchSyntheticDropToAssetsView(activeBatch);
        }
      }, 600);
    }, 260);
  }

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
    if (now - lastRefreshTriggeredAt < 900) return;

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

    showRefreshToast(
      `🔄 Refreshing folder contents (${count} governed asset${count === 1 ? '' : 's'} committed)…`,
      'info',
      5000
    );

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

    // Stage 1: Fast SPA route bounce so React Router re-fetches the target folder contents without a full reload
    setTimeout(() => {
      try {
        location.hash = bounceHash;
      } catch (e) { /* ignore */ }
      setTimeout(() => {
        try {
          location.hash = targetHash;
        } catch (e) { /* ignore */ }
      }, 240);
    }, 120);

    // Stage 2: Poll DOM for the newly uploaded file/subfolder card to highlight it; if Assets View's internal
    // state cache prevented the grid from updating after the route bounce, fall back to a clean reload.
    let attempts = 0;
    const maxAttempts = 6;
    const poll = setInterval(() => {
      attempts++;
      if (highlightExpectedItemsInDom(expectedNames)) {
        clearInterval(poll);
        const firstLabel = expectedNames[0] ? `"${expectedNames[0]}"` : `${count} asset(s)`;
        showRefreshToast(
          `✓ Folder updated — ${firstLabel}${count > 1 ? ` (+${count - 1} more)` : ''} now visible in ${targetFolder}`,
          'positive',
          5500
        );
        return;
      }
      if (attempts >= maxAttempts) {
        clearInterval(poll);
        try {
          if (location.hash !== targetHash) {
            location.hash = targetHash;
          }
          showRefreshToast('🔄 Reloading folder view to display newly uploaded assets…', 'info', 4000);
          setTimeout(() => {
            location.reload();
          }, 150);
        } catch (e) { /* ignore */ }
      }
    }, 420);
  }

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
