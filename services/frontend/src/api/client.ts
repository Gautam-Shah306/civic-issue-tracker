import { ProblemDetails } from './types.js';

export class ApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly correlationId: string;
  public readonly detail?: string;
  public readonly errors?: Array<{ field: string; message: string }>;

  constructor(problem: ProblemDetails) {
    super(problem.detail || problem.title || `API error: ${problem.status}`);
    this.name = 'ApiError';
    this.status = problem.status;
    this.code = problem.code;
    this.correlationId = problem.correlationId;
    this.detail = problem.detail;
    this.errors = problem.errors;
  }
}

// In-memory access token
let accessToken: string | null = null;
const REFRESH_TOKEN_KEY = 'civic_refresh_token';

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getRefreshToken(): string | null {
  try {
    return sessionStorage.getItem(REFRESH_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setRefreshToken(token: string | null): void {
  try {
    if (token) {
      sessionStorage.setItem(REFRESH_TOKEN_KEY, token);
    } else {
      sessionStorage.removeItem(REFRESH_TOKEN_KEY);
    }
  } catch {
    // SessionStorage may be restricted
  }
}

export function clearTokens(): void {
  accessToken = null;
  setRefreshToken(null);
}

// Single-flight refresh state
let refreshPromise: Promise<string> | null = null;

async function performSingleFlightRefresh(): Promise<string> {
  if (refreshPromise) {
    return refreshPromise;
  }

  const token = getRefreshToken();
  if (!token) {
    clearTokens();
    return Promise.reject(new Error('No refresh token available'));
  }

  refreshPromise = (async () => {
    try {
      const correlationId = crypto.randomUUID();
      const res = await fetch('/api/v1/auth/refresh', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-correlation-id': correlationId
        },
        body: JSON.stringify({ refreshToken: token })
      });

      if (!res.ok) {
        throw new Error('Refresh failed');
      }

      const data = await res.json();
      setAccessToken(data.accessToken);
      if (data.refreshToken) {
        setRefreshToken(data.refreshToken);
      }
      return data.accessToken;
    } catch (err) {
      clearTokens();
      // Redirect to login if in browser
      if (typeof window !== 'undefined' && window.location) {
        const returnPath = window.location.pathname + window.location.search;
        if (!window.location.pathname.startsWith('/login')) {
          window.location.assign(`/login?returnTo=${encodeURIComponent(returnPath)}`);
        }
      }
      throw err;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

export interface RequestOptions extends RequestInit {
  requiresAuth?: boolean;
  correlationId?: string;
  skipRefreshOn401?: boolean;
}

export async function apiClient<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
  const {
    requiresAuth = true,
    correlationId = crypto.randomUUID(),
    skipRefreshOn401 = false,
    headers = {},
    ...restOptions
  } = options;

  const reqHeaders: Record<string, string> = {
    'x-correlation-id': correlationId,
    ...(headers as Record<string, string>)
  };

  if (requiresAuth && accessToken) {
    reqHeaders['Authorization'] = `Bearer ${accessToken}`;
  }

  const url = endpoint.startsWith('/api') ? endpoint : `/api/v1${endpoint}`;
  let response = await fetch(url, {
    ...restOptions,
    headers: reqHeaders
  });

  // Handle single-flight refresh on 401 if request carried a token
  if (response.status === 401 && requiresAuth && accessToken && !skipRefreshOn401) {
    try {
      const newAccessToken = await performSingleFlightRefresh();
      reqHeaders['Authorization'] = `Bearer ${newAccessToken}`;
      reqHeaders['x-correlation-id'] = crypto.randomUUID();

      response = await fetch(url, {
        ...restOptions,
        headers: reqHeaders
      });
    } catch {
      // Refresh failed, proceed with original 401 parsing
    }
  }

  if (!response.ok) {
    const contentType = response.headers.get('content-type') || '';
    if (
      contentType.includes('application/problem+json') ||
      contentType.includes('application/json')
    ) {
      try {
        const problem: ProblemDetails = await response.json();
        throw new ApiError({
          type: problem.type || 'about:blank',
          title: problem.title || response.statusText,
          status: problem.status || response.status,
          code: problem.code || 'unknown_error',
          correlationId: problem.correlationId || correlationId,
          detail: problem.detail,
          errors: problem.errors
        });
      } catch (e) {
        if (e instanceof ApiError) throw e;
      }
    }

    throw new ApiError({
      type: 'about:blank',
      title: response.statusText,
      status: response.status,
      code: `http_${response.status}`,
      correlationId
    });
  }

  // 204 No Content or empty body
  if (response.status === 204) {
    return undefined as unknown as T;
  }

  const text = await response.text();
  if (!text || text.trim().length === 0) {
    return undefined as unknown as T;
  }

  return JSON.parse(text);
}

export async function uploadMultipart<T>(
  endpoint: string,
  formData: FormData,
  options: RequestOptions = {}
): Promise<T> {
  const { headers = {}, ...rest } = options;
  // Do NOT set Content-Type header so fetch sets boundary automatically
  const customHeaders = { ...(headers as Record<string, string>) };
  delete customHeaders['Content-Type'];

  return apiClient<T>(endpoint, {
    ...rest,
    method: 'POST',
    body: formData,
    headers: customHeaders
  });
}
