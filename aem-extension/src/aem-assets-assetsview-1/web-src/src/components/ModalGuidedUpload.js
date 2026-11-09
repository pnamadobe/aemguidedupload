import React, { useState, useEffect, useMemo } from 'react';
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
  TextField,
  Picker,
  Item,
  ActionButton,
  Divider
} from '@adobe/react-spectrum';

import { extensionId, HANDOFF_MESSAGE_NS, STORAGE_KEY_CTX } from './Constants';
import FolderDropzone, { shouldIgnoreFile } from './FolderDropzone';
import DynamicSchemaForm from './DynamicSchemaForm';
import { validateMetadataValues } from './ValidationRules';
import { computeBatchNamingPlan } from './NamingEngine';
import actionWebInvoke, { uploadBinaryToPresignedUris } from '../utils';
import actionsConfig from '../config.json';

function readInitialContext () {
  const hash = window.location.hash || '';
  const qIdx = hash.indexOf('?');
  const sp = new URLSearchParams(qIdx >= 0 ? hash.slice(qIdx + 1) : window.location.search);
  const urlFolder = sp.get('folder') || '';
  const urlAuthor = sp.get('aemAuthorUrl') || '';

  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY_CTX) || '{}');
    return {
      folderPath: urlFolder || stored.folderPath || '/content/dam',
      aemAuthorUrl: urlAuthor || stored.aemAuthorUrl || ''
    };
  } catch (e) {
    return {
      folderPath: urlFolder || '/content/dam',
      aemAuthorUrl: urlAuthor || ''
    };
  }
}

function resolveActionUrl (actionName = 'guided-upload-api') {
  const hit = Object.entries(actionsConfig || {}).find(
    ([k]) => k.endsWith(`/${actionName}`) || k === actionName
  );
  return hit ? hit[1] : null;
}

async function getHostUserToken (gc) {
  if (!gc) return '';
  try {
    const info = await gc.host.auth.getIMSInfo();
    if (info && info.accessToken) return info.accessToken;
  } catch (e) {
    // ignore
  }
  try {
    const shared = gc.sharedContext && gc.sharedContext.get('auth');
    if (shared && shared.imsToken) return shared.imsToken;
  } catch (e) {
    // ignore
  }
  return '';
}

function createClientFallbackSchema (folderPath = '/content/dam') {
  const requiredFields = [
    {
      id: 'dc_title',
      property: 'dc:title',
      label: 'Title',
      tab: 'Basic',
      section: 'Metadata',
      type: 'text',
      required: true,
      requiredSource: 'governance-policy',
      placeholder: 'Asset title',
      options: []
    },
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
  const [colorScheme, setColorScheme] = useState('light');

  const [folderPath, setFolderPath] = useState(initialCtx.folderPath || '/content/dam');
  const [folderInput, setFolderInput] = useState(initialCtx.folderPath || '/content/dam');
  const [aemAuthorUrl, setAemAuthorUrl] = useState(initialCtx.aemAuthorUrl || '');

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

  // Naming state
  const [namingPattern, setNamingPattern] = useState('{folder}_{origName}_{seq}');
  const [caseStyle, setCaseStyle] = useState('kebab');
  const [manualNameOverrides, setManualNameOverrides] = useState({});

  // Upload commit state
  const [uploading, setUploading] = useState(false);
  const [uploadPhase, setUploadPhase] = useState('');
  const [uploadProgress, setUploadProgress] = useState({ currentFile: '', completedFiles: 0, totalFiles: 0, currentFilePercent: 0 });
  const [uploadError, setUploadError] = useState('');
  const [completedResult, setCompletedResult] = useState(null);

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
      }
    })();
    return () => { mounted = false; };
  }, []);

  // Cross-Frame Chrome Extension Drop Handoff Listener
  useEffect(() => {
    const onMessage = (event) => {
      const data = event && event.data;
      if (!data || data[HANDOFF_MESSAGE_NS] !== 'DROPPED_FILES') return;

      if (data.folderPath && data.folderPath.startsWith('/content/dam')) {
        setFolderPath(data.folderPath);
        setFolderInput(data.folderPath);
      }
      if (data.aemAuthorUrl) {
        setAemAuthorUrl(data.aemAuthorUrl);
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
            mimeType: f.type || 'application/octet-stream',
            relativePath: rel,
            subfolder
          });
        }
        if (mapped.length > 0) {
          setQueuedFiles((prev) => {
            const existingKeys = new Set(prev.map((p) => `${p.relativePath}|${p.size}`));
            const fresh = mapped.filter((m) => !existingKeys.has(`${m.relativePath}|${m.size}`));
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

  // Resolve Folder Metadata Schema whenever `folderPath` or `guestConnection` settles
  useEffect(() => {
    let cancelled = false;
    const loadSchema = async () => {
      const actionUrl = resolveActionUrl('guided-upload-api');
      if (!actionUrl) {
        const fallback = createClientFallbackSchema(folderPath);
        setSchema(fallback);
        setNamingPattern(fallback.naming.defaultPattern);
        return;
      }

      setSchemaLoading(true);
      setSchemaError('');
      try {
        const token = await getHostUserToken(guestConnection);
        const headers = token ? { Authorization: `Bearer ${token}` } : {};
        const res = await actionWebInvoke(actionUrl, headers, {
          op: 'resolveSchema',
          folderPath,
          aemAuthorUrl,
          ...(token ? { userToken: token } : {})
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
  }, [folderPath, aemAuthorUrl, guestConnection]);

  const handleAddFiles = (items = []) => {
    const mapped = items.map((it) => ({
      id: `file-${nextFileSeqId++}`,
      file: it.file,
      name: it.name,
      size: it.size,
      mimeType: it.mimeType || (it.file && it.file.type) || 'application/octet-stream',
      relativePath: it.relativePath || it.name,
      subfolder: it.subfolder || ''
    }));
    setQueuedFiles((prev) => {
      const existingKeys = new Set(prev.map((p) => `${p.relativePath}|${p.size}`));
      const fresh = mapped.filter((m) => !existingKeys.has(`${m.relativePath}|${m.size}`));
      // Auto-populate dc:title from first file if empty
      if (prev.length === 0 && fresh.length > 0) {
        const firstStem = fresh[0].name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
        setMetadataValues((mv) => (mv['dc:title'] ? mv : { ...mv, 'dc:title': firstStem }));
      }
      return [...prev, ...fresh];
    });
  };

  const handleRemoveFile = (id) => {
    setQueuedFiles((prev) => prev.filter((f) => f.id !== id));
  };

  const handleClearFiles = () => {
    setQueuedFiles([]);
    setManualNameOverrides({});
    setHandoffSource(null);
  };

  const handleChangeMetadata = (property, value) => {
    setMetadataValues((prev) => ({
      ...prev,
      [property]: value
    }));
  };

  const validation = useMemo(
    () => validateMetadataValues(metadataValues, schema ? schema.allFields : []),
    [metadataValues, schema]
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
    if (guestConnection && guestConnection.host?.modal?.closeDialog) {
      guestConnection.host.modal.closeDialog();
    }
  };

  const handleCommitUpload = async () => {
    setUploadError('');
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
      setUploadError('Please resolve filename validation issues before committing.');
      return;
    }

    const actionUrl = resolveActionUrl('guided-upload-api');
    if (!actionUrl) {
      setUploadError('Runtime action URL (guided-upload-api) is not configured in config.json. Run `aio app run` or `aio app deploy`.');
      return;
    }

    setUploading(true);
    setUploadPhase('Ensuring folder hierarchy & initiating direct binary upload in AEM…');
    setUploadProgress({
      currentFile: '',
      completedFiles: 0,
      totalFiles: namingPlan.items.length,
      currentFilePercent: 0
    });

    try {
      const token = await getHostUserToken(guestConnection);
      const headers = token ? { Authorization: `Bearer ${token}` } : {};

      // Step 1: Initiate batch upload (creates subfolders + returns pre-signed uploadURIs)
      const initPayload = {
        op: 'initiate',
        baseFolder: folderPath,
        aemAuthorUrl,
        ...(token ? { userToken: token } : {}),
        files: namingPlan.items.map((item) => ({
          clientId: item.id,
          fileName: item.governedName,
          fileSize: item.size,
          mimeType: item.mimeType,
          subfolder: item.cleanSubfolder
        }))
      };

      const initRes = await actionWebInvoke(actionUrl, headers, initPayload);
      const initiatedFiles = (initRes && initRes.files) || [];
      if (!initiatedFiles.length) {
        throw new Error('AEM initiateUpload returned no file descriptors.');
      }

      // Step 2: Direct browser-to-Blob PUT for each file
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

        await uploadBinaryToPresignedUris(localItem.file, desc.uploadURIs, ({ percent }) => {
          setUploadProgress({
            currentFile: desc.fileName,
            completedFiles: i,
            totalFiles: initiatedFiles.length,
            currentFilePercent: percent
          });
        });
      }

      // Step 3: Complete upload & write governed schema metadata to jcr:content/metadata
      setUploadPhase('Committing assets & writing folder schema metadata…');
      const completePayload = {
        op: 'complete',
        aemAuthorUrl,
        ...(token ? { userToken: token } : {}),
        sharedMetadata: metadataValues,
        files: initiatedFiles.map((desc) => ({
          clientId: desc.clientId,
          fileName: desc.fileName,
          targetFolder: desc.targetFolder,
          mimeType: desc.mimeType,
          fileSize: desc.fileSize,
          uploadToken: desc.uploadToken
        }))
      };

      const completeRes = await actionWebInvoke(actionUrl, headers, completePayload);
      setCompletedResult(completeRes);

      if (guestConnection && guestConnection.host?.toast?.display) {
        try {
          await guestConnection.host.toast.display({
            variant: 'positive',
            message: `Guided Upload committed ${completeRes.completedCount || initiatedFiles.length} governed asset(s) to ${folderPath}`
          });
        } catch (e) { /* ignore toast error */ }
      }
    } catch (err) {
      setUploadError(err.message || String(err));
    } finally {
      setUploading(false);
      setUploadPhase('');
    }
  };

  return (
    <Provider theme={defaultTheme} colorScheme={colorScheme}>
      <View padding="size-250">
        <Flex direction="column" gap="size-200">
          {/* Top Context & Folder Bar */}
          <View backgroundColor="gray-75" padding="size-150" borderRadius="regular">
            <Flex justifyContent="space-between" alignItems="end" wrap gap="size-150">
              <Flex gap="size-100" alignItems="end" wrap flex="1">
                <TextField
                  label="Target AEM DAM Folder"
                  value={folderInput}
                  onChange={setFolderInput}
                  width="size-4600"
                />
                {folderInput.trim() !== folderPath && (
                  <ActionButton
                    onPress={() => {
                      const cleaned = folderInput.trim().replace(/\/+$/, '') || '/content/dam';
                      setFolderPath(cleaned);
                    }}
                  >
                    Switch Folder & Reload Schema
                  </ActionButton>
                )}
              </Flex>
              <Flex alignItems="center" gap="size-100">
                {schemaLoading && <ProgressCircle size="S" isIndeterminate aria-label="Loading schema" />}
                <Text UNSAFE_style={{ fontSize: '12px' }}>
                  Schema: <b>{schema ? schema.schemaName : 'loading…'}</b>
                </Text>
              </Flex>
            </Flex>
            {schemaError && (
              <Text UNSAFE_style={{ color: '#b35c00', fontSize: '12px', marginTop: '6px', display: 'block' }}>
                ⚠ {schemaError}
              </Text>
            )}
          </View>

          {/* Step Navigation Bar */}
          {!completedResult && (
            <Flex gap="size-100" wrap>
              <Button
                variant={step === 1 ? 'cta' : 'secondary'}
                onPress={() => setStep(1)}
              >
                1. Files & Folder Structure ({queuedFiles.length})
              </Button>
              <Button
                variant={step === 2 ? 'cta' : 'secondary'}
                isDisabled={queuedFiles.length === 0}
                onPress={() => setStep(2)}
              >
                2. Required Metadata & Rights {validation.valid ? '✓' : `(${validation.errors.length} req)`}
              </Button>
              <Button
                variant={step === 3 ? 'cta' : 'secondary'}
                isDisabled={queuedFiles.length === 0 || !validation.valid}
                onPress={() => setStep(3)}
              >
                3. Naming & Commit Upload
              </Button>
            </Flex>
          )}

          <Divider size="S" />

          {/* Completion Screen */}
          {completedResult ? (
            <View backgroundColor="gray-100" padding="size-250" borderRadius="regular">
              <Flex direction="column" gap="size-150">
                <Heading level={3} margin={0}>
                  ✓ Guided Upload Complete ({completedResult.completedCount} asset{completedResult.completedCount === 1 ? '' : 's'} committed)
                </Heading>
                <Text>
                  All files were renamed according to your naming rules, placed into their target DAM folder hierarchy, and tagged with the required <b>{schema.schemaName}</b> metadata.
                </Text>
                <View maxHeight="size-3000" overflow="auto" backgroundColor="gray-50" padding="size-150" borderRadius="regular">
                  <table className="gu-table">
                    <thead>
                      <tr>
                        <th>Governed Filename</th>
                        <th>DAM Destination Path</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(completedResult.assets || []).map((asset) => (
                        <tr key={asset.damPath}>
                          <td><b>{asset.fileName}</b></td>
                          <td><code>{asset.damPath}</code></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </View>
                <Flex justifyContent="end" gap="size-125" marginTop="size-100">
                  <Button
                    variant="secondary"
                    onPress={() => {
                      setCompletedResult(null);
                      handleClearFiles();
                      setStep(1);
                    }}
                  >
                    Upload More Assets
                  </Button>
                  <Button variant="cta" onPress={closeDialog}>
                    Done
                  </Button>
                </Flex>
              </Flex>
            </View>
          ) : (
            <React.Fragment>
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
                  validation={validation}
                />
              )}

              {/* STEP 3: Auto-Naming Engine & Commit */}
              {step === 3 && (
                <Flex direction="column" gap="size-200">
                  <View borderWidth="thin" borderColor="dark" borderRadius="regular" padding="size-200">
                    <Flex direction="column" gap="size-150">
                      <Heading level={4} margin={0}>
                        Auto-Naming Convention Builder
                      </Heading>
                      <Text UNSAFE_style={{ fontSize: '12.5px', opacity: 0.85 }}>
                        Click any token below to insert it into the naming pattern. Tokens pull live values from the <b>{schema.schemaName}</b> metadata entered in Step 2.
                      </Text>

                      <Flex gap="size-150" wrap alignItems="end">
                        <TextField
                          label="Filename Pattern (extension added automatically)"
                          value={namingPattern}
                          onChange={setNamingPattern}
                          width="size-4600"
                        />
                        <Picker
                          label="Token Case Style"
                          selectedKey={caseStyle}
                          onSelectionChange={(k) => k && setCaseStyle(String(k))}
                          width="size-2400"
                        >
                          <Item key="kebab">kebab-case (recommended)</Item>
                          <Item key="snake">snake_case</Item>
                          <Item key="camel">camelCase</Item>
                          <Item key="preserve">Preserve Case</Item>
                        </Picker>
                        {Object.keys(manualNameOverrides).length > 0 && (
                          <ActionButton onPress={() => setManualNameOverrides({})}>
                            Reset Manual Edits
                          </ActionButton>
                        )}
                      </Flex>

                      {/* Clickable Schema & Built-in Token Pills */}
                      <Flex wrap gap="size-75" alignItems="center">
                        <Text UNSAFE_style={{ fontSize: '12px', fontWeight: 700 }}>
                          Insert Token:
                        </Text>
                        {((schema && schema.naming && schema.naming.tokens) || []).map((tok) => (
                          <button
                            key={tok.key}
                            type="button"
                            className="gu-token-btn"
                            title={`${tok.label} (${tok.property})`}
                            onClick={() => insertTokenIntoPattern(tok.key)}
                          >
                            {`{${tok.key}}`}
                            <span style={{ opacity: 0.65, fontSize: '10.5px' }}>
                              {tok.label}
                            </span>
                          </button>
                        ))}
                      </Flex>
                    </Flex>
                  </View>

                  {/* Before -> After Filename & Folder Preview Table */}
                  <View borderWidth="thin" borderColor="dark" borderRadius="regular" padding="size-200">
                    <Flex direction="column" gap="size-125">
                      <Flex justifyContent="space-between" alignItems="center">
                        <Heading level={4} margin={0}>
                          Governed Filename & Folder Placement Preview ({namingPlan.validCount}/{namingPlan.totalCount} compliant)
                        </Heading>
                        <span className={namingPlan.allValid ? 'gu-badge-ok' : 'gu-badge-req'}>
                          {namingPlan.allValid ? '✓ All Filenames Valid' : '⚠ Resolve Naming Issues'}
                        </span>
                      </Flex>

                      <View maxHeight="size-3000" overflow="auto">
                        <table className="gu-table">
                          <thead>
                            <tr>
                              <th>Original File</th>
                              <th>Target DAM Folder</th>
                              <th>Governed Filename (Editable)</th>
                              <th>Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {namingPlan.items.map((item) => (
                              <tr key={item.id}>
                                <td>
                                  <code>{item.relativePath}</code>
                                </td>
                                <td>
                                  <code>{item.targetFolder}</code>
                                </td>
                                <td>
                                  <input
                                    type="text"
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
                                    style={{
                                      width: '100%',
                                      padding: '5px 8px',
                                      borderRadius: '4px',
                                      border: item.valid ? '1px solid #8e8e8e' : '1px solid #c9252d',
                                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                                      fontSize: '12px'
                                    }}
                                  />
                                </td>
                                <td>
                                  {item.valid ? (
                                    <span className="gu-badge-ok">Valid</span>
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
                  </View>
                </Flex>
              )}

              {/* Upload Progress Banner */}
              {uploading && (
                <View backgroundColor="gray-100" padding="size-150" borderRadius="regular">
                  <Flex alignItems="center" gap="size-150">
                    <ProgressCircle size="S" isIndeterminate aria-label="Uploading" />
                    <Flex direction="column" gap="size-50" flex="1">
                      <Text><b>{uploadPhase}</b></Text>
                      {uploadProgress.totalFiles > 0 && (
                        <Text UNSAFE_style={{ fontSize: '12px' }}>
                          File {uploadProgress.completedFiles + 1} of {uploadProgress.totalFiles}
                          {uploadProgress.currentFile ? ` (${uploadProgress.currentFile}: ${uploadProgress.currentFilePercent}%)` : ''}
                        </Text>
                      )}
                    </Flex>
                  </Flex>
                </View>
              )}

              {uploadError && (
                <View backgroundColor="negative" padding="size-125" borderRadius="regular">
                  <Text UNSAFE_style={{ color: '#fff' }}>
                    <b>✖ {uploadError}</b>
                  </Text>
                </View>
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
                      Next: Required Metadata ({queuedFiles.length} file{queuedFiles.length === 1 ? '' : 's'})
                    </Button>
                  )}
                  {step === 2 && (
                    <Button
                      variant="cta"
                      isDisabled={!validation.valid}
                      onPress={() => setStep(3)}
                    >
                      Next: Review Naming & Commit
                    </Button>
                  )}
                  {step === 3 && (
                    <Button
                      variant="cta"
                      isDisabled={uploading || !validation.valid || !namingPlan.allValid || queuedFiles.length === 0}
                      onPress={handleCommitUpload}
                    >
                      {uploading
                        ? 'Uploading & Applying Metadata…'
                        : `Commit Guided Upload (${namingPlan.totalCount} Asset${namingPlan.totalCount === 1 ? '' : 's'})`}
                    </Button>
                  )}
                </ButtonGroup>
              </Flex>
            </React.Fragment>
          )}
        </Flex>
      </View>
    </Provider>
  );
}
