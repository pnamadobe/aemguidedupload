/*
 * Common authentication, validation, and AEM URL utilities for Guided Upload Runtime actions.
 */

function stringParameters (params = {}) {
  const secretKey = /secret|token|password|credential|private|_sc_json|api_?key|authorization/i
  const redact = (o) => Object.fromEntries(
    Object.entries(o || {}).map(([k, v]) => [k, secretKey.test(k) ? '<hidden>' : v])
  )
  return JSON.stringify({ ...redact(params), __ow_headers: redact(params.__ow_headers || {}) })
}

function getBearerToken (params = {}) {
  const auth = params.__ow_headers && (params.__ow_headers.authorization || params.__ow_headers.Authorization)
  if (typeof auth !== 'string') return undefined
  const match = auth.trim().match(/^Bearer\s+([^\s\x00-\x1f]+)$/i) // eslint-disable-line no-control-regex
  return match ? match[1] : undefined
}

function userBearer (params = {}) {
  return getBearerToken(params)
}

const AUTHOR_HOST_RE = /^https:\/\/author-[a-z0-9-]+\.adobeaemcloud\.com$/i

function normalizeAuthorUrl (raw) {
  const s = String(raw || '').trim().replace(/\/+$/, '')
  if (!s) return ''
  const withScheme = (/^https?:\/\//i.test(s) ? s : `https://${s}`).toLowerCase()
  if (!AUTHOR_HOST_RE.test(withScheme)) {
    const err = new Error(`Invalid AEM Author URL: ${s}. Expected https://author-p<program>-e<env>.adobeaemcloud.com`)
    err.status = 400
    throw err
  }
  return withScheme
}

function parseAllowedAuthors (params = {}) {
  const rawList = [params.AEM_AUTHOR_URL, params.AEM_ALLOWED_AUTHORS]
    .filter((v) => typeof v === 'string' && v.trim())
    .join(',')
  if (!rawList) return []
  const seen = new Set()
  for (const part of rawList.split(',')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const normalized = normalizeAuthorUrl(trimmed)
    if (normalized) seen.add(normalized)
  }
  return [...seen]
}

async function resolveAemContext (params = {}) {
  const callerToken = userBearer(params)
  if (!callerToken) {
    const err = new Error('Missing authentication: sign in to AEM Assets View and provide an Authorization Bearer token.')
    err.status = 401
    throw err
  }

  const allowedAuthors = parseAllowedAuthors(params)
  if (!allowedAuthors.length) {
    const err = new Error('Server configuration error: AEM_AUTHOR_URL must be configured on the Runtime action.')
    err.status = 500
    throw err
  }

  let author = allowedAuthors[0]
  if (typeof params.aemAuthorUrl === 'string' && params.aemAuthorUrl.trim()) {
    const requestedAuthor = normalizeAuthorUrl(params.aemAuthorUrl)
    if (!allowedAuthors.includes(requestedAuthor)) {
      const err = new Error(`Forbidden AEM Author URL: ${requestedAuthor} is not in the server's configured AEM_AUTHOR_URL allowlist.`)
      err.status = 403
      throw err
    }
    author = requestedAuthor
  }

  return { author, token: callerToken, authSource: 'user' }
}

function isDamFolder (folder) {
  const s = String(folder || '').replace(/\/+$/, '')
  if (s === '/content/dam') return true
  if (!/^\/content\/dam\/[^\\\x00-\x1f]+$/.test(s)) return false // eslint-disable-line no-control-regex
  const segs = s.split('/').slice(3)
  return segs.length > 0 && segs.every((seg) => seg && seg !== '.' && seg !== '..')
}

function sanitizeRelativeSubfolder (subfolder) {
  if (!subfolder) return ''
  const cleaned = String(subfolder)
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
  if (!cleaned) return ''
  const segs = cleaned.split('/').filter(Boolean)
  for (const seg of segs) {
    if (seg === '.' || seg === '..' || /[\x00-\x1f]/.test(seg)) { // eslint-disable-line no-control-regex
      throw new Error(`Invalid subfolder segment: ${seg}`)
    }
  }
  return segs.join('/')
}

function encodeDamPath (damPath) {
  return String(damPath || '')
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')
}

function fetchWithTimeout (url, options = {}, timeoutMs = 15000) {
  const signal =
    options.signal ||
    (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(timeoutMs)
      : undefined)
  return fetch(url, signal ? { ...options, signal } : options)
}

async function mapWithConcurrency (items = [], concurrency = 4, fn) {
  const list = Array.isArray(items) ? items : []
  if (!list.length) return []
  const limit = Math.max(1, Number(concurrency) || 4)
  const results = new Array(list.length)
  let nextIdx = 0

  async function worker () {
    while (nextIdx < list.length) {
      const idx = nextIdx++
      results[idx] = await fn(list[idx], idx)
    }
  }

  const workers = Array.from({ length: Math.min(limit, list.length) }, () => worker())
  await Promise.all(workers)
  return results
}

function errorResponse (statusCode, message, logger) {
  if (logger && typeof logger.info === 'function') {
    logger.info(`${statusCode}: ${message}`)
  }
  return {
    statusCode,
    body: {
      ok: false,
      error: message
    }
  }
}

module.exports = {
  stringParameters,
  getBearerToken,
  userBearer,
  normalizeAuthorUrl,
  parseAllowedAuthors,
  resolveAemContext,
  isDamFolder,
  sanitizeRelativeSubfolder,
  encodeDamPath,
  fetchWithTimeout,
  mapWithConcurrency,
  errorResponse
}
