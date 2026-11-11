import React, { useState, useEffect, useMemo, useRef } from 'react';
import { attach } from '@adobe/uix-guest';
import {
  Flex,
  Provider,
  defaultTheme,
  Text,
  Heading,
  ButtonGroup,
  Button,
  View,
  ProgressCircle,
  ProgressBar,
  StatusLight,
  TextField,
  Picker,
  Item,
  ActionButton,
  Divider
} from '@adobe/react-spectrum';
import Folder from '@spectrum-icons/workflow/Folder';
import Edit from '@spectrum-icons/workflow/Edit';
import Alert from '@spectrum-icons/workflow/Alert';

import { extensionId, HANDOFF_MESSAGE_NS, STORAGE_KEY_CTX, isTrustedMessageOrigin } from './Constants';
import FolderDropzone, { shouldIgnoreFile } from './FolderDropzone';
import DynamicSchemaForm, { humanTitleFromFileName } from './DynamicSchemaForm';
import { validateMetadataValues } from './ValidationRules';
import { computeBatchNamingPlan } from './NamingEngine';
import actionWebInvoke, { uploadBinaryToPresignedUris } from '../utils';
import actionsConfig from '../config.json';

function readInitialContext () {
  const hash = window.location.hash || '';
  const qIdx = hash.indexOf('?');
  const sp = new URLSearchParams(qIdx >= 0 ? hash.slice(qIdx + 1) : window.location.search);
  const urlFolder = sp.get('folder') || '';

  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY_CTX) || '{}');
    return {
      folderPath: urlFolder || stored.folderPath || '/content/dam'
    };
  } catch (e) {
    return {
      folderPath: urlFolder || '/content/dam'
    };
  }
}

function resolveActionUrl (actionName = 'guided-upload-api') {
  const hit = Object.entries(actionsConfig || {}).find(
    ([k]) => k.endsWith(`/${actionName}`) || k === actionName
  );
  return hit ? hit[1] : null;
}

async function getHostAuthHeaders (gc) {
  if (!gc) return {};
  let token = '';
  let imsOrg = '';
  try {
    const info = await gc.host.auth.getIMSInfo();
    if (info) {
      if (info.accessToken) token = info.accessToken;
      else if (info.token) token = info.token;
      if (info.imsOrg) imsOrg = info.imsOrg;
      else if (info.org) imsOrg = info.org;
    }
  } catch (e) {
    // ignore
  }
  try {
    const shared = gc.sharedContext && gc.sharedContext.get('auth');
    if (shared) {
      if (!token && (shared.imsToken || shared.accessToken)) {
        token = shared.imsToken || shared.accessToken;
      }
      if (!imsOrg && (shared.imsOrg || shared.org)) {
        imsOrg = shared.imsOrg || shared.org;
      }
    }
  } catch (e) {
    // ignore
  }
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (imsOrg) headers['x-gw-ims-org-id'] = imsOrg;
  return headers;
}

function createClientFallbackSchema (folderPath = '/content/dam') {
  const requiredFields = [
    {
      id: 'xdm_campaignName',
      property: 'xdm:campaignName',
      label: 'Campaign Name',
      tab: 'Workfront',
      section: '',
      type: 'text',
      required: true,
      requiredSource: 'governance-policy',
      placeholder: 'e.g. Winter-2026',
      options: []
    },
    {
      id: 'xcm_keywords',
      property: 'xcm:keywords',
      label: 'Tags',
      tab: 'Basic',
      section: 'Metadata',
      type: 'tag_picker',
      required: true,
      requiredSource: 'governance-policy',
      placeholder: 'Select taxonomy tags',
      options: []
    },
    {
      id: 'dc_license',
      property: 'dc:license',
      label: 'License Agreement',
      tab: 'Rights',
      section: 'License',
      type: 'dropdown',
      required: true,
      requiredSource: 'governance-policy',
      placeholder: 'Select License Agreement',
      options: [
        { id: '/content/dam/licenses/jll/DAM_Internal_User_Terms_US_v4.2.pdf', name: 'DAM Internal User Terms of Use' },
        { id: '/content/dam/licenses/jll/DAM_External_Partner_License_US_v3.7.pdf', name: 'DAM External Partner License — US' },
        { id: '/content/dam/licenses/jll/DAM_External_Partner_Licence_EMEA_v3.7.pdf', name: 'DAM External Partner Licence — EMEA' }
      ]
    },
    {
      id: 'drm_channelAllowed',
      property: 'drm:channelAllowed',
      label: 'Channels Allowed',
      tab: 'Workfront',
      section: '',
      type: 'dropdown',
      required: true,
      requiredSource: 'governance-policy',
      placeholder: 'Select Option',
      options: [
        { id: 'web', name: 'web' },
        { id: 'email', name: 'email' },
        { id: 'digital', name: 'digital' },
        { id: 'social', name: 'social' },
        { id: 'print', name: 'print' }
      ]
    },
    {
      id: 'drm_region',
      property: 'drm:region',
      label: 'Region',
      tab: 'Workfront',
      section: '',
      type: 'dropdown',
      required: true,
      requiredSource: 'governance-policy',
      placeholder: 'Select Region',
      options: [
        { id: 'north_america', name: 'North America' },
        { id: 'emea', name: 'EMEA' },
        { id: 'apac', name: 'APAC' }
      ]
    },
    {
      id: 'pur_expirationDate',
      property: 'pur:expirationDate',
      label: 'Expires',
      tab: 'Rights',
      section: 'License',
      type: 'datepicker',
      required: true,
      requiredSource: 'governance-policy',
      placeholder: 'YYYY-MM-DD',
      options: []
    }
  ];

  const optionalFields = [
    {
      id: 'dc_title',
      property: 'dc:title',
      label: 'Title',
      tab: 'Basic',
      section: 'Metadata',
      type: 'text',
      required: false,
      placeholder: 'Leave blank for AEM AI-generated title',
      options: []
    },
    {
      id: 'dc_description',
      property: 'dc:description',
      label: 'Description',
      tab: 'Basic',
      section: 'Metadata',
      type: 'textarea',
      required: false,
      placeholder: '',
      options: []
    },
    {
      id: 'product_brand',
      property: 'product:brand',
      label: 'Product Brand',
      tab: 'Basic',
      section: 'Metadata',
      type: 'text',
      required: false,
      placeholder: '',
      options: []
    },
    {
      id: 'dam_status',
      property: 'dam:status',
      label: 'Review Status',
      tab: 'Basic',
      section: 'Metadata',
      type: 'dropdown',
      required: false,
      placeholder: 'Select Option',
      options: [
        { id: 'approved', name: 'Approved' },
        { id: 'rejected', name: 'Rejected' }
      ]
    }
  ];

  return {
    folderPath,
    schemaName: 'default-governance',
    inheritedFrom: folderPath,
    isInherited: false,
    sourcePath: '/content/dam/appdata/metadataforms/default',
    sourceType: 'fallback',
    requirementMode: 'smart-governance-promotion',
    totalFields: requiredFields.length + optionalFields.length,
    requiredFields,
    optionalFields,
    allFields: [...requiredFields, ...optionalFields],
    naming: {
      defaultPattern: '{folder}_{campaignName}_{channelAllowed}_{seq}',
      schemaName: 'default-governance',
      tokens: [
        { key: 'folder', property: '__folder', label: 'Current Folder Name', builtIn: true },
        { key: 'subfolder', property: '__subfolder', label: 'Dropped Subfolder Name', builtIn: true },
        { key: 'origName', property: '__origName', label: 'Original Filename Stem', builtIn: true },
        { key: 'date', property: '__date', label: 'Upload Date (YYYYMMDD)', builtIn: true },
        { key: 'seq', property: '__seq', label: 'Sequence (001, 002...)', builtIn: true },
        { key: 'title', property: 'dc:title', label: 'Title', required: true },
        { key: 'campaignName', property: 'xdm:campaignName', label: 'Campaign Name', required: true },
        { key: 'channelAllowed', property: 'drm:channelAllowed', label: 'Channels Allowed', required: true },
        { key: 'region', property: 'drm:region', label: 'Region', required: true },
        { key: 'brand', property: 'product:brand', label: 'Product Brand', required: false }
      ]
    }
  };
}

let nextFileSeqId = 1;

export default function ModalGuidedUpload () {
  const initialCtx = useMemo(() => readInitialContext(), []);
  const [guestConnection, setGuestConnection] = useState(null);
  const [hostReady, setHostReady] = useState(false);
  const [colorScheme, setColorScheme] = useState('light');

  const [folderPath, setFolderPath] = useState(initialCtx.folderPath || '/content/dam');
  const [folderInput, setFolderInput] = useState(initialCtx.folderPath || '/content/dam');
  const [editingFolder, setEditingFolder] = useState(false);
  const [aemAuthorUrl, setAemAuthorUrl] = useState('');

  // Wizard step: 1 = Files & Folder Tree, 2 = Folder Metadata & Rights, 3 = Naming & Commit
  const [step, setStep] = useState(1);

  // Files state
  const [queuedFiles, setQueuedFiles] = useState([]);
  const [normalizeSubfolders, setNormalizeSubfolders] = useState(true);
  const [handoffSource, setHandoffSource] = useState(null);

  // Schema & Metadata state
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [schemaError, setSchemaError] = useState('');
  const [schema, setSchema] = useState(() => createClientFallbackSchema(initialCtx.folderPath));
  const [availableTags, setAvailableTags] = useState([]);
  const [metadataValues, setMetadataValues] = useState({});
  const [perAssetTitles, setPerAssetTitles] = useState({});

  // Naming state
  const [namingPattern, setNamingPattern] = useState('{folder}_{origName}_{seq}');
  const [caseStyle, setCaseStyle] = useState('kebab');
  const [manualNameOverrides, setManualNameOverrides] = useState({});

  // Upload commit state
  const [uploading, setUploading] = useState(false);
  const [uploadPhase, setUploadPhase] = useState('');
  const [uploadProgress, setUploadProgress] = useState({ currentFile: '', completedFiles: 0, totalFiles: 0, currentFilePercent: 0 });
  const [uploadError, setUploadError] = useState('');
  const [duplicateConflicts, setDuplicateConflicts] = useState([]);
  const [completedResult, setCompletedResult] = useState(null);
  const completedResultRef = useRef(null);
  const refreshSentRef = useRef(false);
  const uploadAbortRef = useRef(null);

  const fileDedupKey = (item) => {
    const lm = (item && item.lastModified) || (item && item.file && item.file.lastModified) || 0;
    return `${item.relativePath}|${item.size}|${lm}`;
  };

  const postHostMessage = (payload) => {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(payload, '*');
      }
      if (window.top && window.top !== window && window.top !== window.parent) {
        window.top.postMessage(payload, '*');
      }
    } catch (e) {
      // ignore cross-frame postMessage errors
    }
  };

  useEffect(() => {
    const onPageHide = () => {
      const done = completedResultRef.current;
      if (done && !refreshSentRef.current) {
        refreshSentRef.current = true;
        postHostMessage({
          [HANDOFF_MESSAGE_NS]: 'REFRESH_FOLDER_VIEW',
          folderPath: done.baseFolder || '/content/dam',
          baseFolder: done.baseFolder || '/content/dam',
          completedCount: done.completedCount || (done.assets ? done.assets.length : 1),
          assets: (done.assets || []).map((a) => ({
            fileName: a.fileName,
            targetFolder: a.targetFolder,
            damPath: a.damPath
          }))
        });
      }
    };
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      onPageHide();
    };
  }, []);

  // Attach to AEM Assets View host
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const gc = await attach({ id: extensionId });
        if (!mounted) return;
        setGuestConnection(gc);

        try {
          const themeInfo = await gc.host.theme.getThemeInfo();
          if (mounted && themeInfo?.colorScheme) setColorScheme(themeInfo.colorScheme);
        } catch (e) { /* ignore */ }

        try {
          const payload = await gc.host.modal.getPayload();
          if (mounted && payload) {
            if (payload.folderPath) {
              setFolderPath(payload.folderPath);
              setFolderInput(payload.folderPath);
            }
            if (payload.aemAuthorUrl) {
              setAemAuthorUrl(payload.aemAuthorUrl);
            }
          }
        } catch (e) { /* ignore */ }

        try {
          if (gc.host?.discovery?.getAemHost) {
            const host = await gc.host.discovery.getAemHost();
            if (mounted && host) {
              const normalized = String(host).startsWith('http') ? host : `https://${host}`;
              setAemAuthorUrl((prev) => prev || normalized.replace(/\/+$/, ''));
            }
          }
        } catch (e) { /* ignore */ }
      } catch (e) {
        // Running standalone outside Assets View host
      } finally {
        if (mounted) setHostReady(true);
      }
    })();
    return () => { mounted = false; };
  }, []);

  // Cross-Frame Chrome Extension Drop Handoff Listener
  useEffect(() => {
    const onMessage = (event) => {
      if (!event || !isTrustedMessageOrigin(event.origin)) return;
      const data = event.data;
      if (!data || data[HANDOFF_MESSAGE_NS] !== 'DROPPED_FILES') return;

      if (data.folderPath && data.folderPath.startsWith('/content/dam')) {
        setFolderPath(data.folderPath);
        setFolderInput(data.folderPath);
      }

      if (Array.isArray(data.items) && data.items.length > 0) {
        const mapped = [];
        for (const it of data.items) {
          const f = it.file;
          if (!f) continue;
          const rel = it.relativePath || f.webkitRelativePath || f.name;
          if (shouldIgnoreFile(f.name, rel)) continue;
          const cut = rel.lastIndexOf('/');
          const subfolder = it.subfolder !== undefined ? it.subfolder : (cut > 0 ? rel.slice(0, cut) : '');
          mapped.push({
            id: `file-${nextFileSeqId++}`,
            file: f,
            name: f.name,
            size: f.size,
            lastModified: f.lastModified || 0,
            mimeType: f.type || 'application/octet-stream',
            relativePath: rel,
            subfolder
          });
        }
        if (mapped.length > 0) {
          setQueuedFiles((prev) => {
            const existingKeys = new Set(prev.map(fileDedupKey));
            const fresh = mapped.filter((m) => !existingKeys.has(fileDedupKey(m)));
            return [...prev, ...fresh];
          });
          setHandoffSource('chrome-extension');
        }
      }
    };

    window.addEventListener('message', onMessage);

    // Notify parent/top window that the Guided Upload Modal is ready to receive any dropped files
    const notifyReady = () => {
      try {
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({ [HANDOFF_MESSAGE_NS]: 'MODAL_READY' }, '*');
        }
        if (window.top && window.top !== window && window.top !== window.parent) {
          window.top.postMessage({ [HANDOFF_MESSAGE_NS]: 'MODAL_READY' }, '*');
        }
      } catch (e) {
        // ignore
      }
    };

    notifyReady();
    const t1 = setTimeout(notifyReady, 250);
    const t2 = setTimeout(notifyReady, 750);

    return () => {
      window.removeEventListener('message', onMessage);
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, []);

  // Resolve Folder Metadata Schema once `hostReady` is true and `folderPath` / `guestConnection` settle
  useEffect(() => {
    if (!hostReady) return;
    let cancelled = false;
    const loadSchema = async () => {
      const actionUrl = resolveActionUrl('guided-upload-api');
      if (!actionUrl) {
        const fallback = createClientFallbackSchema(folderPath);
        setSchema(fallback);
        setNamingPattern(fallback.naming.defaultPattern);
        return;
      }

      const headers = await getHostAuthHeaders(guestConnection);
      if (cancelled) return;
      if (!headers.Authorization) {
        const fallback = createClientFallbackSchema(folderPath);
        setSchema(fallback);
        setNamingPattern(fallback.naming.defaultPattern);
        return;
      }

      setSchemaLoading(true);
      setSchemaError('');
      try {
        const res = await actionWebInvoke(actionUrl, headers, {
          op: 'resolveSchema',
          folderPath,
          ...(aemAuthorUrl ? { aemAuthorUrl } : {})
        });
        if (cancelled) return;
        if (res && res.schema) {
          setSchema(res.schema);
          if (res.schema.naming && res.schema.naming.defaultPattern) {
            setNamingPattern(res.schema.naming.defaultPattern);
          }
          if (Array.isArray(res.tags)) {
            setAvailableTags(res.tags);
          }
        }
      } catch (err) {
        if (cancelled) return;
        setSchemaError(err.message || 'Could not load folder schema from AEM; using default governance schema.');
        const fallback = createClientFallbackSchema(folderPath);
        setSchema(fallback);
      } finally {
        if (!cancelled) setSchemaLoading(false);
      }
    };

    loadSchema();
    return () => { cancelled = true; };
  }, [hostReady, folderPath, aemAuthorUrl, guestConnection]);

  const handleAddFiles = (items = []) => {
    const mapped = items.map((it) => ({
      id: `file-${nextFileSeqId++}`,
      file: it.file,
      name: it.name,
      size: it.size,
      lastModified: (it.file && it.file.lastModified) || it.lastModified || 0,
      mimeType: it.mimeType || (it.file && it.file.type) || 'application/octet-stream',
      relativePath: it.relativePath || it.name,
      subfolder: it.subfolder || ''
    }));
    setQueuedFiles((prev) => {
      const existingKeys = new Set(prev.map(fileDedupKey));
      const fresh = mapped.filter((m) => !existingKeys.has(fileDedupKey(m)));
      return [...prev, ...fresh];
    });
  };

  const handleRemoveFile = (id) => {
    setQueuedFiles((prev) => prev.filter((f) => f.id !== id));
    setPerAssetTitles((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const handleClearFiles = () => {
    setQueuedFiles([]);
    setPerAssetTitles({});
    setManualNameOverrides({});
    setHandoffSource(null);
  };

  const handleChangeMetadata = (property, value) => {
    setMetadataValues((prev) => ({
      ...prev,
      [property]: value
    }));
  };

  const handleChangePerAssetTitle = (fileId, titleVal) => {
    setPerAssetTitles((prev) => ({
      ...prev,
      [fileId]: titleVal
    }));
  };

  const validation = useMemo(
    () => validateMetadataValues(metadataValues, schema ? schema.allFields : [], {
      queuedFiles,
      perAssetTitles
    }),
    [metadataValues, schema, queuedFiles, perAssetTitles]
  );

  const namingPlan = useMemo(
    () => computeBatchNamingPlan({
      files: queuedFiles,
      pattern: namingPattern,
      baseFolder: folderPath,
      metadataValues,
      schemaTokens: (schema && schema.naming && schema.naming.tokens) || [],
      caseStyle,
      normalizeSubfolders,
      manualOverrides: manualNameOverrides
    }),
    [queuedFiles, namingPattern, folderPath, metadataValues, schema, caseStyle, normalizeSubfolders, manualNameOverrides]
  );

  const insertTokenIntoPattern = (tokenKey) => {
    const tokenStr = `{${tokenKey}}`;
    setNamingPattern((prev) => {
      const trimmed = String(prev || '').trim();
      if (!trimmed) return tokenStr;
      return `${trimmed}_${tokenStr}`;
    });
  };

  const closeDialog = () => {
    if (uploadAbortRef.current) {
      try {
        uploadAbortRef.current.abort();
      } catch (e) { /* ignore */ }
      uploadAbortRef.current = null;
    }
    if (guestConnection && guestConnection.host?.modal?.closeDialog) {
      guestConnection.host.modal.closeDialog();
    }
  };

  const triggerFolderRefreshAndClose = (targetFolderOverride) => {
    const done = completedResult || completedResultRef.current;
    const destFolder = targetFolderOverride || folderPath;
    if (done) {
      refreshSentRef.current = true;
      postHostMessage({
        [HANDOFF_MESSAGE_NS]: 'REFRESH_FOLDER_VIEW',
        folderPath: destFolder,
        baseFolder: folderPath,
        completedCount: done.completedCount || (done.assets ? done.assets.length : 1),
        assets: (done.assets || []).map((a) => ({
          fileName: a.fileName,
          targetFolder: a.targetFolder,
          damPath: a.damPath
        }))
      });
    }
    closeDialog();
  };

  const handleCommitUpload = async (duplicateResolution = 'ask') => {
    const resolutionMode = typeof duplicateResolution === 'string' ? duplicateResolution : 'ask';
    setUploadError('');
    if (resolutionMode !== 'ask') {
      setDuplicateConflicts([]);
    }
    if (!queuedFiles.length) {
      setUploadError('Please add at least one file before uploading.');
      return;
    }
    if (!validation.valid) {
      setUploadError(`Please complete all required metadata fields (${validation.errors.length} remaining).`);
      setStep(2);
      return;
    }
    if (!namingPlan.allValid) {
      setUploadError('Please resolve filename validation issues before uploading.');
      return;
    }

    const actionUrl = resolveActionUrl('guided-upload-api');
    if (!actionUrl) {
      setUploadError('Runtime action URL (guided-upload-api) is not configured in config.json. Run `aio app run` or `aio app deploy`.');
      return;
    }

    setUploading(true);
    setUploadPhase('Checking destination folder & initiating upload in AEM…');
    setUploadProgress({
      currentFile: '',
      completedFiles: 0,
      totalFiles: namingPlan.items.length,
      currentFilePercent: 0
    });

    try {
      const headers = await getHostAuthHeaders(guestConnection);
      if (!headers.Authorization) {
        throw new Error('Missing user authentication token from AEM Assets View host. Please reload and sign in.');
      }

      // Step 1: Initiate batch upload (checks duplicates, creates subfolders, returns pre-signed uploadURIs)
      const initPayload = {
        op: 'initiate',
        baseFolder: folderPath,
        duplicateResolution: resolutionMode,
        ...(aemAuthorUrl ? { aemAuthorUrl } : {}),
        files: namingPlan.items.map((item) => ({
          clientId: item.id,
          fileName: item.governedName,
          fileSize: item.size,
          mimeType: item.mimeType,
          subfolder: item.cleanSubfolder
        }))
      };

      const initRes = await actionWebInvoke(actionUrl, headers, initPayload);
      if (initRes && initRes.duplicateConflict && Array.isArray(initRes.duplicates) && initRes.duplicates.length > 0) {
        setDuplicateConflicts(initRes.duplicates);
        setUploading(false);
        setUploadPhase('');
        return;
      }

      const initiatedFiles = (initRes && initRes.files) || [];
      if (!initiatedFiles.length) {
        if (resolutionMode === 'skip') {
          setUploading(false);
          setUploadPhase('');
          closeDialog();
          return;
        }
        throw new Error('AEM initiateUpload returned no file descriptors.');
      }

      // Step 2: Direct browser-to-Blob PUT for each file
      const abortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
      uploadAbortRef.current = abortController;
      const fileById = new Map(namingPlan.items.map((it) => [it.id, it]));
      for (let i = 0; i < initiatedFiles.length; i++) {
        const desc = initiatedFiles[i];
        const localItem = fileById.get(desc.clientId);
        if (!localItem || !localItem.file) {
          throw new Error(`Missing local file handle for ${desc.fileName}`);
        }

        setUploadPhase(`Uploading binary ${i + 1} of ${initiatedFiles.length}: ${desc.fileName}`);
        setUploadProgress({
          currentFile: desc.fileName,
          completedFiles: i,
          totalFiles: initiatedFiles.length,
          currentFilePercent: 0
        });

        await uploadBinaryToPresignedUris(
          localItem.file,
          desc.uploadURIs,
          ({ percent }) => {
            setUploadProgress({
              currentFile: desc.fileName,
              completedFiles: i,
              totalFiles: initiatedFiles.length,
              currentFilePercent: percent
            });
          },
          {
            minPartSize: desc.minPartSize,
            maxPartSize: desc.maxPartSize,
            signal: abortController ? abortController.signal : undefined
          }
        );
      }
      uploadAbortRef.current = null;

      // Step 3: Complete upload & write governed schema metadata to jcr:content/metadata
      // Note: If dc:title was left blank, omit it so AEM's built-in AI-Generated Metadata
      // machinery automatically assigns an AI-generated title during post-upload processing.
      setUploadPhase('Committing assets & writing folder schema metadata…');
      const cleanedSharedMeta = { ...metadataValues };
      if (typeof cleanedSharedMeta['dc:title'] === 'string' && !cleanedSharedMeta['dc:title'].trim()) {
        delete cleanedSharedMeta['dc:title'];
      }
      const completePayload = {
        op: 'complete',
        baseFolder: folderPath,
        ...(aemAuthorUrl ? { aemAuthorUrl } : {}),
        sharedMetadata: cleanedSharedMeta,
        files: initiatedFiles.map((desc) => {
          const rawTitle = perAssetTitles[desc.clientId];
          const cleanTitle = typeof rawTitle === 'string' ? rawTitle.trim() : '';
          return {
            clientId: desc.clientId,
            fileName: desc.fileName,
            targetFolder: desc.targetFolder,
            mimeType: desc.mimeType,
            fileSize: desc.fileSize,
            uploadToken: desc.uploadToken,
            replace: Boolean(desc.replace),
            createVersion: Boolean(desc.createVersion),
            metadata: cleanTitle ? { 'dc:title': cleanTitle } : {}
          };
        })
      };

      const completeRes = await actionWebInvoke(actionUrl, headers, completePayload);
      const summary = {
        ...completeRes,
        baseFolder: folderPath
      };
      completedResultRef.current = summary;
      refreshSentRef.current = true;

      const refreshPayload = {
        folderPath,
        baseFolder: folderPath,
        completedCount: completeRes.completedCount || initiatedFiles.length,
        assets: (completeRes.assets || []).map((a) => ({
          fileName: a.fileName,
          targetFolder: a.targetFolder,
          damPath: a.damPath
        }))
      };

      // Notify parent/top window once to refresh the AEM Assets View folder contents
      postHostMessage({
        [HANDOFF_MESSAGE_NS]: 'REFRESH_FOLDER_VIEW',
        ...refreshPayload
      });

      if (guestConnection && guestConnection.host?.toast?.display) {
        try {
          guestConnection.host.toast.display({
            variant: 'positive',
            message: `Uploaded ${completeRes.completedCount || initiatedFiles.length} governed asset(s) to ${folderPath}`
          });
        } catch (e) { /* ignore toast error */ }
      }

      // Immediately close the modal and return the user to the main AEM Assets View app
      closeDialog();
    } catch (err) {
      setUploadError(err.message || String(err));
    } finally {
      setUploading(false);
      setUploadPhase('');
    }
  };

  const overallUploadPercent = uploadProgress.totalFiles > 0
    ? Math.min(
      100,
      Math.round(
        ((uploadProgress.completedFiles + (uploadProgress.currentFilePercent || 0) / 100) /
          uploadProgress.totalFiles) *
          100
      )
    )
    : 0;

  return (
    <Provider theme={defaultTheme} colorScheme={colorScheme}>
      <View padding="size-250">
        <Flex direction="column" gap="size-200">
          {/* AEM Assets View Folder & Metadata Form Context Bar */}
          <div className="gu-context-bar">
            {!editingFolder ? (
              <div className="gu-folder-crumb">
                <Folder size="S" />
                <span className="gu-folder-path">{folderPath}</span>
                <ActionButton
                  isQuiet
                  aria-label="Change destination folder"
                  onPress={() => {
                    setFolderInput(folderPath);
                    setEditingFolder(true);
                  }}
                >
                  <Edit size="XS" />
                </ActionButton>
              </div>
            ) : (
              <Flex gap="size-100" alignItems="end" wrap flex="1">
                <TextField
                  aria-label="Destination folder path"
                  value={folderInput}
                  onChange={setFolderInput}
                  width="size-4600"
                />
                <ActionButton
                  onPress={() => {
                    const cleaned = folderInput.trim().replace(/\/+$/, '') || '/content/dam';
                    setFolderPath(cleaned);
                    setEditingFolder(false);
                  }}
                >
                  Apply
                </ActionButton>
                <ActionButton
                  isQuiet
                  onPress={() => {
                    setFolderInput(folderPath);
                    setEditingFolder(false);
                  }}
                >
                  Cancel
                </ActionButton>
              </Flex>
            )}

            <Flex alignItems="center" gap="size-100">
              {schemaLoading && <ProgressCircle size="S" isIndeterminate aria-label="Loading schema" />}
              <span className="gu-badge-neutral">
                Form: {schema ? schema.schemaName : 'loading…'}
              </span>
            </Flex>
          </div>

          {schemaError && (
            <StatusLight variant="notice">
              {schemaError}
            </StatusLight>
          )}

          {/* Native Spectrum Horizontal Wizard Stepper */}
          <div className="gu-stepper" role="navigation" aria-label="Upload steps">
            <button
              type="button"
              className={`gu-step-btn ${step === 1 ? 'is-active' : (queuedFiles.length > 0 ? 'is-complete' : '')}`}
              onClick={() => setStep(1)}
            >
              <span className="gu-step-circle">
                {step > 1 && queuedFiles.length > 0 ? '✓' : '1'}
              </span>
              <span>
                <div className="gu-step-label">Select Assets</div>
                <div className="gu-step-sub">
                  {queuedFiles.length > 0 ? `${queuedFiles.length} selected` : 'Files or folders'}
                </div>
              </span>
            </button>

            <div className="gu-step-connector" />

            <button
              type="button"
              className={`gu-step-btn ${step === 2 ? 'is-active' : (queuedFiles.length > 0 && validation.valid && step > 2 ? 'is-complete' : '')}`}
              disabled={queuedFiles.length === 0}
              onClick={() => setStep(2)}
            >
              <span className="gu-step-circle">
                {queuedFiles.length > 0 && validation.valid && step > 2 ? '✓' : '2'}
              </span>
              <span>
                <div className="gu-step-label">Metadata & Rights</div>
                <div className="gu-step-sub">
                  {validation.valid ? 'Complete' : `${validation.errors.length} required`}
                </div>
              </span>
            </button>

            <div className="gu-step-connector" />

            <button
              type="button"
              className={`gu-step-btn ${step === 3 ? 'is-active' : ''}`}
              disabled={queuedFiles.length === 0 || !validation.valid}
              onClick={() => setStep(3)}
            >
              <span className="gu-step-circle">3</span>
              <span>
                <div className="gu-step-label">File Naming & Upload</div>
                <div className="gu-step-sub">
                  {namingPlan.allValid ? 'Ready' : 'Review names'}
                </div>
              </span>
            </button>
          </div>

          <Divider size="S" />

          {/* STEP 1: Dropzone & Folder Hierarchy */}
          {step === 1 && (
            <FolderDropzone
              baseFolder={folderPath}
              files={queuedFiles}
              onAddFiles={handleAddFiles}
              onRemoveFile={handleRemoveFile}
              onClearFiles={handleClearFiles}
              normalizeSubfolders={normalizeSubfolders}
              onToggleNormalizeSubfolders={setNormalizeSubfolders}
              handoffSource={handoffSource}
            />
          )}

          {/* STEP 2: Dynamic Folder Metadata Schema Form */}
          {step === 2 && (
            <DynamicSchemaForm
              schema={schema}
              values={metadataValues}
              onChangeValue={handleChangeMetadata}
              availableTags={availableTags}
              queuedFiles={queuedFiles}
              perAssetTitles={perAssetTitles}
              onChangePerAssetTitle={handleChangePerAssetTitle}
              onBatchSetPerAssetTitles={setPerAssetTitles}
              validation={validation}
            />
          )}

          {/* STEP 3: Auto-Naming Engine & Upload */}
          {step === 3 && (
            <Flex direction="column" gap="size-200">
              <div className="gu-card">
                <Flex direction="column" gap="size-150">
                  <Heading level={4} margin={0}>
                    Naming Convention
                  </Heading>
                  <Text UNSAFE_style={{ fontSize: '12.5px', opacity: 0.8 }}>
                    Select tokens below to build the filename pattern using the <b>{schema.schemaName}</b> metadata values.
                  </Text>

                  <Flex gap="size-150" wrap alignItems="end">
                    <TextField
                      label="Filename Pattern"
                      value={namingPattern}
                      onChange={setNamingPattern}
                      width="size-4600"
                    />
                    <Picker
                      label="Case Format"
                      selectedKey={caseStyle}
                      onSelectionChange={(k) => k && setCaseStyle(String(k))}
                      width="size-2400"
                    >
                      <Item key="kebab">kebab-case</Item>
                      <Item key="snake">snake_case</Item>
                      <Item key="camel">camelCase</Item>
                      <Item key="preserve">Preserve Case</Item>
                    </Picker>
                    {Object.keys(manualNameOverrides).length > 0 && (
                      <ActionButton isQuiet onPress={() => setManualNameOverrides({})}>
                        Reset Custom Names
                      </ActionButton>
                    )}
                  </Flex>

                  <Flex wrap gap="size-75" alignItems="center">
                    <Text UNSAFE_style={{ fontSize: '12px', fontWeight: 600, opacity: 0.8 }}>
                      Tokens:
                    </Text>
                    {((schema && schema.naming && schema.naming.tokens) || []).map((tok) => (
                      <button
                        key={tok.key}
                        type="button"
                        className="gu-token-btn"
                        title={tok.label}
                        onClick={() => insertTokenIntoPattern(tok.key)}
                      >
                        {`{${tok.key}}`}
                        <span style={{ opacity: 0.65, fontSize: '11px', fontFamily: 'inherit' }}>
                          {tok.label}
                        </span>
                      </button>
                    ))}
                  </Flex>
                </Flex>
              </div>

              {/* Filename & Folder Placement Preview Table */}
              <div className="gu-card">
                <Flex direction="column" gap="size-125">
                  <Flex justifyContent="space-between" alignItems="center">
                    <Heading level={4} margin={0}>
                      Asset Preview ({namingPlan.validCount}/{namingPlan.totalCount})
                    </Heading>
                    <StatusLight variant={namingPlan.allValid ? 'positive' : 'negative'}>
                      {namingPlan.allValid ? 'All filenames valid' : 'Resolve naming issues'}
                    </StatusLight>
                  </Flex>

                  <View maxHeight="size-3000" overflow="auto">
                    <table className="gu-table">
                      <thead>
                        <tr>
                          <th>Source File</th>
                          <th>Destination Folder</th>
                          <th>Target Filename</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {namingPlan.items.map((item) => (
                          <tr key={item.id}>
                            <td>{item.relativePath}</td>
                            <td>
                              <span style={{ fontSize: '12px', opacity: 0.85 }}>{item.targetFolder}</span>
                            </td>
                            <td>
                              <input
                                type="text"
                                className={`gu-inline-input is-mono ${item.valid ? '' : 'is-invalid'}`}
                                value={
                                  manualNameOverrides[item.id] !== undefined
                                    ? manualNameOverrides[item.id]
                                    : item.governedName
                                }
                                onChange={(e) => {
                                  const val = e.target.value;
                                  setManualNameOverrides((prev) => ({
                                    ...prev,
                                    [item.id]: val
                                  }));
                                }}
                              />
                            </td>
                            <td>
                              {item.valid ? (
                                <span className="gu-badge-ok">Ready</span>
                              ) : (
                                <span className="gu-badge-req" title={item.issues.join('; ')}>
                                  {item.issues[0]}
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </View>
                </Flex>
              </div>
            </Flex>
          )}

          {/* Duplicate Asset Conflict Resolution Prompt */}
          {duplicateConflicts.length > 0 && !uploading && (
            <div className="gu-card-subtle">
              <Flex direction="column" gap="size-125">
                <Flex alignItems="center" gap="size-100">
                  <Alert size="S" />
                  <Heading level={4} margin={0}>
                    Duplicate Asset{duplicateConflicts.length === 1 ? '' : 's'} Found ({duplicateConflicts.length})
                  </Heading>
                </Flex>
                <Text UNSAFE_style={{ fontSize: '12.5px' }}>
                  {duplicateConflicts.length === 1 ? 'An asset named ' : 'Assets named '}
                  <b>{duplicateConflicts.map((d) => d.fileName).join(', ')}</b> already exist in this folder.
                </Text>
                <Flex gap="size-100" wrap marginTop="size-50">
                  <Button variant="cta" onPress={() => handleCommitUpload('keep-both')}>
                    Keep Both
                  </Button>
                  <Button variant="primary" onPress={() => handleCommitUpload('replace')}>
                    Replace
                  </Button>
                  <Button variant="secondary" onPress={() => handleCommitUpload('version')}>
                    Create Version
                  </Button>
                  <Button variant="secondary" onPress={() => handleCommitUpload('skip')}>
                    Skip
                  </Button>
                  <ActionButton isQuiet onPress={() => setDuplicateConflicts([])}>
                    Cancel
                  </ActionButton>
                </Flex>
              </Flex>
            </div>
          )}

          {/* Upload Progress Panel */}
          {uploading && (
            <div className="gu-card-subtle">
              <Flex direction="column" gap="size-125">
                <ProgressBar
                  label={uploadPhase || 'Uploading assets…'}
                  value={overallUploadPercent}
                  width="100%"
                />
                {uploadProgress.totalFiles > 0 && (
                  <Flex justifyContent="space-between" alignItems="center">
                    <Text UNSAFE_style={{ fontSize: '12px', opacity: 0.8 }}>
                      {uploadProgress.currentFile
                        ? `Uploading ${uploadProgress.currentFile}`
                        : 'Preparing upload…'}
                    </Text>
                    <Text UNSAFE_style={{ fontSize: '12px', fontWeight: 600 }}>
                      {Math.min(uploadProgress.completedFiles + 1, uploadProgress.totalFiles)} of {uploadProgress.totalFiles}
                    </Text>
                  </Flex>
                )}
              </Flex>
            </div>
          )}

          {uploadError && (
            <div className="gu-card-subtle" style={{ borderColor: '#d7373f' }}>
              <Flex alignItems="center" gap="size-100">
                <Alert size="S" UNSAFE_style={{ color: '#d7373f' }} />
                <Text UNSAFE_style={{ color: '#d7373f', fontWeight: 600 }}>
                  {uploadError}
                </Text>
              </Flex>
            </div>
          )}

          {/* Wizard Footer Actions */}
          <Flex justifyContent="space-between" alignItems="center" marginTop="size-100">
            <Button variant="secondary" onPress={closeDialog} isDisabled={uploading}>
              Cancel
            </Button>
            <ButtonGroup>
              {step > 1 && (
                <Button
                  variant="secondary"
                  onPress={() => setStep(step - 1)}
                  isDisabled={uploading}
                >
                  Back
                </Button>
              )}
              {step === 1 && (
                <Button
                  variant="cta"
                  isDisabled={queuedFiles.length === 0}
                  onPress={() => setStep(2)}
                >
                  Continue
                </Button>
              )}
              {step === 2 && (
                <Button
                  variant="cta"
                  isDisabled={!validation.valid}
                  onPress={() => setStep(3)}
                >
                  Continue
                </Button>
              )}
              {step === 3 && (
                <Button
                  variant="cta"
                  isDisabled={uploading || !validation.valid || !namingPlan.allValid || queuedFiles.length === 0}
                  onPress={() => handleCommitUpload('ask')}
                >
                  {uploading ? 'Uploading…' : 'Upload'}
                </Button>
              )}
            </ButtonGroup>
          </Flex>
        </Flex>
      </View>
    </Provider>
  );
}
