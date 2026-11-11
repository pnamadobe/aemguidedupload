import React, { useState } from 'react';
import {
  Flex,
  View,
  Text,
  Heading,
  TextField,
  TextArea,
  SearchField,
  Picker,
  Item,
  Checkbox,
  ActionButton,
  Divider,
  StatusLight
} from '@adobe/react-spectrum';
import ChevronDown from '@spectrum-icons/workflow/ChevronDown';
import ChevronUp from '@spectrum-icons/workflow/ChevronUp';

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
        label={field.label}
        isRequired={field.required}
        placeholder="Leave blank for AI-generated title"
        description="When left blank, AEM automatically generates a descriptive title during processing."
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
    <div className="gu-card-subtle">
      <Flex direction="column" gap="size-125">
        <Flex justifyContent="space-between" alignItems="center" wrap gap="size-100">
          <Flex direction="column" gap="size-25">
            <Flex alignItems="center" gap="size-75">
              <Text UNSAFE_style={{ fontWeight: 600 }}>
                {field.label} ({queuedFiles.length} assets)
                {field.required && <span style={{ color: '#c9252d', marginLeft: '4px' }}>*</span>}
              </Text>
            </Flex>
            <Text UNSAFE_style={{ fontSize: '11.5px', opacity: 0.75 }}>
              Leave blank to let AEM automatically generate a descriptive title for each asset on upload.
            </Text>
          </Flex>
          <Flex gap="size-75" alignItems="end" wrap>
            <TextField
              label="Title Prefix"
              placeholder="e.g. Winter 2026"
              value={prefixInput}
              onChange={setPrefixInput}
              width="size-2000"
            />
            <ActionButton onPress={autoFillFromNames}>
              {prefixInput.trim() ? 'Apply Prefix + Filename' : 'Fill from Filenames'}
            </ActionButton>
            <ActionButton isQuiet onPress={clearAllToUseAi}>
              Clear (Use AI Title)
            </ActionButton>
          </Flex>
        </Flex>

        <View maxHeight="size-2400" overflow="auto">
          <table className="gu-table">
            <thead>
              <tr>
                <th style={{ width: '42%' }}>Asset File</th>
                <th>Title {field.required ? '*' : '(Optional — blank uses AI title)'}</th>
              </tr>
            </thead>
            <tbody>
              {queuedFiles.map((f) => {
                const currentTitle = perAssetTitles[f.id] || '';
                const isMissing = field.required && !currentTitle.trim();
                return (
                  <tr key={f.id}>
                    <td>{f.relativePath || f.name}</td>
                    <td>
                      <input
                        type="text"
                        className={`gu-inline-input ${isMissing ? 'is-invalid' : ''}`}
                        value={currentTitle}
                        placeholder="Leave blank for AI-generated title…"
                        onChange={(e) => onChangePerAssetTitle(f.id, e.target.value)}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </View>

        {errorMessage && (
          <Text UNSAFE_style={{ color: '#d7373f', fontSize: '12px' }}>
            {errorMessage}
          </Text>
        )}
      </Flex>
    </div>
  );
}

function TagPickerField ({ field, value = [], onChange, availableTags = [], errorMessage }) {
  const [filterText, setFilterText] = useState('');
  const selectedIds = Array.isArray(value) ? value : (value ? [String(value)] : []);

  const rootTag = field.rootTag || null;
  const rootPrefix = rootTag && rootTag.id ? String(rootTag.id) : '';

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
      <Flex direction="column" gap="size-100">
        <Flex alignItems="center" justifyContent="space-between" wrap gap="size-100">
          <Text UNSAFE_style={{ fontSize: '12px', fontWeight: 500, opacity: 0.85 }}>
            {field.label}
            {field.required && <span style={{ color: '#d7373f', marginLeft: '4px' }}>*</span>}
          </Text>
          {rootTag && (
            <span className="gu-badge-neutral">
              {rootTag.name || rootTag.id} ({candidatePool.length})
            </span>
          )}
        </Flex>

        <Flex gap="size-125" wrap alignItems="end">
          <SearchField
            aria-label={`Search ${field.label}`}
            placeholder="Filter tags…"
            value={filterText}
            onChange={setFilterText}
            width="size-3000"
          />
          <Picker
            aria-label={`Select ${field.label}`}
            placeholder={
              filteredTags.length > 0
                ? `Select from ${candidatePool.length} tag${candidatePool.length === 1 ? '' : 's'}…`
                : 'No matching tags'
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

        {selectedIds.length > 0 && (
          <Flex wrap gap="size-75" marginTop="size-25">
            {selectedIds.map((tagId) => {
              const hit =
                candidatePool.find((t) => t.id === tagId) ||
                availableTags.find((t) => t.id === tagId);
              return (
                <span key={tagId} className="gu-chip">
                  {hit ? hit.label : tagId}
                  <button
                    type="button"
                    className="gu-chip-remove"
                    aria-label={`Remove ${hit ? hit.label : tagId}`}
                    onClick={() => removeTag(tagId)}
                  >
                    ×
                  </button>
                </span>
              );
            })}
          </Flex>
        )}

        {errorMessage && (
          <Text UNSAFE_style={{ color: '#d7373f', fontSize: '12px' }}>
            {errorMessage}
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
  const cleanLabel = field.label || field.property;

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
          label={cleanLabel}
          isRequired={field.required}
          placeholder={field.placeholder || `Select ${cleanLabel}`}
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
          <Text UNSAFE_style={{ color: '#d7373f', fontSize: '12px' }}>
            {errorMessage}
          </Text>
        )}
      </Flex>
    );
  }

  if (field.type === 'textarea') {
    return (
      <TextArea
        label={cleanLabel}
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
        label={cleanLabel}
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
        label={cleanLabel}
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
        {cleanLabel}
      </Checkbox>
    );
  }

  if (field.type === 'multi_val') {
    const strVal = Array.isArray(value) ? value.join(', ') : (value || '');
    return (
      <TextField
        label={cleanLabel}
        description="Separate multiple values with commas"
        isRequired={field.required}
        placeholder={field.placeholder || 'value1, value2'}
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
      label={cleanLabel}
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
    return <Text>Loading metadata form…</Text>;
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
      {/* Schema Summary Header */}
      <div className="gu-card-subtle">
        <Flex justifyContent="space-between" alignItems="center" wrap gap="size-100">
          <Flex alignItems="center" gap="size-100" wrap>
            <Text UNSAFE_style={{ fontSize: '12.5px' }}>
              Metadata Form: <b>{schema.schemaName}</b>
            </Text>
            <span className="gu-badge-neutral">
              {schema.isInherited
                ? `Inherited from ${schema.inheritedFrom}`
                : `Assigned to ${schema.folderPath}`}
            </span>
          </Flex>
          <StatusLight variant={validation?.valid ? 'positive' : 'notice'}>
            {validation?.valid
              ? 'All required fields complete'
              : `${validation?.errors?.length || 0} required field${validation?.errors?.length === 1 ? '' : 's'} remaining`}
          </StatusLight>
        </Flex>
      </div>

      {/* Required Fields Grouped by Schema Section */}
      {Object.entries(requiredByTab).map(([tabName, tabFields]) => (
        <div key={`req-${tabName}`} className="gu-card">
          <Flex direction="column" gap="size-150">
            <Flex justifyContent="space-between" alignItems="center">
              <Heading level={4} margin={0}>
                {tabName}
              </Heading>
              <span className="gu-badge-req">Required</span>
            </Flex>
            <Divider size="S" />
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
                gap: '16px'
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
        </div>
      ))}

      {/* Optional Schema Fields Accordion */}
      {optionalFields.length > 0 && (
        <div className="gu-card-subtle">
          <Flex direction="column" gap="size-150">
            <Flex justifyContent="space-between" alignItems="center">
              <Text UNSAFE_style={{ fontWeight: 600, fontSize: '13px' }}>
                Additional Metadata Fields ({optionalFields.length} optional)
              </Text>
              <ActionButton isQuiet onPress={() => setShowOptional(!showOptional)}>
                {showOptional ? <ChevronUp size="S" /> : <ChevronDown size="S" />}
                <Text>{showOptional ? 'Hide Optional' : 'Show Optional'}</Text>
              </ActionButton>
            </Flex>

            {showOptional &&
              Object.entries(optionalByTab).map(([tabName, tabFields]) => (
                <div key={`opt-${tabName}`} className="gu-card">
                  <Flex direction="column" gap="size-125">
                    <Heading level={5} margin={0}>
                      {tabName}
                    </Heading>
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
                </div>
              ))}
          </Flex>
        </div>
      )}
    </Flex>
  );
}
