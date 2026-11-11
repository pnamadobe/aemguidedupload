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
  Divider,
  StatusLight
} from '@adobe/react-spectrum';
import UploadToCloud from '@spectrum-icons/workflow/UploadToCloud';
import FolderAdd from '@spectrum-icons/workflow/FolderAdd';
import Folder from '@spectrum-icons/workflow/Folder';
import Document from '@spectrum-icons/workflow/Document';
import Close from '@spectrum-icons/workflow/Close';
import Delete from '@spectrum-icons/workflow/Delete';
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
        <div className="gu-card-subtle">
          <Flex alignItems="center" justifyContent="space-between" wrap gap="size-100">
            <StatusLight variant="positive">
              Loaded {files.length} asset{files.length === 1 ? '' : 's'} from drag-and-drop (folder hierarchy preserved)
            </StatusLight>
          </Flex>
        </div>
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
          <UploadToCloud size="L" UNSAFE_style={{ opacity: 0.7 }} />
          <Heading level={4} margin={0}>
            {scanningFolders
              ? 'Scanning folder hierarchy…'
              : 'Drag and drop files or folders to upload'}
          </Heading>
          <Text UNSAFE_style={{ fontSize: '12.5px', opacity: 0.75 }}>
            Subfolder structures are automatically preserved under <b>{baseFolder}</b>
          </Text>
          <ButtonGroup marginTop="size-125">
            <Button
              variant="primary"
              onPress={() => fileInputRef.current && fileInputRef.current.click()}
            >
              <Document size="S" />
              <Text>Browse Files</Text>
            </Button>
            <Button
              variant="secondary"
              onPress={() => folderInputRef.current && folderInputRef.current.click()}
            >
              <FolderAdd size="S" />
              <Text>Browse Folder</Text>
            </Button>
          </ButtonGroup>
        </Flex>
      </div>

      {files.length > 0 && (
        <div className="gu-card">
          <Flex direction="column" gap="size-150">
            <Flex justifyContent="space-between" alignItems="center" wrap gap="size-100">
              <Flex alignItems="center" gap="size-100">
                <Text UNSAFE_style={{ fontWeight: 600 }}>
                  {files.length} asset{files.length === 1 ? '' : 's'} selected
                </Text>
                <span className="gu-badge-neutral">{formatBytes(totalBytes)}</span>
                {subfolderKeys.length > 1 && (
                  <span className="gu-badge-neutral">{subfolderKeys.length} folders</span>
                )}
              </Flex>
              <Flex alignItems="center" gap="size-150">
                {hasSubfolders && (
                  <Checkbox
                    isSelected={normalizeSubfolders}
                    onChange={onToggleNormalizeSubfolders}
                  >
                    Normalize folder names
                  </Checkbox>
                )}
                <ActionButton isQuiet onPress={onClearFiles}>
                  <Delete size="S" />
                  <Text>Clear All</Text>
                </ActionButton>
              </Flex>
            </Flex>

            <Divider size="S" />

            {/* Folder Structure Preview */}
            <View maxHeight="size-3000" overflow="auto">
              <Flex direction="column" gap="size-100">
                {subfolderKeys.map((subKey) => {
                  const groupItems = folderGroups[subKey];
                  const destFolder = subKey === '(Current Folder Root)'
                    ? baseFolder
                    : `${baseFolder}/${subKey}`;
                  return (
                    <div key={subKey} className="gu-card-subtle">
                      <Flex direction="column" gap="size-75">
                        <Flex justifyContent="space-between" alignItems="center">
                          <Flex alignItems="center" gap="size-75">
                            <Folder size="S" />
                            <Text UNSAFE_style={{ fontWeight: 600, fontSize: '12.5px' }}>
                              {destFolder}
                            </Text>
                            {subKey !== '(Current Folder Root)' && (
                              <span className="gu-badge-neutral">New Subfolder</span>
                            )}
                          </Flex>
                          <Text UNSAFE_style={{ fontSize: '12px', opacity: 0.7 }}>
                            {groupItems.length} item{groupItems.length === 1 ? '' : 's'}
                          </Text>
                        </Flex>
                        <Flex direction="column" gap="size-25" marginStart="size-200">
                          {groupItems.map((f) => (
                            <div key={f.id} className="gu-file-row">
                              <Flex alignItems="center" gap="size-100">
                                <Document size="XS" />
                                <Text UNSAFE_style={{ fontSize: '12.5px' }}>{f.name}</Text>
                                <Text UNSAFE_style={{ opacity: 0.6, fontSize: '11.5px' }}>
                                  {formatBytes(f.size)}
                                </Text>
                              </Flex>
                              <ActionButton
                                isQuiet
                                aria-label={`Remove ${f.name}`}
                                onPress={() => onRemoveFile && onRemoveFile(f.id)}
                              >
                                <Close size="XS" />
                              </ActionButton>
                            </div>
                          ))}
                        </Flex>
                      </Flex>
                    </div>
                  );
                })}
              </Flex>
            </View>
          </Flex>
        </div>
      )}
    </Flex>
  );
}
