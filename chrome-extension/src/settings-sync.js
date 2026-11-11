// Isolated-world bridge to sync chrome.storage.sync settings into the MAIN world guard.
(() => {
  'use strict';
  if (globalThis.__guSettingsSync) return;
  globalThis.__guSettingsSync = true;

  const DEFAULTS = {
    enabled: true,
    handoffOnDrop: true
  };

  function pushSettings (settings) {
    try {
      const origin = window.location && window.location.origin;
      const targetOrigin = (typeof origin === 'string' && /^https?:\/\//i.test(origin)) ? origin : '*';
      window.postMessage({ __GU_SETTINGS__: settings }, targetOrigin);
    } catch (e) {
      // ignore postMessage errors on about:blank or sandboxed frames
    }
  }

  try {
    chrome.storage?.sync.get(DEFAULTS, (stored) => {
      pushSettings({ ...DEFAULTS, ...stored });
    });
    chrome.storage?.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      chrome.storage?.sync.get(DEFAULTS, (stored) => {
        pushSettings({ ...DEFAULTS, ...stored });
      });
    });
  } catch (e) {
    pushSettings(DEFAULTS);
  }
})();
