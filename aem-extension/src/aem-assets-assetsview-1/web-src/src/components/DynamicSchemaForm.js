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

function TagPickerField ({ field, value = [], onChange, availableTags = [], errorMessage }) {
  const [filterText, setFilterText] = useState('');
  const [customTagInput, setCustomTagInput] = useState('');
  const selectedIds = Array.isArray(value) ? value : (value ? [String(value)] : []);

  const filteredTags = availableTags
    .filter((t) => {
      if (selectedIds.includes(t.id)) return false;
      if (!filterText.trim()) return true;
      const q = filterText.toLowerCase();
      return t.label.toLowerCase().includes(q) || t.id.toLowerCase().includes(q);
    })
    .slice(0, 30);

  const addTag = (tagId) => {
    const clean = String(tagId || '').trim();
    if (!clean || selectedIds.includes(clean)) return;
    onChange([...selectedIds, clean]);
  };

  const removeTag = (tagId) => {
    onChange(selectedIds.filter((id) => id !== tagId));
  };

  return (
    <View>
      <Flex direction="column" gap="size-75">
        <Flex alignItems="center" gap="size-75">
          <Text>
            <b>{field.label}</b> {field.required && <span style={{ color: '#c9252d' }}>*</span>}
          </Text>
          <span style={{ fontSize: '11px', opacity: 0.65 }}>({field.property})</span>
        </Flex>

        {selectedIds.length > 0 && (
          <Flex wrap gap="size-75">
            {selectedIds.map((tagId) => {
              const hit = availableTags.find((t) => t.id === tagId);
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
            label="Filter AEM Taxonomy Tags"
            placeholder="Search brand, channel, region, category..."
            value={filterText}
            onChange={setFilterText}
            width="size-3000"
          />
          {filteredTags.length > 0 && (
            <Picker
              label="Select Taxonomy Tag"
              placeholder={`Choose from ${availableTags.length} AEM tags...`}
              items={filteredTags}
              onSelectionChange={(key) => {
                if (key) addTag(String(key));
              }}
              width="size-3600"
            >
              {(item) => <Item key={item.id}>{item.label}</Item>}
            </Picker>
          )}
          <Flex gap="size-75" alignItems="end">
            <TextField
              label="Or add tag ID (namespace:tag)"
              placeholder="e.g. region:amer"
              value={customTagInput}
              onChange={setCustomTagInput}
              width="size-2400"
            />
            <ActionButton
              onPress={() => {
                if (customTagInput.trim()) {
                  addTag(customTagInput.trim());
                  setCustomTagInput('');
                }
              }}
            >
              Add Tag
            </ActionButton>
          </Flex>
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

function SingleSchemaField ({ field, value, onChange, availableTags = [], errorMessage }) {
  const labelWithProperty = `${field.label} (${field.property})`;

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
                  style={
                    field.type === 'tag_picker' || field.type === 'textarea'
                      ? { gridColumn: '1 / -1' }
                      : undefined
                  }
                >
                  <SingleSchemaField
                    field={field}
                    value={values[field.property]}
                    onChange={(val) => onChangeValue(field.property, val)}
                    availableTags={availableTags}
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
                          style={
                            field.type === 'tag_picker' || field.type === 'textarea'
                              ? { gridColumn: '1 / -1' }
                              : undefined
                          }
                        >
                          <SingleSchemaField
                            field={field}
                            value={values[field.property]}
                            onChange={(val) => onChangeValue(field.property, val)}
                            availableTags={availableTags}
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
