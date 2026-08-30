import { LogLevel, PublicClientApplication, type Configuration } from '@azure/msal-browser';

/**
 * Entra configuration, supplied by the same runtime settings as the API.
 *
 * `/runtime-config.js` runs before this module and publishes the public tenant,
 * client and delegated scope. Keeping them out of the Vite build means changing
 * an App Service setting cannot leave the browser and API on different identity
 * contracts. When any value is missing the app renders a visible configuration
 * error rather than silently signing everyone out.
 */
const runtimeEntra = window.__WATCHTOWER_RUNTIME_CONFIG__?.entra;

export const ENTRA_TENANT_ID = runtimeEntra?.tenantId ?? '';
export const ENTRA_CLIENT_ID = runtimeEntra?.clientId ?? '';
export const ENTRA_API_SCOPE = runtimeEntra?.apiScope ?? '';

export interface EntraConfigProblem {
  readonly variable: string;
  readonly detail: string;
}

/** Empty when the app is configured. Each entry is a missing/invalid variable. */
export function entraConfigProblems(): EntraConfigProblem[] {
  const problems: EntraConfigProblem[] = [];
  if (!ENTRA_TENANT_ID) {
    problems.push({ variable: 'AZURE_AD_TENANT_ID', detail: 'Entra tenant id is not available.' });
  }
  if (!ENTRA_CLIENT_ID) {
    problems.push({ variable: 'AZURE_AD_CLIENT_ID', detail: 'Entra application id is not available.' });
  }
  if (!ENTRA_API_SCOPE) {
    problems.push({
      variable: 'runtime-config.js',
      detail: 'Watchtower API scope is not available, so no access token can be requested.',
    });
  }
  return problems;
}

export const isEntraConfigured = (): boolean => entraConfigProblems().length === 0;

/**
 * A syntactically valid stand-in so the MSAL instance can still be constructed
 * on a deployment that is missing its environment.
 *
 * MSAL rejects an empty client id and an authority with no tenant, which would
 * throw at module scope and leave a blank page — the one failure mode this app
 * must never have. With the placeholder, construction succeeds, `RequireAuth`
 * detects the missing variables first, and the user sees exactly which ones.
 */
const PLACEHOLDER_ID = '00000000-0000-0000-0000-000000000000';

export const msalConfig: Configuration = {
  auth: {
    clientId: ENTRA_CLIENT_ID || PLACEHOLDER_ID,
    authority: `https://login.microsoftonline.com/${ENTRA_TENANT_ID || PLACEHOLDER_ID}`,
    redirectUri: window.location.origin,
    postLogoutRedirectUri: window.location.origin,
    navigateToLoginRequestUrl: true,
  },
  cache: {
    cacheLocation: 'localStorage',
    storeAuthStateInCookie: true,
  },
  system: {
    loggerOptions: {
      loggerCallback(level, message, containsPii) {
        if (containsPii) return;
        console.debug(`[MSAL:${LogLevel[level]}] ${message}`);
      },
      logLevel: LogLevel.Warning,
    },
  },
};

/** Sign-in request. Only the identity scopes — the API token is acquired separately. */
export const loginRequest = {
  scopes: ['openid', 'profile'],
};

/**
 * The scopes for a Watchtower API access token.
 *
 * Every call through `services/apiClient` asks for this, and the server
 * validates the resulting bearer token before it consults app-local roles.
 */
export const apiTokenRequest = {
  scopes: ENTRA_API_SCOPE ? [ENTRA_API_SCOPE] : [],
};

/**
 * The one MSAL instance.
 *
 * A module singleton rather than a component-owned instance so the typed API
 * client can acquire tokens outside React — the feature pages call plain
 * functions, not hooks, when they fetch.
 */
export const msalInstance = new PublicClientApplication(msalConfig);
