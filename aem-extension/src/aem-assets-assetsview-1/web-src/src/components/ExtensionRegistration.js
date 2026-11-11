import React, { useEffect } from 'react';
import { Text } from '@adobe/react-spectrum';
import { register } from '@adobe/uix-guest';
import { extensionId, HANDOFF_MESSAGE_NS, STORAGE_KEY_CTX, isTrustedMessageOrigin } from './Constants';

function findAemAuthorUrl (...sources) {
  const seen = new Set();
  const visit = (value, depth = 0) => {
    if (depth > 5 || value == null) return '';
    if (typeof value === 'string') {
      const match = value.match(/https:\/\/author-[a-z0-9-]+\.adobeaemcloud\.com/i);
      return match ? match[0].replace(/\/+$/, '') : '';
    }
    if (typeof value !== 'object' || seen.has(value)) return '';
    seen.add(value);
    for (const item of Array.isArray(value) ? value : Object.values(value)) {
      const result = visit(item, depth + 1);
      if (result) return result;
    }
    return '';
  };
  return sources.map(visit).find(Boolean) || '';
}

function normalizeDamFolderPath (resource) {
  const raw = (resource && (
    resource.path ||
    resource.repositoryPath ||
    resource['repo:path'] ||
    (resource.repositoryMetadata && (resource.repositoryMetadata['repo:path'] || resource.repositoryMetadata.path))
  )) || '/content/dam';
  let path = String(raw).trim();
  const idx = path.indexOf('/content/dam');
  if (idx > 0) path = path.slice(idx);
  if (!path.startsWith('/content/dam')) path = '/content/dam';
  return path.replace(/\/+$/, '') || '/content/dam';
}

function ExtensionRegistration () {
  useEffect(() => {
    let activeGuestConnection = null;

    const openGuidedUploadModal = async ({ context, resource, folderOverride, source = 'addAssets' }) => {
      if (!activeGuestConnection) return;
      const folderPath = folderOverride || normalizeDamFolderPath(resource);
      let aemAuthorUrl = findAemAuthorUrl(context, resource);
      if (!aemAuthorUrl && activeGuestConnection.host?.discovery?.getAemHost) {
        try {
          const discovered = await Promise.race([
            activeGuestConnection.host.discovery.getAemHost(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 500))
          ]);
          if (discovered) {
            aemAuthorUrl = String(discovered).startsWith('http') ? discovered : `https://${discovered}`;
          }
        } catch (e) {
          // ignore discovery error
        }
      }

      const ctxPayload = {
        folderPath,
        aemAuthorUrl: (aemAuthorUrl || '').replace(/\/+$/, ''),
        context: context || 'assets',
        source,
        openedAt: Date.now()
      };

      try {
        localStorage.setItem(STORAGE_KEY_CTX, JSON.stringify({
          folderPath: ctxPayload.folderPath,
          context: ctxPayload.context,
          source: ctxPayload.source,
          openedAt: ctxPayload.openedAt
        }));
      } catch (e) {
        // ignore storage quota errors
      }

      const qs = new URLSearchParams({
        folder: ctxPayload.folderPath,
        source: ctxPayload.source
      }).toString();

      activeGuestConnection.host.modal.openDialog({
        title: 'Add Assets',
        contentUrl: `/index.html?cb=${Date.now()}#modal-guided-upload?${qs}`,
        type: 'modal',
        size: 'L',
        payload: ctxPayload
      });
    };

    const onWindowMessage = (event) => {
      if (!event || !isTrustedMessageOrigin(event.origin)) return;
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      if (data[HANDOFF_MESSAGE_NS] === 'OPEN_MODAL_FROM_DROP') {
        openGuidedUploadModal({
          context: 'assets',
          folderOverride: data.folderPath || '/content/dam',
          source: 'chrome-dnd-guard'
        }).catch(console.error);
        return;
      }
      if (data[HANDOFF_MESSAGE_NS] === 'REFRESH_FOLDER_VIEW') {
        const relay = () => {
          try {
            if (window.parent && window.parent !== window) window.parent.postMessage(data, '*');
            if (window.top && window.top !== window && window.top !== window.parent) window.top.postMessage(data, '*');
          } catch (e) { /* ignore */ }
        };
        setTimeout(relay, 120);
        setTimeout(relay, 420);
      }
    };

    window.addEventListener('message', onWindowMessage);

    const init = async () => {
      const guestConnection = await register({
        id: extensionId,
        methods: {
          actionBar: {
            async getActions () {
              return [];
            },
            async getHiddenBuiltInActions () {
              return [];
            },
            async overrideBuiltInAction () {
              return false;
            }
          },
          quickActions: {
            async getHiddenBuiltInActions () {
              return [];
            },
            async overrideBuiltInAction () {
              return false;
            }
          },
          detailSidePanel: {
            getPanels () {
              return [];
            },
            async getHiddenBuiltInPanels () {
              return [];
            },
            async overrideBuiltInPanel () {
              return null;
            }
          },
          headerMenu: {
            async getButtons () {
              return [];
            },
            async getHiddenButtonIds () {
              return [];
            },
            async overrideButton ({ buttonId, context, resource }) {
              if (buttonId === 'addAssets') {
                await openGuidedUploadModal({
                  context,
                  resource,
                  source: 'overrideButton:addAssets'
                });
                // Return true to skip the built-in ungoverned upload handler
                return true;
              }
              return false;
            }
          }
        }
      });

      activeGuestConnection = guestConnection;
    };

    init().catch(console.error);

    return () => {
      window.removeEventListener('message', onWindowMessage);
    };
  }, []);

  return <Text>Guided Upload Extension Host Bridge (AEM Assets View)</Text>;
}

export default ExtensionRegistration;
