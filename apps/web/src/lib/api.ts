import type {
  AuthResult, Instrument, Mt5Account, ServicesStatus,
} from './types';

const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:4000/api';

const ACCESS_KEY = 'tt.access';
const REFRESH_KEY = 'tt.refresh';

export const tokens = {
  access: () => localStorage.getItem(ACCESS_KEY),
  refresh: () => localStorage.getItem(REFRESH_KEY),
  set(access: string, refresh: string) {
    localStorage.setItem(ACCESS_KEY, access);
    localStorage.setItem(REFRESH_KEY, refresh);
  },
  clear() {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
  },
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Nest's ValidationPipe returns `message` as an array of field errors. */
function readMessage(body: unknown, fallback: string): string {
  if (typeof body === 'object' && body !== null) {
    const m = (body as { message?: unknown }).message;
    if (Array.isArray(m)) return m.join(' ');
    if (typeof m === 'string') return m;
  }
  return fallback;
}

let refreshing: Promise<boolean> | null = null;

/** One refresh at a time — otherwise parallel 401s each burn a rotation and
 *  all but the first get logged out. */
async function refreshAccess(): Promise<boolean> {
  if (refreshing) return refreshing;

  refreshing = (async () => {
    const refreshToken = tokens.refresh();
    if (!refreshToken) return false;

    const res = await fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });

    if (!res.ok) {
      tokens.clear();
      return false;
    }

    const data = (await res.json()) as AuthResult;
    tokens.set(data.accessToken, data.refreshToken);
    return true;
  })().finally(() => {
    refreshing = null;
  });

  return refreshing;
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  retry = true,
): Promise<T> {
  const access = tokens.access();

  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(access ? { Authorization: `Bearer ${access}` } : {}),
      ...init.headers,
    },
  }).catch(() => {
    throw new ApiError(
      'Cannot reach the API. Is api-gateway running on port 4000?',
      0,
    );
  });

  if (res.status === 401 && retry && tokens.refresh()) {
    if (await refreshAccess()) return request<T>(path, init, false);
  }

  if (res.status === 204) return undefined as T;

  const body = await res.json().catch(() => null);

  if (!res.ok) {
    throw new ApiError(readMessage(body, res.statusText), res.status);
  }

  return body as T;
}

export const api = {
  register: (payload: { email: string; displayName: string; password: string }) =>
    request<AuthResult>('/auth/register', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  login: (payload: { email: string; password: string }) =>
    request<AuthResult>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  logout: () => request<void>('/auth/logout', { method: 'POST' }),

  me: () => request<AuthResult['user']>('/auth/me'),

  listAccounts: () => request<Mt5Account[]>('/accounts'),

  createAccount: (payload: {
    label: string;
    login: string;
    server: string;
    password: string;
    mode: string;
    broker?: string;
  }) =>
    request<Mt5Account>('/accounts', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  connectAccount: (id: string) =>
    request<Mt5Account>(`/accounts/${id}/connect`, { method: 'POST' }),

  refreshAccount: (id: string) =>
    request<Mt5Account>(`/accounts/${id}/refresh`, { method: 'POST' }),

  deleteAccount: (id: string) =>
    request<void>(`/accounts/${id}`, { method: 'DELETE' }),

  instruments: (id: string, forexOnly = true) =>
    request<Instrument[]>(
      `/accounts/${id}/instruments?forexOnly=${forexOnly}`,
    ),

  services: () => request<ServicesStatus>('/status/services'),
};
