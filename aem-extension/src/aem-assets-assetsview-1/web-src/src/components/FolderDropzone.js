import React, { useRef, useState } from 'react';
import {
  Flex,
  View,
  Text,
  Heading,
  Button,
  ButtonGroup,
  Checkbox,
  ActionButton,
  Divider
} from '@adobe/react-spectrum';
import { sanitizeSubfolderPath } from './NamingEngine';

const IGNORED_OS_FILES = new Set([
  '.ds_store',
  'thumbs.db',
  'desktop.ini',
  '.spotlight-v100',
  '.trashes'
]);

export function shouldIgnoreFile (fileName = '', relativePath = '') {
  const base = String(fileName || '').trim();
  if (!base) return true;
  if (IGNORED_OS_FILES.has(base.toLowerCase())) return true;
  if (base.startsWith('._')) return true;
  if (String(relativePath || '').includes('__MACOSX/')) return true;
  return false;
}

/**
 * Reads all entries from a FileSystemDirectoryReader, looping until an empty batch is returned
 * (Chromium returns at most 100 entries per readEntries call).
 */
function readAllDirectoryEntries (dirReader) {
  return new Promise((resolve, reject) => {
    const all = [];
    const readBatch = () => {
      dirReader.readEntries(
        (batch) => {
          if (!batch || batch.length === 0) {
            resolve(all);
          } else {
            all.push(...batch);
            readBatch();
          }
        },
        (err) => reject(err)
      );
    };
    readBatch();
  });
}

function readFileFromFileEntry (fileEntry) {
  return new Promise((resolve, reject) => {
    fileEntry.file(resolve, reject);
  });
}

/**
 * Recursively traverses a FileSystemEntry (file or directory) and returns flat items
 * `{ file, relativePath, subfolder }`.
 */
export async function traverseFileSystemEntry (entry, parentPath = '') {
  if (!entry) return [];
  if (entry.isFile) {
    const file = await readFileFromFileEntry(entry);
    const relativePath = parentPath ? `${parentPath}/${file.name}` : file.name;
    if (shouldIgnoreFile(file.name, relativePath)) return [];
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
    const nested = [];
    for (const child of children) {
      const items = await traverseFileSystemEntry(child, nextParent);
      nested.push(...items);
    }
    return nested;
  }

  return [];
}

export function formatBytes (bytes = 0) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export default function FolderDropzone ({
  baseFolder = '/content/dam',
  files = [],
  onAddFiles,
  onRemoveFile,
  onClearFiles,
  normalizeSubfolders = true,
  onToggleNormalizeSubfolders,
  handoffSource = null
}) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [scanningFolders, setScanningFolders] = useState(false);
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);

  const handleDrop = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    // CRITICAL: Extract FileSystemEntry roots synchronously before the first await!
    const dt = e.dataTransfer;
    if (!dt) return;

    const syncEntries = [];
    if (dt.items && dt.items.length) {
      for (let i = 0; i < dt.items.length; i++) {
        const item = dt.items[i];
        if (item.kind === 'file' && typeof item.webkitGetAsEntry === 'function') {
          const entry = item.webkitGetAsEntry();
          if (entry) syncEntries.push(entry);
        }
      }
    }

    const fallbackFiles = dt.files ? Array.from(dt.files) : [];

    setScanningFolders(true);
    try {
      const collected = [];
      if (syncEntries.length > 0) {
        for (const entry of syncEntries) {
          const items = await traverseFileSystemEntry(entry, '');
          collected.push(...items);
        }
      } else {
        for (const f of fallbackFiles) {
          const rel = f.webkitRelativePath || f.name;
          if (shouldIgnoreFile(f.name, rel)) continue;
          const cut = rel.lastIndexOf('/');
          const subfolder = cut > 0 ? rel.slice(0, cut) : '';
          collected.push({
            file: f,
            name: f.name,
            size: f.size,
            mimeType: f.type || 'application/octet-stream',
            relativePath: rel,
            subfolder
          });
        }
      }
      if (collected.length > 0 && typeof onAddFiles === 'function') {
        onAddFiles(collected);
      }
    } finally {
      setScanningFolders(false);
    }
  };

  const handleInputChange = (e) => {
    const rawList = e.target.files ? Array.from(e.target.files) : [];
    const collected = [];
    for (const f of rawList) {
      const rel = f.webkitRelativePath || f.name;
      if (shouldIgnoreFile(f.name, rel)) continue;
      const cut = rel.lastIndexOf('/');
      const subfolder = cut > 0 ? rel.slice(0, cut) : '';
      collected.push({
        file: f,
        name: f.name,
        size: f.size,
        mimeType: f.type || 'application/octet-stream',
        relativePath: rel,
        subfolder
      });
    }
    if (collected.length > 0 && typeof onAddFiles === 'function') {
      onAddFiles(collected);
    }
    e.target.value = '';
  };

  // Group queued files by destination subfolder for the folder tree summary
  const folderGroups = {};
  let totalBytes = 0;
  for (const item of files) {
    totalBytes += Number(item.size) || 0;
    const cleanSub = sanitizeSubfolderPath(item.subfolder || '', normalizeSubfolders);
    const key = cleanSub || '(Current Folder Root)';
    if (!folderGroups[key]) folderGroups[key] = [];
    folderGroups[key].push(item);
  }
  const subfolderKeys = Object.keys(folderGroups).sort();
  const hasSubfolders = files.some((f) => Boolean(f.subfolder));

  return (
    <Flex direction="column" gap="size-200">
      {handoffSource && (
        <View backgroundColor="positive" padding="size-125" borderRadius="regular">
          <Text>
            <b>Intercepted Grid Drop:</b> Loaded {files.length} file{files.length === 1 ? '' : 's'} (preserving folder structure) from AEM Assets View drag-and-drop. Complete metadata and naming rules below to commit.
          </Text>
        </View>
      )}

      <div
        className={`gu-dropzone ${isDragOver ? 'gu-dragover' : ''}`}
        onDragEnter={(e) => { e.preventDefault(); setIsDragOver(true); }}
        onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
        onDragLeave={(e) => { e.preventDefault(); setIsDragOver(false); }}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current && fileInputRef.current.click()}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={handleInputChange}
        />
        <input
          ref={folderInputRef}
          type="file"
          webkitdirectory="true"
          directory="true"
          multiple
          style={{ display: 'none' }}
          onChange={handleInputChange}
        />

        <Flex direction="column" alignItems="center" gap="size-125">
          <Heading level={4} margin={0}>
            {scanningFolders
              ? 'Scanning folder hierarchy…'
              : 'Drag and drop files or entire folders here'}
          </Heading>
          <Text>
            Nested folder hierarchies are automatically preserved under <code>{baseFolder}</code>
          </Text>
          <ButtonGroup marginTop="size-100">
            <Button
              variant="primary"
              onPress={() => fileInputRef.current && fileInputRef.current.click()}
            >
              Select Files
            </Button>
            <Button
              variant="secondary"
              onPress={() => folderInputRef.current && folderInputRef.current.click()}
            >
              Select Folder Tree
            </Button>
          </ButtonGroup>
        </Flex>
      </div>

      {files.length > 0 && (
        <View borderWidth="thin" borderColor="dark" borderRadius="regular" padding="size-200">
          <Flex direction="column" gap="size-150">
            <Flex justifyContent="space-between" alignItems="center" wrap>
              <Text>
                <b>{files.length} file{files.length === 1 ? '' : 's'} queued</b> ({formatBytes(totalBytes)}) across <b>{subfolderKeys.length}</b> destination folder{subfolderKeys.length === 1 ? '' : 's'}
              </Text>
              <Flex alignItems="center" gap="size-150">
                {hasSubfolders && (
                  <Checkbox
                    isSelected={normalizeSubfolders}
                    onChange={onToggleNormalizeSubfolders}
                  >
                    Normalize subfolder names to kebab-case
                  </Checkbox>
                )}
                <ActionButton isQuiet onPress={onClearFiles}>
                  Clear All
                </ActionButton>
              </Flex>
            </Flex>

            <Divider size="S" />

            {/* Folder Structure Preview */}
            <View maxHeight="size-3000" overflow="auto">
              <Flex direction="column" gap="size-125">
                {subfolderKeys.map((subKey) => {
                  const groupItems = folderGroups[subKey];
                  const destFolder = subKey === '(Current Folder Root)'
                    ? baseFolder
                    : `${baseFolder}/${subKey}`;
                  return (
                    <View
                      key={subKey}
                      backgroundColor="gray-100"
                      padding="size-125"
                      borderRadius="regular"
                    >
                      <Flex direction="column" gap="size-75">
                        <Flex justifyContent="space-between" alignItems="center">
                          <Text>
                            <b>📁 {destFolder}</b>
                            {subKey !== '(Current Folder Root)' && (
                              <span style={{ marginLeft: '8px', fontSize: '11px', opacity: 0.75 }}>
                                (subfolder will be ensured on commit)
                              </span>
                            )}
                          </Text>
                          <Text>{groupItems.length} file{groupItems.length === 1 ? '' : 's'}</Text>
                        </Flex>
                        {groupItems.map((f) => (
                          <Flex
                            key={f.id}
                            justifyContent="space-between"
                            alignItems="center"
                            marginStart="size-200"
                          >
                            <Text>
                              📄 {f.name}{' '}
                              <span style={{ opacity: 0.65, fontSize: '11.5px' }}>
                                ({formatBytes(f.size)})
                              </span>
                            </Text>
                            <ActionButton
                              isQuiet
                              onPress={() => onRemoveFile && onRemoveFile(f.id)}
                            >
                              ✕
                            </ActionButton>
                          </Flex>
                        ))}
                      </Flex>
                    </View>
                  );
                })}
              </Flex>
            </View>
          </Flex>
        </View>
      )}
    </Flex>
  );
}
