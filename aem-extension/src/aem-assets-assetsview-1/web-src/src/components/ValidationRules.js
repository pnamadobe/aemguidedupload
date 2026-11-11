/*
 * Pluggable Metadata & Governance Validation Engine.
 *
 * Enforces:
 *   1. All fields marked `required: true` from the folder's resolved AEM Metadata Schema / Form
 *      (including per-asset `dc:title` validation when multiple files are queued)
 *   2. Tag root scope enforcement (`field.rootTag`) when a tag_picker field specifies a tag root
 *   3. Built-in rights/date sanity checks (e.g., expiration dates cannot be in the past)
 *   4. Pluggable custom cross-field validation rules (`registerValidationRule`) for future enhancements
 */

const customRules = [];

/**
 * Registers an additional validation rule function `(values, schemaFields) => Array<{ property, label, message }>`.
 */
function registerValidationRule (ruleFn) {
  if (typeof ruleFn === 'function') {
    customRules.push(ruleFn);
  }
}

function isValueEmpty (val) {
  if (val === undefined || val === null) return true;
  if (typeof val === 'string') return val.trim().length === 0;
  if (Array.isArray(val)) return val.length === 0 || val.every((item) => isValueEmpty(item));
  return false;
}

const EXPIRATION_PROPERTIES = new Set([
  'pur:expirationDate',
  'prism:expirationDate',
  'drm:until',
  'dam:campaignEndDate',
  'offTime'
]);

function getLocalTodayIso (now = new Date()) {
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Validates current form values against the folder's resolved schema fields and any registered custom rules.
 *
 * @param {object} values - Map of `{ [property]: value }`
 * @param {Array} schemaFields - Array of field descriptors from `schema-resolver`
 * @param {object} [options] - `{ queuedFiles, perAssetTitles }` for per-asset field checks
 * @returns {{ valid: boolean, errors: Array<{ property: string, label: string, message: string }>, errorsByProperty: object }}
 */
function validateMetadataValues (values = {}, schemaFields = [], options = {}) {
  const errors = [];
  const errorsByProperty = {};
  const queuedFiles = Array.isArray(options.queuedFiles) ? options.queuedFiles : [];
  const perAssetTitles = options.perAssetTitles || {};

  const addError = (property, label, message) => {
    const err = { property, label, message };
    errors.push(err);
    if (!errorsByProperty[property]) {
      errorsByProperty[property] = message;
    }
  };

  const todayIso = getLocalTodayIso(options.now instanceof Date ? options.now : new Date());

  for (const field of schemaFields) {
    const val = values[field.property];

    // Special handling for per-asset `dc:title` when multiple files are queued
    if (field.property === 'dc:title' && queuedFiles.length > 1) {
      if (field.required) {
        const missingCount = queuedFiles.filter(
          (f) => isValueEmpty(perAssetTitles[f.id]) && isValueEmpty(val)
        ).length;
        if (missingCount > 0) {
          addError(
            field.property,
            field.label,
            `Title (dc:title) is required for each asset (${missingCount} of ${queuedFiles.length} missing)`
          );
        }
      }
      continue;
    }

    // 1. Check required fields from the folder's schema
    if (field.required && isValueEmpty(val)) {
      addError(
        field.property,
        field.label,
        `"${field.label}" is required by the folder's metadata schema`
      );
      continue;
    }

    // 2. Check tag_picker rootTag constraint if specified on the field
    if (!isValueEmpty(val) && field.type === 'tag_picker' && field.rootTag && field.rootTag.id) {
      const rootPrefix = String(field.rootTag.id);
      const selected = Array.isArray(val) ? val : [String(val)];
      const invalidTag = selected.find((tagId) => {
        const s = String(tagId || '').trim();
        return s && !s.startsWith(rootPrefix);
      });
      if (invalidTag) {
        addError(
          field.property,
          field.label,
          `Tag "${invalidTag}" must be under root "${field.rootTag.name || rootPrefix}" (${rootPrefix}*)`
        );
      }
    }

    // 3. Date sanity check: expiration dates must not be in the past
    if (!isValueEmpty(val) && EXPIRATION_PROPERTIES.has(field.property)) {
      const dateStr = String(val).slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr) && dateStr < todayIso) {
        addError(
          field.property,
          field.label,
          `"${field.label}" (${dateStr}) cannot be in the past`
        );
      }
    }
  }

  // 4. Run any pluggable custom rules
  for (const ruleFn of customRules) {
    try {
      const extra = ruleFn(values, schemaFields, options) || [];
      for (const item of extra) {
        if (item && item.property && item.message) {
          addError(item.property, item.label || item.property, item.message);
        }
      }
    } catch (e) {
      // ignore faulty custom rule
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    errorsByProperty
  };
}

module.exports = {
  isValueEmpty,
  getLocalTodayIso,
  registerValidationRule,
  validateMetadataValues
};
