import {
  apiClient,
  clearTokens,
  getRefreshToken,
  setAccessToken,
  setRefreshToken
} from './client.js';
import { AuthResponse, User } from './types.js';

export async function loginApi(credentials: {
  email: string;
  password: string;
}): Promise<AuthResponse> {
  const data = await apiClient<AuthResponse>('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
    requiresAuth: false
  });
  setAccessToken(data.accessToken);
  setRefreshToken(data.refreshToken);
  return data;
}

export async function registerApi(payload: {
  email: string;
  password: string;
  displayName: string;
}): Promise<AuthResponse> {
  const data = await apiClient<AuthResponse>('/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    requiresAuth: false
  });
  setAccessToken(data.accessToken);
  setRefreshToken(data.refreshToken);
  return data;
}

export async function refreshApi(): Promise<AuthResponse> {
  const token = getRefreshToken();
  if (!token) {
    throw new Error('No refresh token');
  }
  const data = await apiClient<AuthResponse>('/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: token }),
    requiresAuth: false,
    skipRefreshOn401: true
  });
  setAccessToken(data.accessToken);
  if (data.refreshToken) {
    setRefreshToken(data.refreshToken);
  }
  return data;
}

export async function logoutApi(): Promise<void> {
  const token = getRefreshToken();
  try {
    if (token) {
      await apiClient<void>('/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: token }),
        requiresAuth: true
      });
    }
  } finally {
    clearTokens();
  }
}

export async function getMeApi(): Promise<User> {
  return apiClient<User>('/auth/me', {
    method: 'GET',
    requiresAuth: true
  });
}

export interface ListUsersParams {
  role?: string;
  active?: boolean;
  q?: string;
  page?: number;
  pageSize?: number;
}

export interface ListUsersResponse {
  items: User[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

export async function listUsersApi(params: ListUsersParams = {}): Promise<ListUsersResponse> {
  const searchParams = new URLSearchParams();
  if (params.role) searchParams.set('role', params.role);
  if (params.active !== undefined) searchParams.set('active', String(params.active));
  if (params.q) searchParams.set('q', params.q);
  if (params.page) searchParams.set('page', String(params.page));
  if (params.pageSize) searchParams.set('pageSize', String(params.pageSize));

  const qs = searchParams.toString();
  const endpoint = qs ? `/auth/users?${qs}` : '/auth/users';

  return apiClient<ListUsersResponse>(endpoint, {
    method: 'GET',
    requiresAuth: true
  });
}

export async function createUserApi(payload: {
  email: string;
  password: string;
  displayName: string;
  role: string;
}): Promise<User> {
  return apiClient<User>('/auth/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    requiresAuth: true
  });
}

export async function patchUserApi(
  id: string,
  payload: {
    isActive?: boolean;
    role?: string;
    displayName?: string;
  }
): Promise<User> {
  return apiClient<User>(`/auth/users/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    requiresAuth: true
  });
}
