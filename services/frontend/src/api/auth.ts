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
