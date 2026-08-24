import React from 'react';
import ReactDOM from 'react-dom/client';

import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { setupMonaco } from './lib/monaco';
import { useSettingsStore } from './store/settingsStore';
import './styles/globals.css';

/**
 * Register the locally bundled Monaco before anything renders, so the editor
 * never reaches for the jsdelivr CDN. Failing here must not stop the app: the
 * file browser and transfers work perfectly well without an editor.
 */
try {
  setupMonaco();
} catch (error) {
  console.error('Monaco could not be initialised; the editor will be unavailable.', error);
}

const container = document.getElementById('root');
if (!container) {
  throw new Error('#root is missing from index.html');
}

/**
 * The boundary sits outside every provider, so a throw inside `I18nProvider`,
 * the query client or the layout still renders a recoverable screen instead of
 * a white page. It is given the persisted locale directly, since it cannot use
 * a hook that may itself be the thing that failed.
 */
ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <ErrorBoundary locale={useSettingsStore.getState().locale}>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
