/*
 * Unit & integration tests for the Guided Upload extension:
 *   1. Schema Resolver (Assets View Form & Admin View Schema parsing, ancestor folder walk, Two-Tier required promotion)
 *   2. Validation Rules Engine (required fields, expiration date in the past, pluggable custom rules)
 *   3. Auto-Naming & Subfolder Hygiene Engine (token interpolation, sequence numbering, regex & collision checks)
 *   4. Upload Broker (folder hierarchy creation, initiateUpload, completeUpload, metadata normalization: xcm:keywords -> cq:tags, dam:assetStatus <-> dam:status)
 */

const {
  parseAssetsViewForm,
  parseAdminViewSchema,
  resolveFieldRequirements,
  buildNamingTokensAndPattern,
  resolveFolderSchema
} = require('../actions/schema-resolver');

const {
  validateMetadataValues,
  registerValidationRule
} = require('../web-src/src/components/ValidationRules');

const {
  generateGovernedFileName,
  computeBatchNamingPlan,
  sanitizeSubfolderPath
} = require('../web-src/src/components/NamingEngine');

const {
  normalizeMetadataForAem,
  initiateBatchUpload,
  completeBatchUpload
} = require('../actions/upload-broker');

describe('1. Folder Metadata Schema & Form Resolver', () => {
  const sampleAssetsViewResortsForm = {
    tabs: [
      {
        id: 0,
        label: 'Basic',
        fields: [
          {
            header: 'Metadata',
            fields: [
              { name: 'title', mapToProperty: 'dc:title', readOnly: false, label: 'Title', required: false, element: 'text' },
              { name: 'desc', mapToProperty: 'dc:description', readOnly: false, label: 'Description', required: false, element: 'textarea' },
              { name: 'tags', mapToProperty: 'xcm:keywords', readOnly: false, label: 'Tags', required: false, element: 'tag_picker' },
              { name: 'format', mapToProperty: 'dc:format', readOnly: true, label: 'Type', required: false, element: 'text' }
            ]
          }
        ]
      },
      {
        id: 1,
        label: 'Rights',
        fields: [
          {
            header: 'License',
            fields: [
              {
                name: 'license',
                mapToProperty: 'dc:license',
                readOnly: false,
                label: 'License Agreement',
                required: false,
                element: 'dropdown',
                dropdownOptions: [
                  { id: 'internal', name: 'Internal Terms' },
                  { id: 'partner', name: 'Partner License' }
                ]
              },
              { name: 'expires', mapToProperty: 'pur:expirationDate', readOnly: false, label: 'Expires', required: false, element: 'datepicker' }
            ]
          }
        ]
      },
      {
        id: 7,
        label: 'Resorts',
        fields: [
          { name: 'act', mapToProperty: 'xdm:resortsActivity', readOnly: false, label: 'Activity', required: false, element: 'text' },
          { name: 'season', mapToProperty: 'xdm:resortsSeason', readOnly: false, label: 'Season', required: false, element: 'text' }
        ]
      },
      {
        id: 4,
        label: 'Camera Data',
        fields: [
          { name: 'make', mapToProperty: 'tiff:Make', readOnly: true, label: 'Make', required: false, element: 'text' }
        ]
      }
    ]
  };

  test('parses Assets View Metadata Form, skips read-only/camera fields, and promotes vertical + governance fields', () => {
    const rawFields = parseAssetsViewForm(sampleAssetsViewResortsForm);
    expect(rawFields.map((f) => f.property)).toEqual([
      'dc:title',
      'dc:description',
      'xcm:keywords',
      'dc:license',
      'pur:expirationDate',
      'xdm:resortsActivity',
      'xdm:resortsSeason'
    ]);

    const { requirementMode, fields } = resolveFieldRequirements(rawFields);
    expect(requirementMode).toBe('smart-governance-promotion');

    const reqProps = fields.filter((f) => f.required).map((f) => f.property);
    expect(reqProps).toEqual([
      'dc:title',
      'xcm:keywords',
      'dc:license',
      'pur:expirationDate',
      'xdm:resortsActivity',
      'xdm:resortsSeason'
    ]);

    // dc:description stays optional
    const optProps = fields.filter((f) => !f.required).map((f) => f.property);
    expect(optProps).toEqual(['dc:description']);

    const naming = buildNamingTokensAndPattern(fields, 'resorts');
    expect(naming.tokens.some((t) => t.property === 'xdm:resortsActivity')).toBe(true);
    expect(naming.defaultPattern).toContain('{folder}');
    expect(naming.defaultPattern).toContain('{seq}');
  });

  test('honors Tier-1 explicit required: true flags when set in the schema', () => {
    const explicitForm = {
      tabs: [
        {
          id: 0,
          label: 'Basic',
          fields: [
            { name: 'title', mapToProperty: 'dc:title', readOnly: false, label: 'Title', required: true, element: 'text' },
            { name: 'brand', mapToProperty: 'product:brand', readOnly: false, label: 'Brand', required: false, element: 'text' }
          ]
        }
      ]
    };
    const parsed = parseAssetsViewForm(explicitForm);
    const { requirementMode, fields } = resolveFieldRequirements(parsed);
    expect(requirementMode).toBe('explicit-schema');
    expect(fields.filter((f) => f.required).map((f) => f.property)).toEqual(['dc:title']);
  });

  test('parses Admin View Metadata Schema (/conf/.../metadataschema) when Assets View form is absent', () => {
    const adminSchema = {
      items: {
        tabs: {
          items: {
            tab1: {
              'jcr:title': 'Basic',
              items: {
                col1: {
                  items: {
                    title: {
                      fieldLabel: 'Title',
                      name: './jcr:content/metadata/dc:title',
                      'granite:data': { metaType: 'text', requiredCascading: 'always' }
                    }
                  }
                }
              }
            }
          }
        }
      }
    };
    const fields = parseAdminViewSchema(adminSchema);
    expect(fields).toHaveLength(1);
    expect(fields[0].property).toBe('dc:title');
    expect(fields[0].required).toBe(true);
  });

  test('walks ancestor folders to inherit schema from parent folder', async () => {
    const origFetch = global.fetch;
    global.fetch = async (url) => {
      if (url.includes('/content/dam/26H2/vail/assets/sub;resource=applicationmetadata')) {
        return { ok: true, text: async () => JSON.stringify({ 'dc:title': 'sub' }) };
      }
      if (url.includes('/content/dam/26H2/vail/assets;resource=applicationmetadata')) {
        return { ok: true, text: async () => JSON.stringify({ 'dc:title': 'assets' }) };
      }
      if (url.includes('/content/dam/26H2/vail;resource=applicationmetadata')) {
        return {
          ok: true,
          text: async () => JSON.stringify({
            'dc:title': 'vail',
            'dam:metadataForm': '/content/dam/appdata/metadataforms/resorts',
            metadataSchema: '/conf/global/settings/dam/adminui-extension/metadataschema/resorts'
          })
        };
      }
      if (url.includes('/adobe/repository/content/dam/appdata/metadataforms/resorts')) {
        return { ok: true, text: async () => JSON.stringify(sampleAssetsViewResortsForm) };
      }
      return { ok: false, status: 404, text: async () => '' };
    };

    try {
      const schema = await resolveFolderSchema('https://author-p59602-e520244.adobeaemcloud.com', 'tok', '/content/dam/26H2/vail/assets/sub');
      expect(schema.schemaName).toBe('resorts');
      expect(schema.inheritedFrom).toBe('/content/dam/26H2/vail');
      expect(schema.isInherited).toBe(true);
      expect(schema.requiredFields.length).toBeGreaterThanOrEqual(5);
    } finally {
      global.fetch = origFetch;
    }
  });
});

describe('2. Metadata & Rights Validation Engine', () => {
  const schemaFields = [
    { property: 'dc:title', label: 'Title', required: true, type: 'text' },
    { property: 'pur:expirationDate', label: 'Expires', required: true, type: 'datepicker' },
    { property: 'xcm:keywords', label: 'Tags', required: true, type: 'tag_picker' }
  ];

  test('blocks when required fields are missing or expiration date is in the past', () => {
    const res1 = validateMetadataValues({ 'dc:title': 'Hero' }, schemaFields);
    expect(res1.valid).toBe(false);
    expect(res1.errorsByProperty['pur:expirationDate']).toBeDefined();
    expect(res1.errorsByProperty['xcm:keywords']).toBeDefined();

    const resPast = validateMetadataValues(
      {
        'dc:title': 'Hero',
        'pur:expirationDate': '2020-01-01',
        'xcm:keywords': ['region:amer']
      },
      schemaFields
    );
    expect(resPast.valid).toBe(false);
    expect(resPast.errorsByProperty['pur:expirationDate']).toMatch(/past/);

    const resValid = validateMetadataValues(
      {
        'dc:title': 'Hero',
        'pur:expirationDate': '2028-12-31',
        'xcm:keywords': ['region:amer']
      },
      schemaFields
    );
    expect(resValid.valid).toBe(true);
  });

  test('supports pluggable custom validation rules', () => {
    registerValidationRule((values) => {
      if (values['dc:license'] === 'external' && !values['drm:contractNumber']) {
        return [{ property: 'drm:contractNumber', label: 'Contract Number', message: 'Contract Number is required for external licenses' }];
      }
      return [];
    });

    const res = validateMetadataValues({ 'dc:license': 'external' }, []);
    expect(res.valid).toBe(false);
    expect(res.errorsByProperty['drm:contractNumber']).toMatch(/Contract Number/);
  });

  test('validates per-asset dc:title across multiple queued files and enforces tag rootTag scope', () => {
    const fields = [
      { property: 'dc:title', label: 'Title', required: true, type: 'text', perAsset: true },
      {
        property: 'xdm:playerName',
        label: 'Players Featured',
        required: true,
        type: 'tag_picker',
        rootTag: {
          path: '/content/cq:tags/sports/spurs/team-2025-26',
          id: 'sports:spurs/team-2025-26',
          name: 'Sports : Spurs / Team 2025-26'
        }
      }
    ];
    const files = [
      { id: 'f1', name: 'one.jpg' },
      { id: 'f2', name: 'two.jpg' }
    ];

    // Missing title on f2 + out-of-scope tag on xdm:playerName
    const bad = validateMetadataValues(
      { 'xdm:playerName': ['region:amer'] },
      fields,
      { queuedFiles: files, perAssetTitles: { f1: 'Asset One', f2: '' } }
    );
    expect(bad.valid).toBe(false);
    expect(bad.errorsByProperty['dc:title']).toMatch(/1 of 2 missing/);
    expect(bad.errorsByProperty['xdm:playerName']).toMatch(/must be under root/);

    // Both files have titles + tag is under sports:spurs/team-2025-26
    const good = validateMetadataValues(
      { 'xdm:playerName': ['sports:spurs/team-2025-26/de-aaron-fox'] },
      fields,
      { queuedFiles: files, perAssetTitles: { f1: 'Asset One', f2: 'Asset Two' } }
    );
    expect(good.valid).toBe(true);
  });
});

describe('3. Token Auto-Naming & Subfolder Preservation Engine', () => {
  const schemaTokens = [
    { key: 'folder', property: '__folder', builtIn: true },
    { key: 'seq', property: '__seq', builtIn: true },
    { key: 'activity', property: 'xdm:resortsActivity' },
    { key: 'season', property: 'xdm:resortsSeason' }
  ];

  test('interpolates metadata tokens and preserves subfolder paths', () => {
    const name = generateGovernedFileName({
      pattern: '{folder}_{season}_{activity}_{seq}',
      baseFolder: '/content/dam/26H2/vail/assets',
      subfolder: 'Winter Shoot/Hero Images',
      originalFileName: 'IMG_9021.JPG',
      sequenceNumber: 1,
      metadataValues: {
        'xdm:resortsSeason': 'Winter 2026',
        'xdm:resortsActivity': 'Powder Skiing'
      },
      schemaTokens,
      caseStyle: 'kebab'
    });
    expect(name).toBe('assets_winter-2026_powder-skiing_001.jpg');

    const batch = computeBatchNamingPlan({
      files: [
        { id: '1', name: 'IMG_1.JPG', size: 100, subfolder: 'Winter Shoot/Hero Images' },
        { id: '2', name: 'IMG_2.PNG', size: 200, subfolder: 'Winter Shoot/Social Stories' }
      ],
      pattern: '{folder}_{season}_{activity}_{seq}',
      baseFolder: '/content/dam/26H2/vail/assets',
      metadataValues: {
        'xdm:resortsSeason': 'Winter',
        'xdm:resortsActivity': 'Skiing'
      },
      schemaTokens,
      caseStyle: 'kebab',
      normalizeSubfolders: true
    });

    expect(batch.allValid).toBe(true);
    expect(batch.items[0].targetFolder).toBe('/content/dam/26H2/vail/assets/winter-shoot/hero-images');
    expect(batch.items[0].governedName).toBe('assets_winter_skiing_001.jpg');
    expect(batch.items[1].targetFolder).toBe('/content/dam/26H2/vail/assets/winter-shoot/social-stories');
    expect(batch.items[1].governedName).toBe('assets_winter_skiing_001.png');
  });

  test('preserves raw subfolder names when normalizeSubfolders is false', () => {
    expect(sanitizeSubfolderPath('Winter Shoot/Hero Images', false)).toBe('Winter Shoot/Hero Images');
    expect(sanitizeSubfolderPath('Winter Shoot/Hero Images', true)).toBe('winter-shoot/hero-images');
  });
});

describe('4. Upload Broker & Metadata Normalization', () => {
  test('maps xcm:keywords -> cq:tags, mirrors dam:assetStatus <-> dam:status, and normalizes dates', () => {
    const normalized = normalizeMetadataForAem({
      'dc:title': 'Vail Powder Hero',
      'xcm:keywords': ['approved-channels:paid-social', 'region:amer'],
      'dam:assetStatus': 'approved',
      'pur:expirationDate': '2027-06-30',
      'dc:subject': 'skiing, powder, winter',
      'xdm:resortsActivity': 'Skiing'
    });

    expect(normalized['cq:tags']).toEqual(['approved-channels:paid-social', 'region:amer']);
    expect(normalized['xcm:keywords']).toBeUndefined();
    expect(normalized['dam:status']).toBe('approved');
    expect(normalized['dam:assetStatus']).toBe('approved');
    expect(normalized['pur:expirationDate']).toBe('2027-06-30T23:59:59.000Z');
    expect(normalized['prism:expirationDate']).toBe('2027-06-30T23:59:59.000Z');
    expect(normalized['dc:subject']).toEqual(['skiing', 'powder', 'winter']);
    expect(normalized['xdm:resortsActivity']).toBe('Skiing');
    expect(normalized['dam:guidedUploadCommitted']).toBe('true');
  });

  test('initiates and completes upload while creating nested subfolders in topological order', async () => {
    const calls = [];
    const origFetch = global.fetch;
    global.fetch = async (url, opts = {}) => {
      const method = opts.method || 'GET';
      calls.push(`${method} ${url}`);
      if (method === 'GET' && url.includes('/api/assets/26H2/vail/assets.json')) {
        return { ok: true, status: 200 };
      }
      if (method === 'GET' && url.includes('/api/assets/26H2/vail/assets/')) {
        return { ok: false, status: 404 };
      }
      if (method === 'POST' && url.includes('/api/assets/26H2/vail/assets/')) {
        return { ok: true, status: 201 };
      }
      if (method === 'POST' && url.endsWith('.initiateUpload.json')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            files: [{
              fileName: 'vail-winter-001.jpg',
              mimeType: 'image/jpeg',
              uploadToken: 'tok-123',
              uploadURIs: ['https://blob.example/part1']
            }]
          })
        };
      }
      if (method === 'POST' && url.endsWith('.completeUpload.json')) {
        return { ok: true, status: 200, text: async () => '{}' };
      }
      if (method === 'PUT' && url.includes('/api/assets/26H2/vail/assets/')) {
        return { ok: true, status: 200, text: async () => '{}' };
      }
      return { ok: false, status: 500 };
    };

    try {
      const initRes = await initiateBatchUpload(
        'https://author-p59602-e520244.adobeaemcloud.com',
        'token-abc',
        '/content/dam/26H2/vail/assets',
        [{ clientId: 'c1', fileName: 'vail-winter-001.jpg', fileSize: 4096, mimeType: 'image/jpeg', subfolder: 'campaign/hero' }]
      );

      expect(initRes.files).toHaveLength(1);
      expect(initRes.files[0].targetFolder).toBe('/content/dam/26H2/vail/assets/campaign/hero');
      expect(initRes.files[0].uploadURIs).toEqual(['https://blob.example/part1']);

      // Verify parent subfolder 'campaign' was created before child 'campaign/hero'
      const postFolderCalls = calls.filter((c) => c.startsWith('POST https://author-p59602-e520244.adobeaemcloud.com/api/assets/'));
      expect(postFolderCalls).toEqual([
        'POST https://author-p59602-e520244.adobeaemcloud.com/api/assets/26H2/vail/assets/campaign',
        'POST https://author-p59602-e520244.adobeaemcloud.com/api/assets/26H2/vail/assets/campaign/hero'
      ]);

      const compRes = await completeBatchUpload(
        'https://author-p59602-e520244.adobeaemcloud.com',
        'token-abc',
        [{
          clientId: 'c1',
          fileName: 'vail-winter-001.jpg',
          targetFolder: '/content/dam/26H2/vail/assets/campaign/hero',
          mimeType: 'image/jpeg',
          fileSize: 4096,
          uploadToken: 'tok-123'
        }],
        { 'dc:title': 'Vail Winter Hero', 'xcm:keywords': ['region:amer'] }
      );

      expect(compRes.completedCount).toBe(1);
      expect(compRes.assets[0].damPath).toBe('/content/dam/26H2/vail/assets/campaign/hero/vail-winter-001.jpg');
      expect(compRes.assets[0].appliedMetadata['cq:tags']).toEqual(['region:amer']);
    } finally {
      global.fetch = origFetch;
    }
  });
});
