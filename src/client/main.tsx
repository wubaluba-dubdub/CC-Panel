import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/globals.css';
import { App } from './App.js';
import { LocaleProvider } from './i18n/index.js';

/**
 * The entry point. One root, mounted once.
 *
 * `#root` is in `index.html` and cannot be missing without the build being broken, so this
 * throws rather than silently doing nothing — a blank page with a clean console is the
 * hardest failure in this milestone to diagnose, and this is one of the two places that
 * can turn it into a message.
 */
const container = document.getElementById('root');
if (container === null) {
  throw new Error('panel: #root is missing from the shell HTML — the build is broken');
}

createRoot(container).render(
  <StrictMode>
    <LocaleProvider>
      <App />
    </LocaleProvider>
  </StrictMode>,
);
