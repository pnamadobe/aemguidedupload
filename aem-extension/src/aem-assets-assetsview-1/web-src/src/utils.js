/* global fetch */

/**
 * Invokes an Adobe I/O Runtime web action.
 */
export async function actionWebInvoke (actionUrl, headers = {}, params = {}, options = { method: 'POST' }) {
  const actionHeaders = {
    'Content-Type': 'application/json',
    ...headers
  };

  const fetchConfig = {
    headers: actionHeaders
  };

  if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
    actionHeaders['x-ow-extra-logging'] = 'on';
  }

  fetchConfig.method = (options.method || 'POST').toUpperCase();

  if (fetchConfig.method === 'GET') {
    const url = new URL(actionUrl);
    Object.keys(params).forEach((key) => url.searchParams.append(key, params[key]));
    actionUrl = url.toString();
  } else if (fetchConfig.method === 'POST') {
    fetchConfig.body = JSON.stringify(params);
  }

  const response = await fetch(actionUrl, fetchConfig);
  const text = await response.text();

  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    // non-json response
  }

  if (!response.ok) {
    const errMessage = (parsed && (parsed.error || (parsed.body && parsed.body.error))) || `Action HTTP ${response.status}`;
    const err = new Error(typeof errMessage === 'string' ? errMessage : JSON.stringify(errMessage));
    err.status = response.status;
    err.payload = parsed;
    throw err;
  }

  return parsed && parsed.body ? parsed.body : parsed;
}

/**
 * Uploads a File/Blob directly from the browser to AEM's pre-signed cloud storage `uploadURIs`.
 * Zero file bytes pass through Adobe I/O Runtime.
 */
export async function uploadBinaryToPresignedUris (file, uploadURIs = [], onProgress) {
  if (!Array.isArray(uploadURIs) || !uploadURIs.length) {
    throw new Error(`No pre-signed uploadURIs provided for ${file.name}`);
  }

  const totalBytes = file.size;
  const partCount = uploadURIs.length;
  const partSize = Math.ceil(totalBytes / partCount);
  let uploadedBytes = 0;

  for (let i = 0; i < partCount; i++) {
    const start = i * partSize;
    const end = Math.min((i + 1) * partSize, totalBytes);
    const chunk = file.slice(start, end);

    const res = await fetch(uploadURIs[i], {
      method: 'PUT',
      body: chunk
    });

    if (!(res.status === 201 || res.ok)) {
      throw new Error(`Binary part ${i + 1}/${partCount} PUT failed for "${file.name}" (HTTP ${res.status})`);
    }

    uploadedBytes = end;
    if (typeof onProgress === 'function') {
      onProgress({
        loaded: uploadedBytes,
        total: totalBytes,
        percent: totalBytes > 0 ? Math.round((uploadedBytes / totalBytes) * 100) : 100
      });
    }
  }
}

export default actionWebInvoke;
