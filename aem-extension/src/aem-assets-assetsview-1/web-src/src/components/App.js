import React from 'react';
import ErrorBoundary from 'react-error-boundary';
import { HashRouter as Router, Routes, Route } from 'react-router-dom';
import ExtensionRegistration from './ExtensionRegistration';
import ModalGuidedUpload from './ModalGuidedUpload';

function App () {
  return (
    <Router>
      <ErrorBoundary onError={onError} FallbackComponent={fallbackComponent}>
        <Routes>
          <Route index element={<ExtensionRegistration />} />
          <Route exact path="index.html" element={<ExtensionRegistration />} />
          <Route path="modal-guided-upload" element={<ModalGuidedUpload />} />
        </Routes>
      </ErrorBoundary>
    </Router>
  );

  function onError (e, componentStack) {
    console.error('[Guided Upload] Render error:', e, componentStack);
  }

  function fallbackComponent ({ componentStack, error }) {
    return (
      <React.Fragment>
        <h2 style={{ textAlign: 'center', marginTop: '20px' }}>
          Guided Upload Extension Error
        </h2>
        <pre style={{ padding: '16px', whiteSpace: 'pre-wrap' }}>
          {(error && error.message) + '\n' + componentStack}
        </pre>
      </React.Fragment>
    );
  }
}

export default App;
