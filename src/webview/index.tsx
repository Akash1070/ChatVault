/**
 * src/webview/index.tsx
 *
 * Webview entry point — mounts the React app into the DOM.
 * This file is the webpack entry point for the webview bundle.
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('[ChatVault Webview] Root element #root not found in DOM');
}

const root = createRoot(rootEl);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
