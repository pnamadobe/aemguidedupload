/*
 * guided-upload-api — Unified Adobe I/O Runtime Web Action for Guided Upload.
 *
 * Operations (`params.op`):
 *   - `resolveSchema`: Walks up the target DAM folder hierarchy, resolves the inherited
 *     Assets View Metadata Form / Admin View Metadata Schema, extracts required & optional
 *     fields + dropdown options + naming tokens, and returns available taxonomy tags.
 *   - `listTags`: Returns AEM taxonomy tags (`/content/cq:tags`).
 *   - `initiate`: Ensures destination subfolders exist and initiates AEM Direct Binary Upload,
 *     returning pre-signed `uploadURIs` + `uploadToken` per file.
 *   - `complete`: Finalizes Direct Binary Upload (`completeUpload.json`) with governed filenames
 *     and writes validated metadata properties to `jcr:content/metadata`.
 */

const { Core } = require('@adobe/aio-sdk')
const {
  stringParameters,
  resolveAemContext,
  isDamFolder,
  errorResponse
} = require('../utils')
const {
  resolveFolderSchema,
  fetchTaxonomyTags
} = require('../schema-resolver')
const {
  initiateBatchUpload,
  completeBatchUpload,
  applyBatchMetadata
} = require('../upload-broker')

async function main (params = {}) {
  const logger = Core.Logger('guided-upload-api', { level: params.LOG_LEVEL || 'info' })
  try {
    logger.debug(stringParameters(params))

    const op = String(params.op || 'resolveSchema').trim()
    const { author, token, authSource } = await resolveAemContext(params)

    switch (op) {
      case 'resolveSchema': {
        const folderPath = String(params.folderPath || params.folder || '/content/dam').replace(/\/+$/, '') || '/content/dam'
        if (!isDamFolder(folderPath)) {
          return errorResponse(400, `Invalid DAM folder path: ${folderPath}`, logger)
        }
        const includeTags = params.includeTags !== false && params.includeTags !== 'false'
        const [schema, tags] = await Promise.all([
          resolveFolderSchema(author, token, folderPath),
          includeTags ? fetchTaxonomyTags(author, token) : Promise.resolve([])
        ])
        return {
          statusCode: 200,
          body: {
            ok: true,
            author,
            authSource,
            schema,
            tags
          }
        }
      }

      case 'listTags': {
        const tags = await fetchTaxonomyTags(author, token)
        return {
          statusCode: 200,
          body: {
            ok: true,
            tags
          }
        }
      }

      case 'initiate': {
        const baseFolder = String(params.baseFolder || params.folderPath || params.folder || '').replace(/\/+$/, '')
        if (!isDamFolder(baseFolder)) {
          return errorResponse(400, `Invalid baseFolder: ${baseFolder}`, logger)
        }
        const initiated = await initiateBatchUpload(
          author,
          token,
          baseFolder,
          params.files || [],
          params.folderTitles || {},
          { duplicateResolution: params.duplicateResolution }
        )
        return {
          statusCode: 200,
          body: {
            ok: true,
            ...initiated
          }
        }
      }

      case 'complete': {
        const completed = await completeBatchUpload(
          author,
          token,
          params.files || [],
          params.sharedMetadata || {},
          { baseFolder: params.baseFolder || params.folderPath || params.folder || '' }
        )
        return {
          statusCode: 200,
          body: {
            ok: true,
            ...completed
          }
        }
      }

      case 'applyMetadata': {
        const applied = await applyBatchMetadata(
          author,
          token,
          params.files || [],
          params.sharedMetadata || {},
          { onlyIfCommittedSince: params.onlyIfCommittedSince }
        )
        return {
          statusCode: 200,
          body: {
            ok: true,
            ...applied
          }
        }
      }

      default:
        return errorResponse(400, `Unsupported operation: ${op}`, logger)
    }
  } catch (err) {
    const status = err.status || 500
    logger.error(err)
    return errorResponse(status, err.message || 'Internal server error', logger)
  }
}

exports.main = main
