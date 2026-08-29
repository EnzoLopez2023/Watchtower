import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { msalInstance } from './auth/msalConfig';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('Watchtower could not find its #root element.');

const root = createRoot(container);

/**
 * MSAL must be initialised, and any redirect response consumed, before React
 * renders. Rendering first means the first `acquireTokenSilent` runs against an
 * instance that has not finished processing the hash, which is how an app ends
 * up bouncing between the login page and itself.
 */
msalInstance
  .initialize()
  .then(async () => {
    const result = await msalInstance.handleRedirectPromise();
    const account = result?.account ?? msalInstance.getAllAccounts()[0];
    if (account) msalInstance.setActiveAccount(account);
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  })
  .catch((error: unknown) => {
    // A failed initialisation is shown, never hidden behind an empty page.
    container.innerHTML = '';
    const message = document.createElement('div');
    message.setAttribute('role', 'alert');
    message.className = 'watchtower-boot-error';
    message.textContent = `Watchtower could not start: ${
      error instanceof Error ? error.message : 'authentication failed to initialise.'
    }`;
    container.appendChild(message);
  });
