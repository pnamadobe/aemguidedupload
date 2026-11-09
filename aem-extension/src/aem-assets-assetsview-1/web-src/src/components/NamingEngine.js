/*
 * Token-Based Auto-Naming & Folder Hygiene Engine.
 *
 * Constructs compliant DAM filenames from folder metadata tokens (e.g.,
 * `{folder}_{campaignName}_{resortsActivity}_{seq}.{ext}`), normalizes subfolder
 * paths when requested, and validates filenames against the naming regex and
 * collision rules.
 */

const DEFAULT_FILENAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,180}\.[a-z0-9]{1,10}$/;

function splitFileNameAndExt (rawName = '') {
  const clean = String(rawName || '').trim();
  const dot = clean.lastIndexOf('.');
  if (dot <= 0 || dot === clean.length - 1) {
    return { stem: clean || 'asset', ext: '' };
  }
  return {
    stem: clean.slice(0, dot),
    ext: clean.slice(dot + 1).toLowerCase()
  };
}

function formatSegment (rawVal = '', caseStyle = 'kebab') {
  const s = String(rawVal || '')
    .trim()
    // Strip path prefixes if a license/tag path was selected
    .split('/')
    .pop()
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .replace(/['"`]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim();

  if (!s) return '';
  const words = s.split(/\s+/).filter(Boolean);

  if (caseStyle === 'snake') {
    return words.map((w) => w.toLowerCase()).join('_');
  }
  if (caseStyle === 'camel') {
    return words
      .map((w, i) => (i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
      .join('');
  }
  if (caseStyle === 'preserve') {
    return words.join('-');
  }
  // default: kebab-case
  return words.map((w) => w.toLowerCase()).join('-');
}

function sanitizeSubfolderPath (relSubfolder = '', normalizeFolders = true) {
  const raw = String(relSubfolder || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  if (!raw) return '';

  const segs = raw
    .split('/')
    .map((seg) => seg.trim())
    .filter((seg) => seg && seg !== '.' && seg !== '..');

  if (!normalizeFolders) {
    return segs.join('/');
  }
  return segs
    .map((seg) => formatSegment(seg, 'kebab') || 'folder')
    .join('/');
}

/**
 * Resolves a map of `{ [tokenKey]: formattedValue }` for a specific file and metadata value set.
 */
function buildTokenMap ({
  baseFolder = '/content/dam',
  subfolder = '',
  originalFileName = '',
  sequenceNumber = 1,
  metadataValues = {},
  schemaTokens = [],
  caseStyle = 'kebab',
  now = new Date()
}) {
  const { stem } = splitFileNameAndExt(originalFileName);
  const folderName = String(baseFolder || '/content/dam').replace(/\/+$/, '').split('/').pop() || 'dam';
  const leafSubfolder = subfolder ? String(subfolder).split('/').filter(Boolean).pop() : folderName;
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const seqStr = String(sequenceNumber).padStart(3, '0');

  const map = {
    folder: formatSegment(folderName, caseStyle) || 'dam',
    subfolder: formatSegment(leafSubfolder, caseStyle) || formatSegment(folderName, caseStyle) || 'dam',
    origName: formatSegment(stem, caseStyle) || 'asset',
    date: dateStr,
    seq: seqStr
  };

  for (const token of schemaTokens || []) {
    if (token.builtIn) continue;
    const rawVal = metadataValues[token.property];
    let strVal = '';
    if (Array.isArray(rawVal) && rawVal.length > 0) {
      const first = String(rawVal[0]);
      strVal = first.includes(':') ? first.split(':').pop() : first;
    } else if (rawVal !== undefined && rawVal !== null) {
      strVal = String(rawVal);
      if (strVal.includes(':') && !strVal.startsWith('http')) {
        strVal = strVal.split(':').pop();
      }
    }
    map[token.key] = formatSegment(strVal, caseStyle);
  }

  return map;
}

/**
 * Generates a governed filename from a pattern and token map.
 */
function generateGovernedFileName ({
  pattern = '{folder}_{origName}_{seq}',
  baseFolder = '/content/dam',
  subfolder = '',
  originalFileName = 'asset.jpg',
  sequenceNumber = 1,
  metadataValues = {},
  schemaTokens = [],
  caseStyle = 'kebab',
  now = new Date()
}) {
  const { ext } = splitFileNameAndExt(originalFileName);
  const tokenMap = buildTokenMap({
    baseFolder,
    subfolder,
    originalFileName,
    sequenceNumber,
    metadataValues,
    schemaTokens,
    caseStyle,
    now
  });

  const sep = caseStyle === 'snake' ? '_' : '-';

  // Strip any trailing .{ext} user may have typed in pattern
  const cleanPattern = String(pattern || '{folder}_{origName}_{seq}')
    .trim()
    .replace(/\.\{ext\}$/i, '');

  const interpolated = cleanPattern.replace(/\{([a-zA-Z0-9_:-]+)\}/g, (_, key) => {
    if (key === 'ext') return ext;
    return tokenMap[key] !== undefined ? tokenMap[key] : '';
  });

  // Collapse repeated separators and trim leading/trailing separators
  const normalizedStem = interpolated
    .replace(/[^a-zA-Z0-9._-]+/g, sep)
    .replace(/[_-]{2,}/g, sep)
    .replace(/^[._-]+|[._-]+$/g, '') || `${tokenMap.folder}${sep}${tokenMap.seq}`;

  return ext ? `${normalizedStem}.${ext}` : normalizedStem;
}

/**
 * Computes governed filenames and destination paths for an entire queued batch of files,
 * validating regex compliance and detecting any collisions.
 */
function computeBatchNamingPlan ({
  files = [],
  pattern = '{folder}_{origName}_{seq}',
  baseFolder = '/content/dam',
  metadataValues = {},
  schemaTokens = [],
  caseStyle = 'kebab',
  normalizeSubfolders = true,
  manualOverrides = {},
  regexPattern = DEFAULT_FILENAME_REGEX
}) {
  const cleanBase = String(baseFolder || '/content/dam').replace(/\/+$/, '') || '/content/dam';
  const perFolderSeq = {};
  const seenDamPaths = new Map();

  const plan = files.map((item, idx) => {
    const cleanSub = sanitizeSubfolderPath(item.subfolder || '', normalizeSubfolders);
    const targetFolder = cleanSub ? `${cleanBase}/${cleanSub}` : cleanBase;
    perFolderSeq[targetFolder] = (perFolderSeq[targetFolder] || 0) + 1;
    const seqNum = perFolderSeq[targetFolder];

    const autoName = generateGovernedFileName({
      pattern,
      baseFolder: cleanBase,
      subfolder: cleanSub,
      originalFileName: item.name,
      sequenceNumber: seqNum,
      metadataValues,
      schemaTokens,
      caseStyle
    });

    const finalName = (manualOverrides[item.id] && manualOverrides[item.id].trim())
      ? manualOverrides[item.id].trim()
      : autoName;

    const damPath = `${targetFolder}/${finalName}`;
    seenDamPaths.set(damPath, (seenDamPaths.get(damPath) || 0) + 1);

    return {
      ...item,
      index: idx,
      cleanSubfolder: cleanSub,
      targetFolder,
      autoName,
      governedName: finalName,
      damPath
    };
  });

  let validCount = 0;
  const enriched = plan.map((entry) => {
    const issues = [];
    if (!regexPattern.test(entry.governedName)) {
      issues.push('Filename must use alphanumeric characters, hyphens, or underscores and include a valid extension');
    }
    if (seenDamPaths.get(entry.damPath) > 1) {
      issues.push('Duplicate destination path in batch — include {seq} or {origName} in pattern');
    }
    const valid = issues.length === 0;
    if (valid) validCount++;
    return {
      ...entry,
      valid,
      issues
    };
  });

  return {
    allValid: enriched.length > 0 && validCount === enriched.length,
    validCount,
    totalCount: enriched.length,
    items: enriched
  };
}

module.exports = {
  DEFAULT_FILENAME_REGEX,
  splitFileNameAndExt,
  formatSegment,
  sanitizeSubfolderPath,
  buildTokenMap,
  generateGovernedFileName,
  computeBatchNamingPlan
};
