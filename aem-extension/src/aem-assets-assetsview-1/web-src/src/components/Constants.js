const extensionId = 'guided-upload';
const HANDOFF_MESSAGE_NS = '__GUIDED_UPLOAD__';
const STORAGE_KEY_CTX = 'guided_upload_ctx';

const TRUSTED_ORIGIN_PATTERNS = [
  /^https:\/\/experience\.adobe\.com$/i,
  /^https:\/\/experience-stage\.adobe\.com$/i,
  /^https:\/\/[a-z0-9-]+\.adobeaemcloud\.com$/i,
  /^https:\/\/[a-z0-9-]+\.adobeio-static\.net$/i,
  /^https?:\/\/localhost(?::\d+)?$/i,
  /^https?:\/\/127\.0\.0\.1(?::\d+)?$/i
];

function isTrustedMessageOrigin (origin = '') {
  const s = String(origin || '').trim();
  if (!s) return false;
  return TRUSTED_ORIGIN_PATTERNS.some((re) => re.test(s));
}

module.exports = {
  extensionId,
  HANDOFF_MESSAGE_NS,
  STORAGE_KEY_CTX,
  isTrustedMessageOrigin
};
