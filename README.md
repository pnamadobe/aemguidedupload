# AEM Guided Upload — App Builder UI Extension & Drag-and-Drop Guardrail

Solves **"There's no guardrails on Upload — users bypass our taxonomy and rights rules"** in AEM Assets View by:

1. **Overriding the built-in `Add assets` header button (`headerMenu.overrideButton`)** in AEM Assets View (`aem/assets/assetsview/1`) with a 3-step **Guided Upload Wizard Modal**.
2. **Dynamically resolving the target DAM folder's assigned Metadata Form / Schema** (walking up the folder hierarchy to find `dam:metadataForm` under `/content/dam/appdata/metadataforms/...` or `metadataSchema` under `/conf/global/settings/dam/adminui-extension/metadataschema/...`).
3. **Preserving full nested folder hierarchies** on drag-and-drop and folder selection (`webkitGetAsEntry()` + `webkitdirectory`), creating subfolders in topological order on commit.
4. **Enforcing token-based auto-naming conventions** derived directly from the folder's schema metadata fields (e.g., `{folder}_{campaignName}_{resortsActivity}_{seq}.{ext}`).
5. **Reusing 100% of AEM's native Direct Binary Upload pipeline** (`initiateUpload.json` → browser-to-Blob `PUT` → `completeUpload.json` + Assets HTTP API metadata writeback).
6. **Intercepting raw grid drag-and-drop via a companion Chrome Extension (`chrome-extension/`)** that blocks ungoverned drops on the Assets View canvas, opens the Guided Upload modal, and hands off the dropped files and folder tree via `window.postMessage` (HTML5 Structured Clone).

---

## Repository Structure

```text
guidedupload/
├── aem-extension/                             # Adobe App Builder Extension (aem/assets/assetsview/1)
│   ├── app.config.yaml
│   ├── extension-manifest.json
│   ├── package.json
│   └── src/aem-assets-assetsview-1/
│       ├── ext.config.yaml
│       ├── actions/
│       │   ├── utils.js                       # IMS Bearer auth, server-pinned AEM Author allowlist & DAM path validation
│       │   ├── schema-resolver.js             # Folder ancestor walk + Assets View Form & Admin Schema parser
│       │   ├── upload-broker.js               # Subfolder tree creation + initiate/complete + metadata normalization
│       │   └── guided-upload-api/index.js     # Web action router (resolveSchema, listTags, initiate, complete)
│       ├── web-src/src/components/
│       │   ├── ExtensionRegistration.js       # Overrides headerMenu 'addAssets' button + Chrome ext bridge
│       │   ├── ModalGuidedUpload.js           # 3-Step Guided Upload Wizard Modal
│       │   ├── FolderDropzone.js              # Recursive file & folder dropzone + folder hierarchy preview
│       │   ├── DynamicSchemaForm.js           # Renders folder's assigned AEM Metadata Form + Tag Picker
│       │   ├── NamingEngine.js                # Token-based filename generator + regex & collision validator
│       │   └── ValidationRules.js             # Schema required check + expiration check + pluggable custom rules
│       └── test/
│           └── guided-upload.test.js          # Jest unit & integration test suite
└── chrome-extension/                          # Companion MV3 Chrome Extension ("AEM Guided Upload Guardrail")
    ├── manifest.json
    ├── options.html / options.js
    └── src/
        ├── folder-reader.js                   # Synchronous webkitGetAsEntry() + recursive DirectoryReader
        ├── modal-bridge.js                    # Triggers "Add assets" & postMessages dropped File tree to modal
        └── dnd-guard.js                       # Capture-phase dragenter/dragover/drop interceptor + overlay UI
```

---

## Quick Start

### 1. Run Unit Tests & Live AEM Schema Verification
```bash
cd aem-extension
npm test
```

### 2. Run or Deploy the App Builder Extension (`aem-extension/`)
1. Copy `.env.example` to `.env` (or link your Adobe Developer Console project with `aio app use`):
   ```bash
   cd aem-extension
   aio app run
   # or deploy to Stage/Production:
   aio app deploy
   ```
2. Open the preview link printed after `aio app run` / `aio app deploy`, or add `?ext=https://localhost:9080` to your AEM Assets View URL.
3. Navigate to any DAM folder (for example `/content/dam/26H2/vail/assets` or `/content/dam/26H2/united`) and click **"Add assets"** in the top-right header.

### 3. Load the Companion Drag-and-Drop Guardrail Chrome Extension (`chrome-extension/`)
1. Open Chrome and navigate to `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select `/Users/pnam/Sandbox/guidedupload/chrome-extension`.
4. Drag any file or nested folder onto the AEM Assets View browse grid:
   - The native ungoverned dropzone is blocked in the capture phase.
   - The **Guided Upload** modal opens automatically with your dropped files and subfolder hierarchy pre-loaded.

---

## Security & Authentication Architecture

- **Mandatory IMS User Authentication (C1)**:
  - The Adobe I/O Runtime action (`guided-upload-api`) enforces `require-adobe-auth: true` at the gateway and validates the caller's `Authorization: Bearer <token>` HTTP header inside `resolveAemContext()`.
  - Static service-account (`AEM_SC_JSON`), developer-token (`AEM_DEV_TOKEN`), and request-body token (`userToken`) fallbacks are excluded so every DAM read/write executes strictly under the signed-in user's AEM permissions.
  - The modal waits for the UIX guest connection (`attach()`) to settle before invoking `guided-upload-api` and passes `Authorization` (and `x-gw-ims-org-id` when provided by the host) exclusively via HTTP headers.
- **Server-Pinned AEM Author Allowlist (C2)**:
  - `AEM_AUTHOR_URL` is bound as a finalized (`final: true`) Runtime action input in `ext.config.yaml` (supports a single AEM Author origin or a comma-separated allowlist via `AEM_AUTHOR_URL` / `AEM_ALLOWED_AUTHORS`).
  - All backend operations default to the server-pinned `AEM_AUTHOR_URL` and reject any request supplying a non-allowlisted `aemAuthorUrl` with `403 Forbidden`, preventing Bearer token redirection/SSRF to foreign `author-p*-e*.adobeaemcloud.com` instances.
  - The web UI never reads or trusts `aemAuthorUrl` from URL query parameters, `localStorage`, or `window.postMessage` payloads.
