/*
 * Common authentication, validation, and AEM URL utilities for Guided Upload Runtime actions.
 */

const crypto = require('crypto')

function stringParameters (params = {}) {
  const secretKey = /secret|token|password|credential|private|_sc_json|api_?key|authorization/i
  const redact = (o) => Object.fromEntries(
    Object.entries(o || {}).map(([k, v]) => [k, secretKey.test(k) ? '<hidden>' : v])
  )
  return JSON.stringify({ ...redact(params), __ow_headers: redact(params.__ow_headers || {}) })
}

function getBearerToken (params = {}) {
  const auth = params.__ow_headers && (params.__ow_headers.authorization || params.__ow_headers.Authorization)
  if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, '').trim()
  }
  return undefined
}

function userBearer (params = {}) {
  const t = getBearerToken(params) || (typeof params.userToken === 'string' ? params.userToken.trim() : '')
  return t || undefined
}

const b64url = (x) => Buffer.from(x).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

async function aemTokenFromServiceCredential (scB64) {
  const raw = JSON.parse(Buffer.from(scB64, 'base64').toString('utf8'))
  const sc = raw.integration || raw
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    exp: now + 300,
    iss: sc.org,
    sub: sc.id,
    aud: `https://${sc.imsEndpoint}/c/${sc.technicalAccount.clientId}`
  }
  payload[`https://${sc.imsEndpoint}/s/${sc.metascopes}`] = true
  const si = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' + b64url(JSON.stringify(payload))
  const jwt = si + '.' + b64url(crypto.sign('RSA-SHA256', Buffer.from(si), sc.privateKey))
  const body = new URLSearchParams({
    client_id: sc.technicalAccount.clientId,
    client_secret: sc.technicalAccount.clientSecret,
    jwt_token: jwt
  })
  const r = await fetch(`https://${sc.imsEndpoint}/ims/exchange/jwt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  })
  if (!r.ok) {
    throw new Error(`AEM JWT exchange failed (${r.status}): ${(await r.text()).slice(0, 150)}`)
  }
  return (await r.json()).access_token
}

const AUTHOR_HOST_RE = /^https:\/\/author-[a-z0-9-]+\.adobeaemcloud\.com$/i

function normalizeAuthorUrl (raw) {
  const s = String(raw || '').trim().replace(/\/+$/, '')
  if (!s) return ''
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`
  if (!AUTHOR_HOST_RE.test(withScheme)) {
    throw new Error(`Invalid AEM Author URL: ${s}. Expected https://author-p<program>-e<env>.adobeaemcloud.com`)
  }
  return withScheme
}

async function resolveAemContext (params = {}) {
  const authorCandidate = params.aemAuthorUrl || params.AEM_AUTHOR_URL || ''
  const author = normalizeAuthorUrl(authorCandidate)
  if (!author) {
    throw new Error('Missing aemAuthorUrl (and no fallback AEM_AUTHOR_URL configured).')
  }

  const callerToken = userBearer(params)
  if (callerToken) {
    return { author, token: callerToken, authSource: 'user' }
  }
  if (params.AEM_SC_JSON) {
    const token = await aemTokenFromServiceCredential(params.AEM_SC_JSON)
    return { author, token, authSource: 'service-credential' }
  }
  if (params.AEM_DEV_TOKEN) {
    return { author, token: String(params.AEM_DEV_TOKEN).trim(), authSource: 'dev-token' }
  }
  const err = new Error('Missing authentication: sign in to AEM Assets View or configure AEM_SC_JSON.')
  err.status = 401
  throw err
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
  aemTokenFromServiceCredential,
  normalizeAuthorUrl,
  resolveAemContext,
  isDamFolder,
  sanitizeRelativeSubfolder,
  encodeDamPath,
  errorResponse
}
