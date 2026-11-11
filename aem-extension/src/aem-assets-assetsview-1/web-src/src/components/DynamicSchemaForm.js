import React, { useState } from 'react';
import {
  Flex,
  View,
  Text,
  Heading,
  TextField,
  TextArea,
  Picker,
  Item,
  Checkbox,
  ActionButton,
  Divider
} from '@adobe/react-spectrum';

export function humanTitleFromFileName (fileName = '') {
  return String(fileName || '')
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
}

function PerAssetTitleField ({
  field,
  queuedFiles = [],
  perAssetTitles = {},
  onChangePerAssetTitle,
  onBatchSetPerAssetTitles,
  singleValue = '',
  onChangeSingleValue,
  errorMessage
}) {
  const [prefixInput, setPrefixInput] = useState('');

  // If 0 or 1 file is queued, render a standard single TextField (synced with the single file)
  if (queuedFiles.length <= 1) {
    const onlyFile = queuedFiles[0];
    const effectiveVal = onlyFile
      ? (perAssetTitles[onlyFile.id] !== undefined ? perAssetTitles[onlyFile.id] : singleValue)
      : singleValue;

    return (
      <TextField
        label={`${field.label} (${field.property})`}
        isRequired={field.required}
        placeholder="Leave blank to let AEM AI automatically generate the title"
        description="When left blank, AEM's built-in AI metadata service automatically generates a descriptive title on upload."
        value={effectiveVal || ''}
        onChange={(v) => {
          onChangeSingleValue(v);
          if (onlyFile && typeof onChangePerAssetTitle === 'function') {
            onChangePerAssetTitle(onlyFile.id, v);
          }
        }}
        validationState={errorMessage ? 'invalid' : undefined}
        errorMessage={errorMessage}
        width="100%"
      />
    );
  }

  const autoFillFromNames = () => {
    const next = {};
    for (const f of queuedFiles) {
      const baseTitle = humanTitleFromFileName(f.name) || f.name;
      next[f.id] = prefixInput.trim() ? `${prefixInput.trim()} — ${baseTitle}` : baseTitle;
    }
    if (typeof onBatchSetPerAssetTitles === 'function') {
      onBatchSetPerAssetTitles(next);
    }
  };

  const clearAllToUseAi = () => {
    if (typeof onBatchSetPerAssetTitles === 'function') {
      onBatchSetPerAssetTitles({});
    }
    onChangeSingleValue('');
  };

  return (
    <View backgroundColor="gray-75" padding="size-150" borderRadius="regular">
      <Flex direction="column" gap="size-125">
        <Flex justifyContent="space-between" alignItems="center" wrap gap="size-100">
          <Flex direction="column" gap="size-25">
            <Flex alignItems="center" gap="size-75">
              <Text>
                <b>{field.label} — Per-Asset Titles ({queuedFiles.length} assets)</b>{' '}
                {field.required && <span style={{ color: '#c9252d' }}>*</span>}
              </Text>
              <span style={{ fontSize: '11px', opacity: 0.65 }}>({field.property})</span>
            </Flex>
            <Text UNSAFE_style={{ fontSize: '11.5px', opacity: 0.8 }}>
              Leave blank to let AEM AI automatically generate a descriptive title for each asset on upload.
            </Text>
          </Flex>
          <Flex gap="size-75" alignItems="end" wrap>
            <TextField
              label="Optional Prefix"
              placeholder="e.g. Winter 2026"
              value={prefixInput}
              onChange={setPrefixInput}
              width="size-2000"
            />
            <ActionButton onPress={autoFillFromNames}>
              {prefixInput.trim() ? 'Apply Prefix + Filename' : 'Fill from Filenames'}
            </ActionButton>
            <ActionButton onPress={clearAllToUseAi}>
              Use AEM AI Title (Clear)
            </ActionButton>
          </Flex>
        </Flex>

        <View maxHeight="size-2400" overflow="auto" backgroundColor="gray-50" padding="size-100" borderRadius="regular">
          <table className="gu-table">
            <thead>
              <tr>
                <th style={{ width: '42%' }}>Queued File</th>
                <th>Asset Title (<code>dc:title</code>) {field.required ? '*' : '(Optional — blank uses AEM AI)'}</th>
              </tr>
            </thead>
            <tbody>
              {queuedFiles.map((f) => {
                const currentTitle = perAssetTitles[f.id] || '';
                const isMissing = field.required && !currentTitle.trim();
                return (
                  <tr key={f.id}>
                    <td>
                      <code>{f.relativePath || f.name}</code>
                    </td>
                    <td>
                      <input
                        type="text"
                        value={currentTitle}
                        placeholder="Leave blank for AEM AI-generated title..."
                        onChange={(e) => onChangePerAssetTitle(f.id, e.target.value)}
                        style={{
                          width: '100%',
                          padding: '5px 8px',
                          borderRadius: '4px',
                          border: isMissing ? '1px solid #c9252d' : '1px solid #8e8e8e',
                          fontSize: '12.5px'
                        }}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </View>

        {errorMessage && (
          <Text UNSAFE_style={{ color: '#c9252d', fontSize: '12px' }}>
            ✖ {errorMessage}
          </Text>
        )}
      </Flex>
    </View>
  );
}

function TagPickerField ({ field, value = [], onChange, availableTags = [], errorMessage }) {
  const [filterText, setFilterText] = useState('');
  const selectedIds = Array.isArray(value) ? value : (value ? [String(value)] : []);

  const rootTag = field.rootTag || null;
  const rootPrefix = rootTag && rootTag.id ? String(rootTag.id) : '';

  // Respect `rootTag` when specified on the schema field: use `field.scopedTags` if fetched,
  // or filter `availableTags` by `rootPrefix`.
  const candidatePool = (Array.isArray(field.scopedTags) && field.scopedTags.length > 0)
    ? field.scopedTags
    : (rootPrefix
      ? availableTags.filter((t) => String(t.id || '').startsWith(rootPrefix))
      : availableTags);

  const allowedTagIds = new Set(candidatePool.map((t) => t.id));

  const filteredTags = candidatePool
    .filter((t) => {
      if (selectedIds.includes(t.id)) return false;
      if (!filterText.trim()) return true;
      const q = filterText.toLowerCase();
      return t.label.toLowerCase().includes(q) || t.id.toLowerCase().includes(q);
    })
    .slice(0, 50);

  const addTag = (tagId) => {
    const clean = String(tagId || '').trim();
    if (!clean || !allowedTagIds.has(clean)) return;
    if (selectedIds.includes(clean)) return;
    onChange([...selectedIds, clean]);
  };

  const removeTag = (tagId) => {
    onChange(selectedIds.filter((id) => id !== tagId));
  };

  return (
    <View>
      <Flex direction="column" gap="size-75">
        <Flex alignItems="center" gap="size-100" wrap>
          <Text>
            <b>{field.label}</b> {field.required && <span style={{ color: '#c9252d' }}>*</span>}
          </Text>
          <span style={{ fontSize: '11px', opacity: 0.65 }}>({field.property})</span>
          {rootTag && (
            <span className="gu-chip" title={`Tag root path: ${rootTag.path}`}>
              Scoped to Root: {rootTag.name || rootTag.id} ({candidatePool.length} tags)
            </span>
          )}
        </Flex>

        {selectedIds.length > 0 && (
          <Flex wrap gap="size-75">
            {selectedIds.map((tagId) => {
              const hit =
                candidatePool.find((t) => t.id === tagId) ||
                availableTags.find((t) => t.id === tagId);
              return (
                <span key={tagId} className="gu-chip">
                  {hit ? hit.label : tagId}
                  <button
                    type="button"
                    onClick={() => removeTag(tagId)}
                    style={{
                      border: 0,
                      background: 'transparent',
                      cursor: 'pointer',
                      fontWeight: 700,
                      color: 'inherit',
                      padding: 0
                    }}
                  >
                    ×
                  </button>
                </span>
              );
            })}
          </Flex>
        )}

        <Flex gap="size-100" wrap alignItems="end">
          <TextField
            label={rootTag ? `Filter "${rootTag.name}" Tags` : 'Filter AEM Taxonomy Tags'}
            placeholder="Search existing tags..."
            value={filterText}
            onChange={setFilterText}
            width="size-3000"
          />
          <Picker
            label="Select Taxonomy Tag"
            placeholder={
              filteredTags.length > 0
                ? `Choose from ${candidatePool.length} existing tag(s)...`
                : 'No matching taxonomy tags'
            }
            isDisabled={filteredTags.length === 0}
            items={filteredTags}
            onSelectionChange={(key) => {
              if (key) addTag(String(key));
            }}
            width="size-3600"
          >
            {(item) => <Item key={item.id}>{item.label}</Item>}
          </Picker>
        </Flex>

        {errorMessage && (
          <Text UNSAFE_style={{ color: '#c9252d', fontSize: '12px' }}>
            ✖ {errorMessage}
          </Text>
        )}
      </Flex>
    </View>
  );
}

function SingleSchemaField ({
  field,
  value,
  onChange,
  availableTags = [],
  queuedFiles = [],
  perAssetTitles = {},
  onChangePerAssetTitle,
  onBatchSetPerAssetTitles,
  errorMessage
}) {
  const labelWithProperty = `${field.label} (${field.property})`;

  if (field.property === 'dc:title') {
    return (
      <PerAssetTitleField
        field={field}
        queuedFiles={queuedFiles}
        perAssetTitles={perAssetTitles}
        onChangePerAssetTitle={onChangePerAssetTitle}
        onBatchSetPerAssetTitles={onBatchSetPerAssetTitles}
        singleValue={value}
        onChangeSingleValue={onChange}
        errorMessage={errorMessage}
      />
    );
  }

  if (field.type === 'tag_picker') {
    return (
      <TagPickerField
        field={field}
        value={value}
        onChange={onChange}
        availableTags={availableTags}
        errorMessage={errorMessage}
      />
    );
  }

  if (field.type === 'dropdown' && Array.isArray(field.options) && field.options.length > 0) {
    return (
      <Flex direction="column" gap="size-50">
        <Picker
          label={labelWithProperty}
          isRequired={field.required}
          placeholder={field.placeholder || `Select ${field.label}`}
          selectedKey={value || null}
          onSelectionChange={(key) => onChange(key ? String(key) : '')}
          validationState={errorMessage ? 'invalid' : undefined}
          width="100%"
        >
          {field.options.map((opt) => (
            <Item key={opt.id}>{opt.name}</Item>
          ))}
        </Picker>
        {errorMessage && (
          <Text UNSAFE_style={{ color: '#c9252d', fontSize: '12px' }}>
            ✖ {errorMessage}
          </Text>
        )}
      </Flex>
    );
  }

  if (field.type === 'textarea') {
    return (
      <TextArea
        label={labelWithProperty}
        isRequired={field.required}
        placeholder={field.placeholder || ''}
        value={value || ''}
        onChange={onChange}
        validationState={errorMessage ? 'invalid' : undefined}
        errorMessage={errorMessage}
        width="100%"
      />
    );
  }

  if (field.type === 'datepicker') {
    return (
      <TextField
        label={`${labelWithProperty} [YYYY-MM-DD]`}
        type="date"
        isRequired={field.required}
        placeholder="YYYY-MM-DD"
        value={value || ''}
        onChange={onChange}
        validationState={errorMessage ? 'invalid' : undefined}
        errorMessage={errorMessage}
        width="100%"
      />
    );
  }

  if (field.type === 'number') {
    return (
      <TextField
        label={labelWithProperty}
        type="number"
        isRequired={field.required}
        placeholder={field.placeholder || '0'}
        value={value !== undefined && value !== null ? String(value) : ''}
        onChange={onChange}
        validationState={errorMessage ? 'invalid' : undefined}
        errorMessage={errorMessage}
        width="100%"
      />
    );
  }

  if (field.type === 'checkbox') {
    return (
      <Checkbox
        isSelected={Boolean(value)}
        onChange={onChange}
      >
        {labelWithProperty}
      </Checkbox>
    );
  }

  if (field.type === 'multi_val') {
    const strVal = Array.isArray(value) ? value.join(', ') : (value || '');
    return (
      <TextField
        label={`${labelWithProperty} (comma-separated)`}
        isRequired={field.required}
        placeholder={field.placeholder || 'value1, value2, value3'}
        value={strVal}
        onChange={(v) => onChange(v)}
        validationState={errorMessage ? 'invalid' : undefined}
        errorMessage={errorMessage}
        width="100%"
      />
    );
  }

  return (
    <TextField
      label={labelWithProperty}
      isRequired={field.required}
      placeholder={field.placeholder || ''}
      value={value || ''}
      onChange={onChange}
      validationState={errorMessage ? 'invalid' : undefined}
      errorMessage={errorMessage}
      width="100%"
    />
  );
}

function groupFieldsByTab (fields = []) {
  const groups = {};
  for (const f of fields) {
    const tab = f.tab || 'Basic';
    if (!groups[tab]) groups[tab] = [];
    groups[tab].push(f);
  }
  return groups;
}

export default function DynamicSchemaForm ({
  schema,
  values = {},
  onChangeValue,
  availableTags = [],
  queuedFiles = [],
  perAssetTitles = {},
  onChangePerAssetTitle,
  onBatchSetPerAssetTitles,
  validation
}) {
  const [showOptional, setShowOptional] = useState(false);

  if (!schema) {
    return <Text>Loading folder metadata schema...</Text>;
  }

  const requiredFields = schema.requiredFields || [];
  const optionalFields = schema.optionalFields || [];
  const requiredByTab = groupFieldsByTab(requiredFields);
  const optionalByTab = groupFieldsByTab(optionalFields);
  const errorsByProperty = (validation && validation.errorsByProperty) || {};

  const isFullWidthField = (f) =>
    f.type === 'tag_picker' ||
    f.type === 'textarea' ||
    (f.property === 'dc:title' && queuedFiles.length > 1);

  return (
    <Flex direction="column" gap="size-200">
      {/* Schema Provenance Banner */}
      <View backgroundColor="gray-100" padding="size-150" borderRadius="regular">
        <Flex justifyContent="space-between" alignItems="center" wrap gap="size-100">
          <Flex direction="column" gap="size-50">
            <Text>
              <b>Assigned Folder Schema:</b> <code>{schema.schemaName}</code>{' '}
              {schema.sourcePath && (
                <span style={{ opacity: 0.75, fontSize: '12px' }}>
                  ({schema.sourcePath})
                </span>
              )}
            </Text>
            <Text UNSAFE_style={{ fontSize: '12px', opacity: 0.8 }}>
              {schema.isInherited
                ? `Inherited from ancestor folder ${schema.inheritedFrom}`
                : `Assigned directly on ${schema.folderPath}`}
              {' · '}
              {requiredFields.length} required governance field{requiredFields.length === 1 ? '' : 's'}
              {optionalFields.length > 0 ? `, ${optionalFields.length} optional` : ''}
            </Text>
          </Flex>
          <span className={validation?.valid ? 'gu-badge-ok' : 'gu-badge-req'}>
            {validation?.valid
              ? '✓ All Required Metadata Complete'
              : `${validation?.errors?.length || 0} Required Field(s) Remaining`}
          </span>
        </Flex>
      </View>

      {/* Required Fields Grouped by Schema Tab */}
      {Object.entries(requiredByTab).map(([tabName, tabFields]) => (
        <View
          key={`req-${tabName}`}
          borderWidth="thin"
          borderColor="dark"
          borderRadius="regular"
          padding="size-200"
        >
          <Flex direction="column" gap="size-150">
            <Flex justifyContent="space-between" alignItems="center">
              <Heading level={4} margin={0}>
                {tabName} — Required Fields
              </Heading>
              <span className="gu-badge-req">Mandatory</span>
            </Flex>
            <Divider size="S" />
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
                gap: '14px'
              }}
            >
              {tabFields.map((field) => (
                <div
                  key={field.property}
                  style={isFullWidthField(field) ? { gridColumn: '1 / -1' } : undefined}
                >
                  <SingleSchemaField
                    field={field}
                    value={values[field.property]}
                    onChange={(val) => onChangeValue(field.property, val)}
                    availableTags={availableTags}
                    queuedFiles={queuedFiles}
                    perAssetTitles={perAssetTitles}
                    onChangePerAssetTitle={onChangePerAssetTitle}
                    onBatchSetPerAssetTitles={onBatchSetPerAssetTitles}
                    errorMessage={errorsByProperty[field.property]}
                  />
                </div>
              ))}
            </div>
          </Flex>
        </View>
      ))}

      {/* Optional Schema Fields Accordion */}
      {optionalFields.length > 0 && (
        <View borderWidth="thin" borderColor="light" borderRadius="regular" padding="size-150">
          <Flex direction="column" gap="size-150">
            <Flex justifyContent="space-between" alignItems="center">
              <Text>
                <b>Additional Optional Fields from "{schema.schemaName}" Schema</b> ({optionalFields.length} fields)
              </Text>
              <ActionButton onPress={() => setShowOptional(!showOptional)}>
                {showOptional ? 'Hide Optional Fields ▲' : 'Show Optional Fields ▼'}
              </ActionButton>
            </Flex>

            {showOptional &&
              Object.entries(optionalByTab).map(([tabName, tabFields]) => (
                <View key={`opt-${tabName}`} backgroundColor="gray-75" padding="size-150" borderRadius="regular">
                  <Flex direction="column" gap="size-125">
                    <Heading level={5} margin={0}>
                      {tabName} (Optional)
                    </Heading>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
                        gap: '12px'
                      }}
                    >
                      {tabFields.map((field) => (
                        <div
                          key={field.property}
                          style={isFullWidthField(field) ? { gridColumn: '1 / -1' } : undefined}
                        >
                          <SingleSchemaField
                            field={field}
                            value={values[field.property]}
                            onChange={(val) => onChangeValue(field.property, val)}
                            availableTags={availableTags}
                            queuedFiles={queuedFiles}
                            perAssetTitles={perAssetTitles}
                            onChangePerAssetTitle={onChangePerAssetTitle}
                            onBatchSetPerAssetTitles={onBatchSetPerAssetTitles}
                            errorMessage={errorsByProperty[field.property]}
                          />
                        </div>
                      ))}
                    </div>
                  </Flex>
                </View>
              ))}
          </Flex>
        </View>
      )}
    </Flex>
  );
}
