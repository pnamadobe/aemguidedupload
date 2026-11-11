/*
 * Dynamic Folder Metadata Form & Schema Resolver for AEM as a Cloud Service.
 *
 * Walks up the DAM folder hierarchy from the target upload folder to /content/dam,
 * discovers the inherited Assets View Metadata Form (`dam:metadataForm` under
 * `/content/dam/appdata/metadataforms/...`) or Admin View Metadata Schema
 * (`metadataSchema` under `/conf/global/settings/dam/adminui-extension/metadataschema/...`),
 * parses all tabs/sections/fields/dropdown options, and resolves required vs. optional
 * governance fields plus naming tokens.
 */

const crypto = require('crypto')
const { encodeDamPath, fetchWithTimeout, mapWithConcurrency } = require('./utils')

const SCHEMA_CACHE_TTL_MS = 2 * 60 * 1000
const TAGS_CACHE_TTL_MS = 5 * 60 * 1000
const MAX_PROMOTED_PER_CUSTOM_TAB = 8
const schemaCache = new Map()
const taxonomyTagsCache = new Map()

function tokenCacheScope (token = '') {
  if (!token) return 'anon'
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 12)
}

function clearSchemaResolverCache () {
  schemaCache.clear()
  taxonomyTagsCache.clear()
}

const SYSTEM_TABS = new Set([
  'iptc',
  'iptc extension',
  'camera data',
  'commerce',
  'insights',
  'stock'
])

const STANDARD_TABS = new Set([
  'basic',
  'advanced',
  'tags',
  'rights',
  'drm',
  'workfront',
  ...SYSTEM_TABS
])

const SYSTEM_READONLY_PROPS = new Set([
  'dc:format',
  'repo:createDate',
  'repo:modifyDate',
  'dam:publishInfo',
  'xcm:machineKeywords',
  'dam:sha1',
  'dam:size',
  'jcr:created',
  'jcr:lastModified'
])

const SYSTEM_PROP_PREFIXES = [
  'tiff:',
  'psAux:',
  'exif:',
  'plus:',
  'Iptc4xmpCore:',
  'Iptc4xmpExt:',
  'photoshop:'
]

// Priority governance fields promoted when a schema has 0 explicit `required: true` flags in JCR
// Note: `dc:title` is intentionally excluded so it remains optional by default — when `dc:title`
// is left blank on upload, AEM's built-in AI-Generated Metadata service automatically generates
// and assigns an AI title during asset processing.
const CORE_GOVERNANCE_PROPS = new Set([
  'xdm:campaignName',
  'product:brand',
  'xcm:keywords',
  'dc:license',
  'drm:channelAllowed',
  'drm:region'
])

const EXPIRATION_PROPS = [
  'prism:expirationDate',
  'pur:expirationDate',
  'drm:until',
  'dam:campaignEndDate',
  'offTime'
]

function normalizePropName (rawProp = '') {
  return String(rawProp || '')
    .trim()
    .replace(/^\.?\/?jcr:content\/metadata\//, '')
    .replace(/^\.?\/?metadata\//, '')
    .replace(/^\.\//, '')
}

function isSystemProperty (prop) {
  if (!prop) return true
  if (SYSTEM_READONLY_PROPS.has(prop)) return true
  return SYSTEM_PROP_PREFIXES.some((prefix) => prop.startsWith(prefix))
}

function orderedEntries (container) {
  if (!container || typeof container !== 'object') return []
  if (Array.isArray(container)) return container
  const keys = Array.isArray(container.order)
    ? container.order
    : Object.keys(container).filter((k) => !k.startsWith('jcr:') && !k.startsWith('sling:') && k !== 'order')
  return keys.map((k) => container[k]).filter((v) => v && typeof v === 'object')
}

function normalizeElementType (rawElement = '', prop = '') {
  const el = String(rawElement || '').toLowerCase()
  if (prop === 'xcm:keywords' || prop === 'cq:tags' || el.includes('tag_picker') || el.includes('tagfield')) {
    return 'tag_picker'
  }
  if (el === 'dropdown' || el.includes('select') || el === 'review_status' || el === 'approval_target') {
    return 'dropdown'
  }
  if (el === 'datepicker' || el.includes('datepicker') || el === 'date') {
    return 'datepicker'
  }
  if (el === 'textarea' || el.includes('textarea')) {
    return 'textarea'
  }
  if (el === 'multi_val' || el === 'mvtext' || el === 'tags' || el.includes('multifield')) {
    return 'multi_val'
  }
  if (el === 'number' || el.includes('numberfield') || el === 'assetrating') {
    return 'number'
  }
  if (el === 'checkbox' || el.includes('checkbox')) {
    return 'checkbox'
  }
  return 'text'
}

function extractDropdownOptions (fieldNode, prop, element) {
  const out = []
  const rawOpts = fieldNode.dropdownOptions || fieldNode.options || fieldNode.items
  if (rawOpts) {
    for (const opt of orderedEntries(rawOpts)) {
      const id = opt.id !== undefined ? String(opt.id) : (opt.value !== undefined ? String(opt.value) : '')
      const name = opt.name !== undefined ? String(opt.name) : (opt.text !== undefined ? String(opt.text) : id)
      if (id || name) {
        out.push({ id: id || name, name: name || id })
      }
    }
  }
  if (!out.length && (element === 'review_status' || prop === 'dam:status' || prop === 'dam:assetStatus')) {
    return [
      { id: 'approved', name: 'Approved' },
      { id: 'pending', name: 'Pending Review' },
      { id: 'changes-requested', name: 'Changes Requested' },
      { id: 'rejected', name: 'Rejected' }
    ]
  }
  if (!out.length && (element === 'approval_target' || prop === 'dam:activationTarget')) {
    return [
      { id: 'delivery', name: 'Dynamic Media / Delivery' },
      { id: 'contenthub', name: 'Content Hub' }
    ]
  }
  return out
}

function extractRootTagInfo (fieldNode = {}) {
  const rt = fieldNode.rootTag || fieldNode['granite:data']?.rootTag || null
  const rawPath =
    (rt && typeof rt === 'object' ? rt.path : (typeof rt === 'string' ? rt : '')) ||
    fieldNode.rootPath ||
    fieldNode.tagsPath ||
    fieldNode.rootTagPath ||
    ''
  const cleanPath = String(rawPath || '').trim().replace(/\/+$/, '')
  if (!cleanPath || cleanPath === '/content/cq:tags' || cleanPath === '/etc/tags') {
    return null
  }
  // Convert /content/cq:tags/<ns>/<sub1>/<sub2> -> <ns>:<sub1>/<sub2>
  const rel = cleanPath
    .replace(/^\/content\/cq:tags\/?/, '')
    .replace(/^\/etc\/tags\/?/, '')
  const segs = rel.split('/').filter(Boolean)
  if (!segs.length) return null
  const derivedId = segs.length === 1 ? `${segs[0]}:` : `${segs[0]}:${segs.slice(1).join('/')}`
  const id = (rt && typeof rt === 'object' && rt.id) ? String(rt.id) : derivedId
  const name = (rt && typeof rt === 'object' && rt.name) ? String(rt.name) : segs.join(' / ')
  return {
    path: `/content/cq:tags/${segs.join('/')}`,
    id,
    name
  }
}

/**
 * Parses an Assets View Metadata Form object (either from `/adobe/repository/content/dam/appdata/metadataforms/<name>`
 * or from `.infinity.json` JCR dump).
 */
function parseAssetsViewForm (formObj) {
  const root = (formObj && formObj['jcr:content']) ? formObj['jcr:content'] : formObj
  const tabsContainer = root && root.tabs
  const rawTabs = orderedEntries(tabsContainer)
  const fields = []
  const seenProps = new Set()

  function walkFields (tabLabel, container, sectionHeader = '') {
    for (const item of orderedEntries(container)) {
      if (item.element || item.mapToProperty) {
        const rawProp = item.mapToProperty || item.name || ''
        const prop = normalizePropName(rawProp)
        if (!prop || item.readOnly === true || item.readOnly === 'true' || item.disabledMap === true) {
          continue
        }
        if (item.element === 'smart_tags' || item.element === 'publish' || isSystemProperty(prop)) {
          continue
        }
        if (seenProps.has(prop)) continue
        seenProps.add(prop)

        const type = normalizeElementType(item.element, prop)
        const options = type === 'dropdown' ? extractDropdownOptions(item, prop, item.element) : []
        const rootTag = type === 'tag_picker' ? extractRootTagInfo(item) : null
        // Skip bloated 90-locale language dropdown unless explicitly required
        if (prop === 'dc:language' && !item.required) continue

        const isExplicitlyRequired = item.required === true || item.required === 'true'
        fields.push({
          id: prop.replace(/[^a-zA-Z0-9_-]/g, '_'),
          property: prop,
          label: String(item.label || item.fieldLabel || prop).trim(),
          tab: String(tabLabel || 'Basic').trim(),
          section: String(sectionHeader || '').trim(),
          type,
          perAsset: prop === 'dc:title',
          required: isExplicitlyRequired,
          requiredSource: isExplicitlyRequired ? 'schema' : null,
          placeholder: String(item.placeholder || ''),
          options,
          ...(rootTag ? { rootTag } : {})
        })
      }
      if (item.fields) {
        walkFields(tabLabel, item.fields, item.header || sectionHeader)
      }
    }
  }

  for (const tab of rawTabs) {
    const tabLabel = String(tab.label || tab['jcr:title'] || 'Basic').trim()
    if (SYSTEM_TABS.has(tabLabel.toLowerCase())) continue
    walkFields(tabLabel, tab.fields)
  }

  return fields
}

/**
 * Parses an Admin View Metadata Schema object (`/conf/global/settings/dam/adminui-extension/metadataschema/<name>.infinity.json`).
 */
function parseAdminViewSchema (schemaObj) {
  const tabsObj = schemaObj?.items?.tabs?.items || {}
  const fields = []
  const seenProps = new Set()

  function walkNode (tabLabel, node, sectionHeader = '') {
    if (!node || typeof node !== 'object') return
    const metaType = node['granite:data']?.metaType || ''
    const resType = node.resourceType || node['sling:resourceType'] || ''

    if (metaType === 'section' && node.fieldLabel) {
      sectionHeader = String(node.fieldLabel).trim()
    } else if (node.fieldLabel && node.name) {
      const prop = normalizePropName(node.name)
      const readOnly = node.readOnly === true || node.readOnly === 'true' || node.disabled === true
      if (prop && !readOnly && !isSystemProperty(prop) && !resType.includes('autotag') && !seenProps.has(prop)) {
        if (prop !== 'dc:language' || node.required === true || node.required === 'true') {
          seenProps.add(prop)
          const type = normalizeElementType(metaType || resType, prop)
          const options = type === 'dropdown' ? extractDropdownOptions(node, prop, metaType) : []
          const rootTag = type === 'tag_picker' ? extractRootTagInfo(node) : null
          const isExplicitlyRequired =
            node.required === true ||
            node.required === 'true' ||
            node['granite:data']?.requiredCascading === 'always'

          fields.push({
            id: prop.replace(/[^a-zA-Z0-9_-]/g, '_'),
            property: prop,
            label: String(node.fieldLabel || prop).trim(),
            tab: String(tabLabel || 'Basic').trim(),
            section: String(sectionHeader || '').trim(),
            type,
            perAsset: prop === 'dc:title',
            required: isExplicitlyRequired,
            requiredSource: isExplicitlyRequired ? 'schema' : null,
            placeholder: String(node.emptyText || ''),
            options,
            ...(rootTag ? { rootTag } : {})
          })
        }
      }
    }

    for (const [k, v] of Object.entries(node)) {
      if (v && typeof v === 'object' && !k.startsWith('jcr:') && k !== 'granite:data' && k !== 'items') {
        walkNode(tabLabel, v, sectionHeader)
      }
    }
    if (node.items && typeof node.items === 'object' && normalizeElementType(metaType || resType) !== 'dropdown') {
      for (const [k, v] of Object.entries(node.items)) {
        if (v && typeof v === 'object' && !k.startsWith('jcr:')) {
          walkNode(tabLabel, v, sectionHeader)
        }
      }
    }
  }

  for (const [tk, tab] of Object.entries(tabsObj)) {
    if (!tab || typeof tab !== 'object' || tk.startsWith('jcr:')) continue
    const tabLabel = String(tab['jcr:title'] || tk).trim()
    if (SYSTEM_TABS.has(tabLabel.toLowerCase())) continue
    walkNode(tabLabel, tab.items)
  }

  return fields
}

/**
 * Applies Two-Tier Requirement Resolution:
 * - Tier 1: If the schema has at least one field explicitly marked `required: true`, honor those exact flags.
 * - Tier 2: If the schema has 0 explicitly required fields, promote:
 *   (a) All writable fields on custom domain/vertical tabs (e.g. Resorts, Airline, Banking, Dining, HBO, Pharma)
 *   (b) Core Identity & Rights fields present in the schema (`dc:title`, `xdm:campaignName`, `product:brand`, `xcm:keywords`, `dc:license`, `drm:channelAllowed`, `drm:region`)
 *   (c) The primary expiration date field present in the schema (`pur:expirationDate` or `prism:expirationDate` or `drm:until`)
 */
function resolveFieldRequirements (fields) {
  const hasExplicitRequired = fields.some((f) => f.required === true)
  if (hasExplicitRequired) {
    return {
      requirementMode: 'explicit-schema',
      fields
    }
  }

  let expirationPromoted = false
  const primaryExpProp = EXPIRATION_PROPS.find((p) => fields.some((f) => f.property === p))
  const promotedPerTab = {}

  const updated = fields.map((f) => {
    const tabLower = (f.tab || '').toLowerCase()
    const isCustomDomainTab = Boolean(tabLower) && !STANDARD_TABS.has(tabLower)
    const isCoreGovernance = CORE_GOVERNANCE_PROPS.has(f.property)
    const isPrimaryExpiration = !expirationPromoted && primaryExpProp && f.property === primaryExpProp
    if (isPrimaryExpiration) expirationPromoted = true

    if (isCoreGovernance || isPrimaryExpiration) {
      return {
        ...f,
        required: true,
        requiredSource: 'governance-policy'
      }
    }

    if (isCustomDomainTab) {
      const count = promotedPerTab[tabLower] || 0
      if (count < MAX_PROMOTED_PER_CUSTOM_TAB) {
        promotedPerTab[tabLower] = count + 1
        return {
          ...f,
          required: true,
          requiredSource: `vertical-tab:${f.tab}`
        }
      }
    }
    return f
  })

  // Guarantee at least dc:title is required if the schema was completely minimal
  if (!updated.some((f) => f.required)) {
    return {
      requirementMode: 'fallback-minimal',
      fields: updated.map((f, idx) => (idx === 0 || f.property === 'dc:title' ? { ...f, required: true, requiredSource: 'governance-policy' } : f))
    }
  }

  return {
    requirementMode: 'smart-governance-promotion',
    fields: updated
  }
}

/**
 * Derives clean naming token descriptors from the resolved schema fields, plus built-in tokens.
 */
function buildNamingTokensAndPattern (fields, schemaName = 'default') {
  const usedTokenKeys = new Set(['folder', 'subfolder', 'date', 'seq', 'origName'])
  const schemaTokens = []

  const shortTokenKey = (prop, label) => {
    const bare = prop.includes(':') ? prop.split(':').pop() : prop
    const cleaned = bare
      .replace(/^resorts/i, '')
      .replace(/^air/i, '')
      .replace(/^qsr/i, '')
      .replace(/^fin/i, '')
    const candidate = (cleaned || bare || label)
      .replace(/[^a-zA-Z0-9]/g, '')
    return candidate ? candidate.charAt(0).toLowerCase() + candidate.slice(1) : 'field'
  }

  // Put required fields first so the most relevant tokens appear first in the UI
  const sorted = [...fields].sort((a, b) => (b.required ? 1 : 0) - (a.required ? 1 : 0))
  for (const f of sorted) {
    if (f.type === 'textarea' || f.type === 'datepicker' || f.type === 'multi_val') continue
    let key = shortTokenKey(f.property, f.label)
    if (usedTokenKeys.has(key)) {
      key = `${key}_${f.property.split(':')[0]}`
    }
    usedTokenKeys.add(key)
    schemaTokens.push({
      key,
      property: f.property,
      label: f.label,
      tab: f.tab,
      required: f.required
    })
  }

  const builtInTokens = [
    { key: 'folder', property: '__folder', label: 'Current Folder Name', builtIn: true },
    { key: 'subfolder', property: '__subfolder', label: 'Dropped Subfolder Name', builtIn: true },
    { key: 'origName', property: '__origName', label: 'Original Filename Stem', builtIn: true },
    { key: 'date', property: '__date', label: 'Upload Date (YYYYMMDD)', builtIn: true },
    { key: 'seq', property: '__seq', label: 'Sequence (001, 002...)', builtIn: true }
  ]

  // Build a smart default pattern using up to 2 meaningful schema tokens + {folder} + {seq}
  const preferred = schemaTokens.filter((t) =>
    t.required &&
    t.property !== 'dc:title' &&
    t.property !== 'dc:license' &&
    t.property !== 'xcm:keywords'
  )
  const picked = preferred.slice(0, 2).map((t) => `{${t.key}}`)
  const defaultPattern = picked.length
    ? `{folder}_${picked.join('_')}_{seq}`
    : `{folder}_{origName}_{seq}`

  return {
    defaultPattern,
    schemaName,
    tokens: [...builtInTokens, ...schemaTokens]
  }
}

function getDefaultFallbackFields () {
  return [
    {
      id: 'dc_title',
      property: 'dc:title',
      label: 'Title',
      tab: 'Basic',
      section: 'Metadata',
      type: 'text',
      required: false,
      requiredSource: null,
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
      requiredSource: null,
      placeholder: 'Brief description of the asset',
      options: []
    },
    {
      id: 'xdm_campaignName',
      property: 'xdm:campaignName',
      label: 'Campaign / Project Name',
      tab: 'Workfront',
      section: '',
      type: 'text',
      required: true,
      requiredSource: 'governance-policy',
      placeholder: 'e.g. Summer-2026-Launch',
      options: []
    },
    {
      id: 'xcm_keywords',
      property: 'xcm:keywords',
      label: 'Taxonomy Tags',
      tab: 'Basic',
      section: 'Metadata',
      type: 'tag_picker',
      required: true,
      requiredSource: 'governance-policy',
      placeholder: 'Select one or more taxonomy tags',
      options: []
    },
    {
      id: 'dc_license',
      property: 'dc:license',
      label: 'License Agreement / Rights',
      tab: 'Rights',
      section: 'License',
      type: 'dropdown',
      required: true,
      requiredSource: 'governance-policy',
      placeholder: 'Select License Agreement',
      options: [
        { id: 'internal-use', name: 'DAM Internal User Terms of Use' },
        { id: 'external-partner-us', name: 'DAM External Partner License — US' },
        { id: 'external-partner-emea', name: 'DAM External Partner Licence — EMEA' }
      ]
    },
    {
      id: 'drm_channelAllowed',
      property: 'drm:channelAllowed',
      label: 'Channels Allowed',
      tab: 'Rights',
      section: 'License',
      type: 'dropdown',
      required: true,
      requiredSource: 'governance-policy',
      placeholder: 'Select Allowed Channel',
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
      tab: 'Rights',
      section: 'License',
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
      label: 'Rights Expiration Date',
      tab: 'Rights',
      section: 'License',
      type: 'datepicker',
      required: true,
      requiredSource: 'governance-policy',
      placeholder: 'YYYY-MM-DD',
      options: []
    }
  ]
}

async function fetchJsonSafe (url, token) {
  try {
    const res = await fetchWithTimeout(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json'
      }
    })
    if (!res.ok) return null
    const text = await res.text()
    return JSON.parse(text.replace(/^\)\]\}'?/, ''))
  } catch (e) {
    return null
  }
}

/**
 * Walks up the folder chain from `folderPath` to `/content/dam` to find the nearest
 * assigned Assets View Metadata Form (`dam:metadataForm` under `/content/dam/appdata/metadataforms/...`).
 * Prioritizes `dam:metadataForm` across the entire ancestor chain before considering legacy `metadataSchema`.
 */
async function discoverFolderSchemaAssignment (author, token, folderPath) {
  const clean = String(folderPath || '/content/dam').replace(/\/+$/, '') || '/content/dam'
  const segs = clean.split('/').filter(Boolean) // ['content', 'dam', ...]
  const chain = []
  for (let i = segs.length; i >= 2; i--) {
    chain.push('/' + segs.slice(0, i).join('/'))
  }

  let legacyFallback = null

  for (const currentPath of chain) {
    const enc = encodeDamPath(currentPath)
    // Primary: Repository API applicationmetadata (fast, clean JSON used by AEM Assets View)
    const appMeta = await fetchJsonSafe(`${author}/adobe/repository${enc};resource=applicationmetadata`, token)
    const jcrMeta = appMeta || (await fetchJsonSafe(`${author}${enc}/jcr:content.1.json`, token))
    if (!jcrMeta) continue

    const formPath = jcrMeta['dam:metadataForm'] || jcrMeta.metadataForm || ''
    if (formPath) {
      return {
        inheritedFrom: currentPath,
        isInherited: currentPath !== clean,
        metadataFormPath: formPath,
        metadataSchemaPath: null,
        folderTitle: jcrMeta['dc:title'] || jcrMeta['jcr:title'] || currentPath.split('/').pop()
      }
    }

    const schemaPath = jcrMeta.metadataSchema || jcrMeta.folderMetadataSchema || ''
    if (!legacyFallback && schemaPath && schemaPath !== 'System Default') {
      legacyFallback = {
        inheritedFrom: currentPath,
        isInherited: currentPath !== clean,
        metadataFormPath: null,
        metadataSchemaPath: schemaPath,
        folderTitle: jcrMeta['dc:title'] || jcrMeta['jcr:title'] || currentPath.split('/').pop()
      }
    }
  }

  if (legacyFallback) {
    return legacyFallback
  }

  return {
    inheritedFrom: '/content/dam',
    isInherited: true,
    metadataFormPath: null,
    metadataSchemaPath: null,
    folderTitle: clean.split('/').pop() || 'dam'
  }
}

/**
 * Resolves the full metadata schema for a target DAM folder.
 */
async function resolveFolderSchema (author, token, folderPath) {
  const cleanFolder = String(folderPath || '/content/dam').replace(/\/+$/, '') || '/content/dam'
  const cacheKey = `${author}|${tokenCacheScope(token)}|${cleanFolder}`
  const cached = schemaCache.get(cacheKey)
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value
  }

  const assignment = await discoverFolderSchemaAssignment(author, token, cleanFolder)

  // Determine candidate form/schema slug
  let slug = 'default'
  if (assignment.metadataFormPath) {
    slug = assignment.metadataFormPath.split('/').filter(Boolean).pop()
  } else if (assignment.metadataSchemaPath) {
    slug = assignment.metadataSchemaPath.split('/').filter(Boolean).pop()
  }

  const candidateFormPaths = []
  if (assignment.metadataFormPath) {
    candidateFormPaths.push(assignment.metadataFormPath)
  }
  if (slug && slug !== 'default') {
    candidateFormPaths.push(`/content/dam/appdata/metadataforms/${slug}`)
  } else {
    candidateFormPaths.push(
      '/content/dam/appdata/metadataforms/default',
      '/content/dam/appdata/metadataforms/the-default',
      '/content/dam/appdata/metadataforms/default2'
    )
  }

  let parsedFields = []
  let resolvedSourcePath = null
  let resolvedSourceType = null

  // 1. Try Assets View Metadata Form via Repository API or JCR .infinity.json
  for (const formPath of [...new Set(candidateFormPaths)]) {
    const enc = encodeDamPath(formPath)
    const repoForm = await fetchJsonSafe(`${author}/adobe/repository${enc}`, token)
    if (repoForm && repoForm.tabs) {
      parsedFields = parseAssetsViewForm(repoForm)
      if (parsedFields.length) {
        resolvedSourcePath = formPath
        resolvedSourceType = 'assets-view-metadata-form'
        break
      }
    }
    const jcrForm = await fetchJsonSafe(`${author}${enc}.infinity.json`, token)
    if (jcrForm && jcrForm['jcr:content']?.tabs) {
      parsedFields = parseAssetsViewForm(jcrForm)
      if (parsedFields.length) {
        resolvedSourcePath = formPath
        resolvedSourceType = 'assets-view-metadata-form-jcr'
        break
      }
    }
  }

  // 2. Fallback: Admin View Metadata Schema under /conf/global/settings/dam/adminui-extension/metadataschema
  if (!parsedFields.length) {
    const candidateSchemaPaths = []
    if (assignment.metadataSchemaPath) {
      candidateSchemaPaths.push(assignment.metadataSchemaPath)
    }
    candidateSchemaPaths.push(
      `/conf/global/settings/dam/adminui-extension/metadataschema/${slug}`,
      '/conf/global/settings/dam/adminui-extension/metadataschema/default'
    )
    for (const sPath of [...new Set(candidateSchemaPaths)]) {
      const enc = encodeDamPath(sPath)
      const sJson = await fetchJsonSafe(`${author}${enc}.infinity.json`, token)
      if (sJson && sJson.items?.tabs) {
        parsedFields = parseAdminViewSchema(sJson)
        if (parsedFields.length) {
          resolvedSourcePath = sPath
          resolvedSourceType = 'admin-view-metadata-schema'
          break
        }
      }
    }
  }

  // 3. Final safety net: Built-in enterprise governance schema
  let requirementMode = 'built-in-fallback'
  let finalFields = []
  if (parsedFields.length) {
    const resolved = resolveFieldRequirements(parsedFields)
    requirementMode = resolved.requirementMode
    finalFields = resolved.fields
  } else {
    resolvedSourcePath = 'built-in:enterprise-governance'
    resolvedSourceType = 'built-in-fallback'
    finalFields = getDefaultFallbackFields()
  }

  // 4. For any tag_picker field with a specific `rootTag`, fetch its scoped descendant tags
  await Promise.all(
    finalFields.map(async (f) => {
      if (f.type === 'tag_picker' && f.rootTag && f.rootTag.path) {
        f.scopedTags = await fetchTagsUnderRootPath(author, token, f.rootTag)
      }
    })
  )

  const requiredFields = finalFields.filter((f) => f.required)
  const optionalFields = finalFields.filter((f) => !f.required)
  const naming = buildNamingTokensAndPattern(finalFields, slug)

  const result = {
    folderPath,
    schemaName: slug,
    inheritedFrom: assignment.inheritedFrom,
    isInherited: assignment.isInherited,
    sourcePath: resolvedSourcePath,
    sourceType: resolvedSourceType,
    requirementMode,
    totalFields: finalFields.length,
    requiredFields,
    optionalFields,
    allFields: finalFields,
    naming
  }
  schemaCache.set(cacheKey, {
    value: result,
    expiresAt: Date.now() + SCHEMA_CACHE_TTL_MS
  })
  return result
}

/**
 * Recursively collects descendant `cq:Tag` nodes under a specific `rootTag` path
 * (e.g. `/content/cq:tags/sports/spurs/team-2025-26` or `/content/cq:tags/sport-category`).
 */
async function fetchTagsUnderRootPath (author, token, rootTag) {
  if (!rootTag || !rootTag.path) return []
  const cleanPath = String(rootTag.path).replace(/\/+$/, '')
  const data = await fetchJsonSafe(`${author}${encodeDamPath(cleanPath)}.3.json`, token)
  if (!data || typeof data !== 'object') return []

  const rel = cleanPath.replace(/^\/content\/cq:tags\/?/, '')
  const baseSegs = rel.split('/').filter(Boolean)
  if (!baseSegs.length) return []
  const nsKey = baseSegs[0]
  const rootTitle = data['jcr:title'] || rootTag.name || baseSegs.join(' / ')
  const tags = []

  function walkTagTree (node, pathSegs, titleSegs) {
    for (const [k, v] of Object.entries(node || {})) {
      if (!v || typeof v !== 'object' || k.startsWith('jcr:') || k.startsWith('sling:') || k.startsWith('rep:')) continue
      const primaryType = v['jcr:primaryType']
      if (primaryType && primaryType !== 'cq:Tag') continue
      const nextSegs = [...pathSegs, k]
      const childTitle = v['jcr:title'] || k
      const nextTitles = [...titleSegs, childTitle]
      const tagId = `${nsKey}:${nextSegs.slice(1).join('/')}`
      tags.push({
        id: tagId,
        label: nextTitles.join(' / '),
        namespace: nsKey,
        namespaceTitle: rootTitle,
        title: childTitle
      })
      walkTagTree(v, nextSegs, nextTitles)
    }
  }

  walkTagTree(data, baseSegs, [rootTitle])
  return tags.sort((a, b) => a.label.localeCompare(b.label))
}

/**
 * Fetches AEM taxonomy tags from `/content/cq:tags` so the Tag Picker field in the
 * Guided Upload modal can display and search real taxonomy tag IDs (`namespace:tag`).
 * Automatically falls back to per-namespace `.2.json` traversal when `/content/cq:tags.3.json`
 * hits Sling's 1,000-node limit (`HTTP 300 Multiple Choices`) on large enterprise taxonomies.
 */
async function fetchTaxonomyTags (author, token) {
  const cacheKey = `${author}|${tokenCacheScope(token)}`
  const cached = taxonomyTagsCache.get(cacheKey)
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value
  }

  let data = await fetchJsonSafe(`${author}/content/cq:tags.3.json`, token)

  // Enterprise scale fallback: if .3.json hit Sling's node limit, walk namespaces individually
  if (!data || typeof data !== 'object') {
    const rootList = await fetchJsonSafe(`${author}/content/cq:tags.1.json`, token)
    if (!rootList || typeof rootList !== 'object') {
      return []
    }
    const nsKeys = Object.keys(rootList).filter(
      (k) => rootList[k] && typeof rootList[k] === 'object' && !k.startsWith('jcr:') && !k.startsWith('rep:') && !k.startsWith('sling:')
    )
    const nsEntries = await mapWithConcurrency(nsKeys, 6, async (nsKey) => {
      const nsData = await fetchJsonSafe(`${author}/content/cq:tags/${encodeURIComponent(nsKey)}.2.json`, token)
      return [nsKey, nsData || rootList[nsKey]]
    })
    data = Object.fromEntries(nsEntries)
  }

  const tags = []
  function walkNamespace (node, nsKey, pathSegs, titleSegs) {
    for (const [childKey, childVal] of Object.entries(node || {})) {
      if (!childVal || typeof childVal !== 'object' || childKey.startsWith('jcr:') || childKey.startsWith('sling:') || childKey.startsWith('rep:')) continue
      const primaryType = childVal['jcr:primaryType']
      if (primaryType && primaryType !== 'cq:Tag') continue
      const childTitle = childVal['jcr:title'] || childKey
      const nextSegs = [...pathSegs, childKey]
      const nextTitles = [...titleSegs, childTitle]
      const tagId = `${nsKey}:${nextSegs.join('/')}`
      tags.push({
        id: tagId,
        label: nextTitles.join(' / '),
        namespace: nsKey,
        namespaceTitle: titleSegs[0],
        title: childTitle
      })
      walkNamespace(childVal, nsKey, nextSegs, nextTitles)
    }
  }

  for (const [nsKey, nsVal] of Object.entries(data)) {
    if (!nsVal || typeof nsVal !== 'object' || nsKey.startsWith('jcr:') || nsKey.startsWith('rep:')) continue
    const nsTitle = nsVal['jcr:title'] || nsKey
    walkNamespace(nsVal, nsKey, [], [nsTitle])
  }

  const sorted = tags.sort((a, b) => a.label.localeCompare(b.label))
  taxonomyTagsCache.set(cacheKey, {
    value: sorted,
    expiresAt: Date.now() + TAGS_CACHE_TTL_MS
  })
  return sorted
}

module.exports = {
  normalizePropName,
  normalizeElementType,
  extractRootTagInfo,
  parseAssetsViewForm,
  parseAdminViewSchema,
  resolveFieldRequirements,
  buildNamingTokensAndPattern,
  discoverFolderSchemaAssignment,
  resolveFolderSchema,
  fetchTagsUnderRootPath,
  fetchTaxonomyTags,
  clearSchemaResolverCache
}
