/*
 * AEM Direct Binary Upload & Metadata Writeback Broker.
 *
 * Reuses AEM as a Cloud Service's native 3-step direct binary upload pipeline:
 *   1. Ensure destination folder hierarchy exists (`POST /api/assets/<relFolderPath>`)
 *   2. `POST <folder>.initiateUpload.json` -> returns pre-signed cloud `uploadURIs` + `uploadToken`
 *   3. Browser streams binary chunks directly to `uploadURIs` (zero file bytes pass through Runtime)
 *   4. `POST <folder>.completeUpload.json` -> commits the governed filename and triggers Asset Compute
 *   5. `PUT /api/assets/<relAssetPath>` -> writes validated schema metadata & usage rights to `jcr:content/metadata`
 */

const { isDamFolder, sanitizeRelativeSubfolder, encodeDamPath } = require('./utils')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const SAFE_FILENAME_RE = /^[^/\\\x00-\x1f]+$/ // eslint-disable-line no-control-regex

function validateFileName (name) {
  const s = String(name || '').trim()
  if (!s || s === '.' || s === '..' || !SAFE_FILENAME_RE.test(s) || s.length > 220) {
    throw new Error(`Invalid governed file name: "${s}"`)
  }
  return s
}

function aemAssetsApiUrl (author, damPath) {
  const rel = String(damPath || '').replace(/^\/content\/dam/, '').replace(/^\//, '')
  return `${author}/api/assets/${encodeDamPath(rel)}`
}

/**
 * Ensures `damPath` and all its ancestor folders under `/content/dam` exist.
 * Leaves existing folders untouched.
 */
async function ensureFolder (author, token, damPath, folderTitles = {}) {
  const clean = String(damPath || '').replace(/\/+$/, '')
  if (!isDamFolder(clean) || clean === '/content/dam') return

  const headers = { Authorization: `Bearer ${token}` }
  const checkRes = await fetch(`${aemAssetsApiUrl(author, clean)}.json`, { headers })
  if (checkRes.ok) return

  const cut = clean.lastIndexOf('/')
  const parent = clean.slice(0, cut)
  if (parent && parent !== '/content/dam' && /^\/content\/dam\/.+/.test(parent)) {
    await ensureFolder(author, token, parent, folderTitles)
  }

  const nodeName = clean.slice(cut + 1)
  const title = folderTitles[clean] || nodeName
  const createRes = await fetch(aemAssetsApiUrl(author, clean), {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      class: 'assetFolder',
      properties: { title }
    })
  })
  if (!createRes.ok && createRes.status !== 409) {
    throw new Error(`Failed to create folder ${clean} (HTTP ${createRes.status})`)
  }
}

/**
 * Ensures an entire tree of relative subfolders under `baseFolder` exists in topological order.
 */
async function ensureFolderHierarchy (author, token, baseFolder, relativeSubfolders = [], folderTitles = {}) {
  const cleanBase = String(baseFolder || '').replace(/\/+$/, '')
  if (!isDamFolder(cleanBase)) {
    throw new Error(`Invalid base DAM folder: ${baseFolder}`)
  }

  const uniquePaths = new Set([cleanBase])
  for (const rel of relativeSubfolders) {
    const cleanRel = sanitizeRelativeSubfolder(rel)
    if (cleanRel) {
      uniquePaths.add(`${cleanBase}/${cleanRel}`)
    }
  }

  const sorted = [...uniquePaths].sort((a, b) => a.split('/').length - b.split('/').length)
  for (const folderPath of sorted) {
    await ensureFolder(author, token, folderPath, folderTitles)
  }
  return sorted
}

/**
 * Initiates direct binary upload for a single file into `targetFolder`.
 */
async function initiateSingleFileUpload (author, token, targetFolder, fileName, fileSize, mimeType) {
  const encodedFolder = encodeDamPath(targetFolder)
  const doInitiate = () => fetch(`${author}${encodedFolder}.initiateUpload.json`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      fileName,
      fileSize: String(fileSize)
    })
  })

  let res = await doInitiate()
  if (res.status === 404) {
    await ensureFolder(author, token, targetFolder)
    for (const delay of [0, 600, 1200, 2500]) {
      if (delay) await sleep(delay)
      res = await doInitiate()
      if (res.status !== 404) break
    }
  }

  if (!res.ok) {
    throw new Error(`initiateUpload for "${fileName}" in ${targetFolder} failed (HTTP ${res.status})`)
  }

  const text = await res.text()
  const parsed = JSON.parse(text.replace(/^\)\]\}'?/, ''))
  const fileEntry = (parsed.files || [])[0]
  if (!fileEntry || !Array.isArray(fileEntry.uploadURIs) || !fileEntry.uploadURIs.length) {
    throw new Error(`initiateUpload for "${fileName}" returned no uploadURIs`)
  }

  return {
    fileName,
    targetFolder,
    damPath: `${targetFolder}/${fileName}`,
    fileSize: Number(fileSize),
    mimeType: mimeType || fileEntry.mimeType || 'application/octet-stream',
    uploadToken: fileEntry.uploadToken,
    uploadURIs: fileEntry.uploadURIs,
    minPartSize: fileEntry.minPartSize || 0,
    maxPartSize: fileEntry.maxPartSize || 0
  }
}

/**
 * Ensures all destination subfolders exist and initiates direct binary uploads for a batch of files.
 */
async function initiateBatchUpload (author, token, baseFolder, files = [], folderTitles = {}) {
  const cleanBase = String(baseFolder || '').replace(/\/+$/, '')
  if (!isDamFolder(cleanBase)) {
    throw new Error(`Invalid target DAM folder: ${baseFolder}`)
  }
  if (!Array.isArray(files) || !files.length) {
    throw new Error('files array must contain at least one file to initiate upload')
  }

  const subfolders = files.map((f) => f && f.subfolder).filter(Boolean)
  const createdFolders = await ensureFolderHierarchy(author, token, cleanBase, subfolders, folderTitles)

  const initiated = []
  for (const f of files) {
    const fileName = validateFileName(f.fileName)
    const size = Number(f.fileSize)
    if (!Number.isFinite(size) || size <= 0) {
      throw new Error(`Invalid fileSize for "${fileName}"`)
    }
    const relSub = sanitizeRelativeSubfolder(f.subfolder || '')
    const targetFolder = relSub ? `${cleanBase}/${relSub}` : cleanBase
    const info = await initiateSingleFileUpload(author, token, targetFolder, fileName, size, f.mimeType)
    initiated.push({
      clientId: f.clientId || fileName,
      subfolder: relSub,
      ...info
    })
  }

  return {
    baseFolder: cleanBase,
    ensuredFolders: createdFolders,
    files: initiated
  }
}

/**
 * Normalizes form metadata values into AEM JCR `jcr:content/metadata` properties:
 * - Maps `xcm:keywords` -> `cq:tags` (string array of tag IDs)
 * - Mirrors `dam:assetStatus` <-> `dam:status` so both Assets View and Admin View display status
 * - Normalizes datepicker values (`YYYY-MM-DD`) to ISO-8601 strings and mirrors expiration dates
 * - Splits comma-separated multi_val strings into arrays where appropriate
 */
function normalizeMetadataForAem (rawMetadata = {}) {
  const out = {}
  const multiValProps = new Set(['dc:subject', 'dam:search_promote', 'drm:otherEntities', 'product:sportequip'])
  const dateProps = new Set(['pur:expirationDate', 'prism:expirationDate', 'drm:until', 'dam:campaignEndDate', 'onTime', 'offTime', 'workfront:projectStart', 'workfront:projectEnd'])

  for (const [rawKey, rawVal] of Object.entries(rawMetadata || {})) {
    if (rawVal === undefined || rawVal === null || rawVal === '') continue
    if (Array.isArray(rawVal) && rawVal.length === 0) continue

    const key = String(rawKey).trim()
    if (!key) continue

    if (key === 'xcm:keywords' || key === 'cq:tags') {
      const tags = Array.isArray(rawVal)
        ? rawVal.map((v) => String(v).trim()).filter(Boolean)
        : String(rawVal).split(',').map((v) => v.trim()).filter(Boolean)
      if (tags.length) {
        out['cq:tags'] = [...new Set([...(out['cq:tags'] || []), ...tags])]
      }
      continue
    }

    // If a custom tag_picker field (e.g. product:sportCategory, xdm:playerName, gartner:tags)
    // holds an array of taxonomy tag IDs (`namespace:tag`), write the custom property AND
    // also merge valid taxonomy tag IDs into `cq:tags` so AEM's tag index picks them up.
    if (Array.isArray(rawVal) && rawVal.every((v) => typeof v === 'string' && /^[a-z0-9_-]+:/i.test(v))) {
      const cleanTags = rawVal.map((v) => v.trim()).filter(Boolean)
      out[key] = cleanTags
      out['cq:tags'] = [...new Set([...(out['cq:tags'] || []), ...cleanTags])]
      continue
    }

    if (multiValProps.has(key)) {
      const arr = Array.isArray(rawVal)
        ? rawVal.map((v) => String(v).trim()).filter(Boolean)
        : String(rawVal).split(',').map((v) => v.trim()).filter(Boolean)
      if (arr.length) out[key] = arr
      continue
    }

    if (dateProps.has(key) && typeof rawVal === 'string') {
      const trimmed = rawVal.trim()
      // Convert bare YYYY-MM-DD into full ISO timestamp for AEM date properties
      const iso = /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T23:59:59.000Z` : trimmed
      out[key] = iso
      if (key === 'pur:expirationDate' || key === 'drm:until') {
        if (!out['prism:expirationDate']) out['prism:expirationDate'] = iso
      } else if (key === 'prism:expirationDate') {
        if (!out['pur:expirationDate']) out['pur:expirationDate'] = iso
      }
      continue
    }

    if (key === 'dam:assetStatus' || key === 'dam:status') {
      const statusVal = String(rawVal).trim()
      out['dam:status'] = statusVal
      out['dam:assetStatus'] = statusVal
      continue
    }

    out[key] = rawVal
  }

  // Stamp governance provenance marker
  out['dam:guidedUploadCommitted'] = 'true'
  return out
}

/**
 * Writes normalized metadata properties to an asset's `jcr:content/metadata` via the AEM Assets HTTP API.
 * Retries transient 404/409 responses while AEM finalizes the JCR asset node after `completeUpload.json`.
 */
async function writeAssetMetadata (author, token, damPath, rawMetadata = {}) {
  const properties = normalizeMetadataForAem(rawMetadata)
  if (!Object.keys(properties).length) return properties

  const url = aemAssetsApiUrl(author, damPath)
  const retryDelays = [0, 400, 900, 1800]
  let lastStatus = 0

  for (const delay of retryDelays) {
    if (delay) await sleep(delay)
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        class: 'asset',
        properties
      })
    })
    if (res.ok) {
      return properties
    }
    lastStatus = res.status
    if (res.status !== 404 && res.status !== 409) {
      break
    }
  }

  throw new Error(`Metadata write failed for ${damPath} (HTTP ${lastStatus})`)
}

function buildKeepBothCandidates (fileName) {
  const dot = fileName.lastIndexOf('.')
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName
  const ext = dot > 0 ? fileName.slice(dot) : ''
  return [
    fileName,
    `${stem}-1${ext}`,
    `${stem}_1${ext}`,
    `${stem} (1)${ext}`,
    `${stem}-2${ext}`
  ]
}

async function findRecentlyCommittedAssetPath (author, token, targetFolder, fileName, committedSinceMs) {
  const candidates = buildKeepBothCandidates(fileName)
  const threshold = Number(committedSinceMs) - 10000

  for (let i = 0; i < candidates.length; i++) {
    const candidateName = candidates[i]
    const candidateDamPath = `${targetFolder}/${candidateName}`
    try {
      const res = await fetch(`${aemAssetsApiUrl(author, candidateDamPath)}.json`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json'
        }
      })
      if (!res.ok) continue
      const data = await res.json()
      const props = (data && data.properties) || {}
      const meta = props.metadata || {}

      // If this is a "Keep both" duplicate-renamed variant that doesn't have our marker yet, match it
      if (i > 0 && meta['dam:guidedUploadCommitted'] !== 'true') {
        return { fileName: candidateName, damPath: candidateDamPath }
      }

      const timestamps = [
        props['jcr:lastModified'],
        props['jcr:created'],
        meta['jcr:lastModified'],
        meta['dc:modified']
      ]
        .filter(Boolean)
        .map((t) => Date.parse(String(t)))
        .filter((n) => Number.isFinite(n))

      if (timestamps.some((ts) => ts >= threshold)) {
        return { fileName: candidateName, damPath: candidateDamPath }
      }
    } catch (e) {
      // ignore check error and try next candidate
    }
  }
  return null
}

/**
 * Applies governed metadata to assets uploaded via AEM's native OOTB Upload Manager.
 * Supports both direct invocation (after `.completeUpload.json` finishes) and timestamp-gated
 * polling (`onlyIfCommittedSince`) that respects AEM's OOTB Duplicate Resolution dialog.
 */
async function applyBatchMetadata (author, token, files = [], sharedMetadata = {}, options = {}) {
  if (!Array.isArray(files) || !files.length) {
    throw new Error('files array is required to apply metadata')
  }

  const onlyIfCommittedSince = Number(options.onlyIfCommittedSince) || 0
  const results = []
  const pending = []

  for (const f of files) {
    const fileName = validateFileName(f.fileName)
    const targetFolder = String(f.targetFolder || '').replace(/\/+$/, '')
    if (!isDamFolder(targetFolder)) {
      throw new Error(`Invalid targetFolder for "${fileName}": ${targetFolder}`)
    }

    let resolvedFileName = fileName
    let damPath = `${targetFolder}/${fileName}`

    if (onlyIfCommittedSince > 0) {
      const hit = await findRecentlyCommittedAssetPath(author, token, targetFolder, fileName, onlyIfCommittedSince)
      if (!hit) {
        pending.push({
          clientId: f.clientId || fileName,
          fileName,
          targetFolder
        })
        continue
      }
      resolvedFileName = hit.fileName
      damPath = hit.damPath
    }

    const mergedMeta = {
      ...(sharedMetadata || {}),
      ...(f.metadata || {})
    }
    const writtenProps = await writeAssetMetadata(author, token, damPath, mergedMeta)

    results.push({
      clientId: f.clientId || fileName,
      fileName: resolvedFileName,
      originalGovernedName: fileName,
      targetFolder,
      damPath,
      appliedMetadata: writtenProps
    })
  }

  return {
    completedCount: results.length,
    assets: results,
    pendingCount: pending.length,
    pending
  }
}

/**
 * Completes direct binary upload and applies governed metadata for each uploaded file.
 */
async function completeBatchUpload (author, token, files = [], sharedMetadata = {}) {
  if (!Array.isArray(files) || !files.length) {
    throw new Error('files array is required to complete upload')
  }

  const results = []
  for (const f of files) {
    const fileName = validateFileName(f.fileName)
    const targetFolder = String(f.targetFolder || '').replace(/\/+$/, '')
    if (!isDamFolder(targetFolder)) {
      throw new Error(`Invalid targetFolder for "${fileName}": ${targetFolder}`)
    }
    if (!f.uploadToken) {
      throw new Error(`Missing uploadToken for "${fileName}"`)
    }

    const encodedFolder = encodeDamPath(targetFolder)
    const completeRes = await fetch(`${author}${encodedFolder}.completeUpload.json`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        fileName,
        mimeType: f.mimeType || 'application/octet-stream',
        uploadToken: f.uploadToken,
        fileSize: String(f.fileSize || 0)
      })
    })

    if (!completeRes.ok) {
      throw new Error(`completeUpload failed for "${fileName}" in ${targetFolder} (HTTP ${completeRes.status})`)
    }

    const damPath = `${targetFolder}/${fileName}`
    const mergedMeta = {
      ...(sharedMetadata || {}),
      ...(f.metadata || {})
    }
    // If dc:title wasn't individually overridden for multi-file uploads, default per-file title or append stem
    const writtenProps = await writeAssetMetadata(author, token, damPath, mergedMeta)

    results.push({
      clientId: f.clientId || fileName,
      fileName,
      targetFolder,
      damPath,
      appliedMetadata: writtenProps
    })
  }

  return {
    completedCount: results.length,
    assets: results
  }
}

module.exports = {
  validateFileName,
  ensureFolder,
  ensureFolderHierarchy,
  initiateSingleFileUpload,
  initiateBatchUpload,
  normalizeMetadataForAem,
  writeAssetMetadata,
  applyBatchMetadata,
  completeBatchUpload
}
