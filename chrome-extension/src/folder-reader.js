// Synchronous FileSystemEntry capture + recursive folder tree traversal for dropped files/folders.
(() => {
  'use strict';
  if (globalThis.__guFolderReader) return;

  const IGNORED_FILES = new Set([
    '.ds_store',
    'thumbs.db',
    'desktop.ini',
    '.spotlight-v100',
    '.trashes'
  ]);

  function shouldIgnore (fileName = '', relativePath = '') {
    const base = String(fileName || '').trim();
    if (!base) return true;
    if (IGNORED_FILES.has(base.toLowerCase())) return true;
    if (base.startsWith('._')) return true;
    if (String(relativePath || '').includes('__MACOSX/')) return true;
    return false;
  }

  function hasFilePayload (dataTransfer) {
    if (!dataTransfer || !dataTransfer.types) return false;
    const types = Array.from(dataTransfer.types);
    return types.includes('Files');
  }

  /**
   * MUST be called synchronously inside the `drop` event handler before any `await`,
   * because Chromium clears `dataTransfer.items` once the event callback yields.
   */
  function captureDropSnapshotSync (dataTransfer) {
    const entries = [];
    const fallbackFiles = [];

    if (dataTransfer && dataTransfer.items && dataTransfer.items.length) {
      for (let i = 0; i < dataTransfer.items.length; i++) {
        const item = dataTransfer.items[i];
        if (item.kind === 'file' && typeof item.webkitGetAsEntry === 'function') {
          const entry = item.webkitGetAsEntry();
          if (entry) entries.push(entry);
        }
      }
    }

    if (dataTransfer && dataTransfer.files && dataTransfer.files.length) {
      for (let i = 0; i < dataTransfer.files.length; i++) {
        fallbackFiles.push(dataTransfer.files[i]);
      }
    }

    return { entries, fallbackFiles };
  }

  function readAllDirectoryEntries (dirReader) {
    return new Promise((resolve, reject) => {
      const all = [];
      const nextBatch = () => {
        dirReader.readEntries(
          (batch) => {
            if (!batch || batch.length === 0) {
              resolve(all);
            } else {
              all.push(...batch);
              nextBatch();
            }
          },
          (err) => reject(err)
        );
      };
      nextBatch();
    });
  }

  function fileFromEntry (fileEntry) {
    return new Promise((resolve, reject) => {
      fileEntry.file(resolve, reject);
    });
  }

  async function traverseEntry (entry, parentPath = '') {
    if (!entry) return [];
    if (entry.isFile) {
      const file = await fileFromEntry(entry);
      const relativePath = parentPath ? `${parentPath}/${file.name}` : file.name;
      if (shouldIgnore(file.name, relativePath)) return [];
      return [{
        file,
        name: file.name,
        size: file.size,
        mimeType: file.type || 'application/octet-stream',
        relativePath,
        subfolder: parentPath
      }];
    }

    if (entry.isDirectory) {
      const nextParent = parentPath ? `${parentPath}/${entry.name}` : entry.name;
      const reader = entry.createReader();
      const children = await readAllDirectoryEntries(reader);
      const out = [];
      for (const child of children) {
        const subItems = await traverseEntry(child, nextParent);
        out.push(...subItems);
      }
      return out;
    }

    return [];
  }

  async function resolveSnapshotToItems (snapshot) {
    const out = [];
    if (snapshot.entries && snapshot.entries.length > 0) {
      for (const entry of snapshot.entries) {
        const items = await traverseEntry(entry, '');
        out.push(...items);
      }
    } else if (snapshot.fallbackFiles && snapshot.fallbackFiles.length > 0) {
      for (const f of snapshot.fallbackFiles) {
        const rel = f.webkitRelativePath || f.name;
        if (shouldIgnore(f.name, rel)) continue;
        const cut = rel.lastIndexOf('/');
        const subfolder = cut > 0 ? rel.slice(0, cut) : '';
        out.push({
          file: f,
          name: f.name,
          size: f.size,
          mimeType: f.type || 'application/octet-stream',
          relativePath: rel,
          subfolder
        });
      }
    }
    return out;
  }

  globalThis.__guFolderReader = {
    hasFilePayload,
    captureDropSnapshotSync,
    resolveSnapshotToItems
  };
})();
