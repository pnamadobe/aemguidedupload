/*
 * Pluggable Metadata & Governance Validation Engine.
 *
 * Enforces:
 *   1. All fields marked `required: true` from the folder's resolved AEM Metadata Schema / Form
 *   2. Built-in rights/date sanity checks (e.g., expiration dates cannot be in the past)
 *   3. Pluggable custom cross-field validation rules (`registerValidationRule`) for future enhancements
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

/**
 * Validates current form values against the folder's resolved schema fields and any registered custom rules.
 *
 * @param {object} values - Map of `{ [property]: value }`
 * @param {Array} schemaFields - Array of field descriptors from `schema-resolver`
 * @returns {{ valid: boolean, errors: Array<{ property: string, label: string, message: string }>, errorsByProperty: object }}
 */
function validateMetadataValues (values = {}, schemaFields = []) {
  const errors = [];
  const errorsByProperty = {};

  const addError = (property, label, message) => {
    const err = { property, label, message };
    errors.push(err);
    if (!errorsByProperty[property]) {
      errorsByProperty[property] = message;
    }
  };

  const todayIso = new Date().toISOString().slice(0, 10);

  for (const field of schemaFields) {
    const val = values[field.property];

    // 1. Check required fields from the folder's schema
    if (field.required && isValueEmpty(val)) {
      addError(
        field.property,
        field.label,
        `"${field.label}" is required by the folder's metadata schema`
      );
      continue;
    }

    // 2. Date sanity check: expiration dates must not be in the past
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

  // 3. Run any pluggable custom rules
  for (const ruleFn of customRules) {
    try {
      const extra = ruleFn(values, schemaFields) || [];
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
  registerValidationRule,
  validateMetadataValues
};
