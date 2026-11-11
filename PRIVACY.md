# Privacy Policy — AEM Guided Upload (Drag-and-Drop Guardrail)

**Last Updated:** November 11, 2026

## Overview
**AEM Guided Upload — Drag-and-Drop Guardrail** is a browser extension designed for Adobe Experience Manager (AEM) as a Cloud Service Assets View (`experience.adobe.com`, `experience-stage.adobe.com`, and `*.adobeaemcloud.com`). Its sole purpose is to intercept raw drag-and-drop file and folder uploads on the AEM Assets View browse grid and route them into the customer's Adobe App Builder Guided Upload modal so folder metadata schemas, usage rights, and file naming rules are enforced.

## Data Collection & Usage
- **No Personal Data Collected:** This extension does **not** collect, transmit, store, sell, or share any personally identifiable information (PII), authentication tokens, browsing history, analytics, or telemetry.
- **Local User Preferences (`chrome.storage.sync`):** The extension stores only two boolean toggle settings (`enabled` and `handoffOnDrop`) locally in the user's browser via `chrome.storage.sync`.
- **In-Memory File Handoff Only:** When a user drags and drops files or folders onto the AEM Assets View browse grid, the extension passes the dropped `File` objects in memory via `window.postMessage` directly to the verified Adobe App Builder Guided Upload modal iframe within the same browser tab. No files or metadata are ever sent to any third-party or external server by this extension.

## Permissions Justification
- **`storage`:** Used exclusively to save the user's two extension toggle preferences (`enabled` and `handoffOnDrop`).
- **Host Permissions (`experience.adobe.com`, `experience-stage.adobe.com`, `*.adobeaemcloud.com`):** Required so the content script can intercept ungoverned drag-and-drop events on AEM Assets View pages and hand dropped files to the Guided Upload modal.

## Contact
For questions or support regarding this extension, please open an issue at:
https://github.com/pnamadobe/aemguidedupload/issues
