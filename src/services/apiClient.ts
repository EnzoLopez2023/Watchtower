/**
 * The central Watchtower API client.
 *
 * Every network call in the app goes through here so that exactly one place
 * knows how to acquire a Watchtower API access token and attach it as a bearer
 * header. The feature pages keep their original endpoint contracts — the same
 * paths, the same query strings, the same response shapes — because `apiFetch`
 * is a drop-in for `fetch`.
 *
 * Two rules this module exists to enforce:
 *
 *   1. No request ever leaves without an `Authorization: Bearer` header. When a
 *      token cannot be acquired the call resolves to a synthetic 401 response
 *      rather than going out unauthenticated, so the calling page renders its
 *      own error state instead of a confusing empty one.
 *   2. Nothing is ever faked. There is no mock data, no "assume it worked" path
 *      and no swallowed failure: an API error is always visible to the caller.
 */

import { InteractionRequiredAuthError, type AccountInfo } from '@azure/msal-browser';
import { apiTokenRequest, isEntraConfigured, msalInstance } from '../auth/msalConfig';

export interface ApiErrorBody {
  readonly error?: string | {
    readonly code?: string;
    readonly message?: string;
  };
  readonly message?: string;
  readonly code?: string;
}

/** Thrown by the typed helpers. Carries enough to render a real error state. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly url: string;

  constructor(status: number, code: string, message: string, url: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.url = url;
  }
}

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

function synthetic(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: code, message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── Token acquisition ────────────────────────────────────────────────────────

let redirectInFlight = false;

function activeAccount(): AccountInfo | null {
  const active = msalInstance.getActiveAccount();
  if (active) return active;
  const [first] = msalInstance.getAllAccounts();
  if (first) {
    msalInstance.setActiveAccount(first);
    return first;
  }
  return null;
}

export interface TokenResult {
  readonly token: string | null;
  readonly reason?: 'not_configured' | 'no_account' | 'interaction_required' | 'failed';
  readonly detail?: string;
}

/**
 * A Watchtower API access token for the signed-in account.
 *
 * Silent first. An `interaction_required` failure hands control to a redirect —
 * once, guarded, because several pages fetch in parallel on mount and a burst of
 * redirects would fight each other.
 */
export async function acquireApiToken(): Promise<TokenResult> {
  if (!isEntraConfigured()) {
    return { token: null, reason: 'not_configured', detail: 'Entra environment is incomplete.' };
  }

  const account = activeAccount();
  if (!account) return { token: null, reason: 'no_account', detail: 'No signed-in account.' };

  try {
    const result = await msalInstance.acquireTokenSilent({ ...apiTokenRequest, account });
    return { token: result.accessToken };
  } catch (error) {
    if (error instanceof InteractionRequiredAuthError) {
      if (!redirectInFlight) {
        redirectInFlight = true;
        void msalInstance.acquireTokenRedirect({ ...apiTokenRequest, account }).catch(() => {
          redirectInFlight = false;
        });
      }
      return {
        token: null,
        reason: 'interaction_required',
        detail: 'Sign-in is required to refresh the Watchtower API token.',
      };
    }
    return {
      token: null,
      reason: 'failed',
      detail: error instanceof Error ? error.message : 'Token acquisition failed.',
    };
  }
}

// ── The fetch seam ───────────────────────────────────────────────────────────

const TOKEN_FAILURE_MESSAGE: Record<NonNullable<TokenResult['reason']>, string> = {
  not_configured:
    'Watchtower is not configured for sign-in. Set VITE_ENTRA_TENANT_ID, VITE_ENTRA_CLIENT_ID and VITE_ENTRA_API_SCOPE.',
  no_account: 'You are signed out. Sign in again to load this data.',
  interaction_required: 'Your session expired. Completing sign-in…',
  failed: 'Could not acquire a Watchtower API token.',
};

/**
 * `fetch`, with a Watchtower bearer token attached.
 *
 * Same signature and same return type as the global, so a page keeps its own
 * `response.ok` / `response.json()` handling and its own abort signals.
 */
export async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const { token, reason } = await acquireApiToken();

  if (!token) {
    const why = reason ?? 'failed';
    return synthetic(401, why, TOKEN_FAILURE_MESSAGE[why]);
  }

  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  try {
    return await fetch(input, { ...init, headers });
  } catch (error) {
    // An aborted request is the caller's own doing — let it reject so the
    // existing `AbortError` handling in the pages still works.
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    return synthetic(
      503,
      'network_unreachable',
      `Could not reach ${url}: ${error instanceof Error ? error.message : 'network error'}`,
    );
  }
}

// ── Typed helpers ────────────────────────────────────────────────────────────

async function failureFor(response: Response, url: string): Promise<ApiError> {
  let code = `http_${response.status}`;
  let message = `${response.status} ${response.statusText || 'Request failed'}`;
  try {
    const body = (await response.json()) as ApiErrorBody;
    if (typeof body.error === 'string') {
      code = body.error;
      if (!body.message) message = body.error;
    } else if (body.error) {
      if (body.error.code) code = body.error.code;
      if (body.error.message) message = body.error.message;
    }
    if (body.code) code = body.code;
    if (body.message) message = body.message;
  } catch {
    /* non-JSON error body — keep the status line */
  }
  return new ApiError(response.status, code, message, url);
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(url, init);
  if (!response.ok) throw await failureFor(response, url);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const apiGet = <T>(url: string, init?: RequestInit): Promise<T> =>
  request<T>(url, { ...init, method: 'GET' });

export const apiPost = <T>(url: string, body?: unknown, init?: RequestInit): Promise<T> =>
  request<T>(url, {
    ...init,
    method: 'POST',
    headers: { ...JSON_HEADERS, ...init?.headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

export const apiPut = <T>(url: string, body?: unknown, init?: RequestInit): Promise<T> =>
  request<T>(url, {
    ...init,
    method: 'PUT',
    headers: { ...JSON_HEADERS, ...init?.headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

export const apiDelete = <T>(url: string, init?: RequestInit): Promise<T> =>
  request<T>(url, { ...init, method: 'DELETE' });

/** The message to show a user for any thrown value, without inventing detail. */
export const errorMessage = (error: unknown, fallback = 'Request failed'): string => {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return fallback;
};
