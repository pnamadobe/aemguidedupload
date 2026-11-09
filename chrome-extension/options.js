(() => {
  const DEFAULTS = {
    enabled: true,
    handoffOnDrop: true
  };

  const enabledEl = document.getElementById('enabled');
  const handoffEl = document.getElementById('handoffOnDrop');
  const statusEl = document.getElementById('status');

  chrome.storage.sync.get(DEFAULTS, (stored) => {
    enabledEl.checked = Boolean(stored.enabled);
    handoffEl.checked = Boolean(stored.handoffOnDrop);
  });

  function save () {
    chrome.storage.sync.set(
      {
        enabled: enabledEl.checked,
        handoffOnDrop: handoffEl.checked
      },
      () => {
        statusEl.textContent = '✓ Settings saved';
        setTimeout(() => { statusEl.textContent = ''; }, 1500);
      }
    );
  }

  enabledEl.addEventListener('change', save);
  handoffEl.addEventListener('change', save);
})();
