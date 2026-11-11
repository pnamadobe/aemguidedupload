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

## Security, Performance & Governance Architecture

### 1. Security Hardening
- **Mandatory IMS User Authentication (C1)**:
  - The Adobe I/O Runtime action (`guided-upload-api`) enforces `require-adobe-auth: true` at the gateway and validates the caller's `Authorization: Bearer <token>` HTTP header inside `resolveAemContext()`.
  - Static service-account (`AEM_SC_JSON`), developer-token (`AEM_DEV_TOKEN`), and request-body token (`userToken`) fallbacks are excluded so every DAM read/write executes strictly under the signed-in user's AEM permissions.
  - The modal reads `gc.sharedContext.get('auth')` immediately upon UIX connection (`attach()`) and passes `Authorization` (and `x-gw-ims-org-id`) exclusively via HTTP headers.
- **Server-Pinned AEM Author Allowlist (C2)**:
  - `AEM_AUTHOR_URL` is bound as a finalized (`final: true`) Runtime action input in `ext.config.yaml` (supports a single AEM Author origin or a comma-separated allowlist via `AEM_AUTHOR_URL` / `AEM_ALLOWED_AUTHORS`).
  - All backend operations default to the server-pinned `AEM_AUTHOR_URL` and reject any request supplying a non-allowlisted `aemAuthorUrl` with `403 Forbidden`, preventing Bearer token redirection/SSRF to foreign `author-p*-e*.adobeaemcloud.com` instances.
  - The web UI never reads or trusts `aemAuthorUrl` from URL query parameters, `localStorage`, or `window.postMessage` payloads.
- **Cross-Frame `postMessage` Origin Allowlist & Targeted File Delivery (H1 & H2)**:
  - Every `window.addEventListener('message')` handler in the web app and companion Chrome extension validates `event.origin` against an explicit Adobe origin allowlist (`https://experience.adobe.com`, `https://experience-stage.adobe.com`, `https://*.adobeaemcloud.com`, `https://*.adobeio-static.net`, and `localhost`).
  - Dropped `File` objects are never broadcast with `postMessage(..., '*')`; `DROPPED_FILES` is delivered exclusively to the verified `event.source` and `event.origin` that signaled `MODAL_READY`.
- **Backend Governance, Protected JCR Properties & Filename Validation (H3, H4, H5)**:
  - `validateFileName()` enforces `/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,180}\.[a-zA-Z0-9]{1,10}$/` on both client and server, blocking path traversal and JCR-illegal characters (`* : [ ] | % # ?`).
  - `normalizeMetadataForAem()` strips protected/system JCR namespaces (`jcr:*`, `sling:*`, `rep:*`, `oak:*`, `granite:*`, `dam:sha1`, `dam:size`) and verifies `targetFolder` is inside `baseFolder`.
  - Pre-upload duplicate detection (`initiateBatchUpload`) checks whether any governed filename already exists in the target AEM folder and prompts the user to **Keep Both** (auto-renaming `-1`, `-2`), **Replace**, **Create Version**, or **Skip**.

### 2. AEM Assets View Integration & UX
- **Assets View Metadata Forms (`dam:metadataForm`)**:
  - Walks the ancestor folder hierarchy from the target DAM folder to `/content/dam` prioritizing `dam:metadataForm` (`/content/dam/appdata/metadataforms/<form>`).
  - Enforces existing AEM taxonomy tags (`candidatePool`) in the Tag Picker without allowing ad-hoc free-text tag creation, and writes `cq:tags` with `jcr:mixinTypes=cq:Taggable` and `cq:tags@TypeHint=String[]` so tags immediately resolve under `xcm:keywords` in AEM Assets View.
- **Native AEM AI-Generated Titles (`dc:title`)**:
  - Leaves `dc:title` optional and blank by default so AEM's built-in AI-Generated Metadata service automatically generates and assigns a descriptive title (`autogen:title`) during asset processing, while still supporting optional manual overrides.
- **Adobe Spectrum Design & Automatic Folder Refresh**:
  - Built with `@adobe/react-spectrum` and `@spectrum-icons/workflow` to match AEM Assets View in both Light and Dark themes.
  - Automatically closes the modal on upload completion and refreshes the AEM Assets View folder contents after a 550ms indexing delay.

### 3. Performance & Robustness
- **Multi-Part Upload Chunk Sizing & Cancellation (M1, M2)**:
  - `computeUploadPartPlan()` honors `minPartSize` and `maxPartSize` from `initiateUpload.json`, and `AbortController` cancels in-flight binary `PUT` requests if the modal is closed.
- **Timeouts, Caching & Bounded Concurrency (M3, M4, P1–P4)**:
  - All backend AEM requests use a 15-second `AbortSignal.timeout(15000)`.
  - Warm Runtime containers cache resolved folder schemas (2-minute TTL) and `/content/cq:tags.3.json` taxonomy trees (5-minute TTL).
  - Multi-file `initiate` and `complete` operations execute with bounded concurrency (`mapWithConcurrency`, up to 4 in parallel).
