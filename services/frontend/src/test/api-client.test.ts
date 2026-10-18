import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  apiClient,
  uploadMultipart,
  setAccessToken,
  setRefreshToken,
  getAccessToken,
  getRefreshToken,
  clearTokens,
  ApiError
} from '../api/client.js';

describe('API Client (D1)', () => {
  beforeEach(() => {
    clearTokens();
    vi.restoreAllMocks();
  });

  it('attaches fresh x-correlation-id header on every request', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    );

    await apiClient<{ ok: boolean }>('/test', { requiresAuth: false });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const headers = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers).toHaveProperty('x-correlation-id');
    expect(headers['x-correlation-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
  });

  it('parses application/problem+json into typed ApiError including field errors', async () => {
    const problemPayload = {
      type: 'https://civic-issue-tracker.local/errors/validation',
      title: 'Validation Error',
      status: 400,
      code: 'validation_error',
      correlationId: '12345678-1234-1234-1234-123456789abc',
      detail: 'Request body failed validation',
      errors: [
        { field: 'email', message: 'Invalid email address' },
        { field: 'password', message: 'Password too short' }
      ]
    };

    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(problemPayload), {
        status: 400,
        headers: { 'Content-Type': 'application/problem+json' }
      })
    );

    try {
      await apiClient('/test', { requiresAuth: false });
      expect.fail('Should have thrown ApiError');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(400);
      expect(apiErr.code).toBe('validation_error');
      expect(apiErr.detail).toBe('Request body failed validation');
      expect(apiErr.correlationId).toBe('12345678-1234-1234-1234-123456789abc');
      expect(apiErr.errors).toHaveLength(2);
      expect(apiErr.errors?.[0]).toEqual({ field: 'email', message: 'Invalid email address' });
    }
  });

  it('executes single-flight refresh on 401 with exactly one retry when two parallel calls 401', async () => {
    setAccessToken('old-expired-token');
    setRefreshToken('valid-refresh-token');

    let refreshCalls = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const headers = (init?.headers || {}) as Record<string, string>;

      if (url.includes('/auth/refresh')) {
        refreshCalls++;
        return new Response(
          JSON.stringify({ accessToken: 'new-valid-token', refreshToken: 'new-refresh-token' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Initial requests with old token fail with 401
      if (headers['Authorization'] === 'Bearer old-expired-token') {
        return new Response(JSON.stringify({ code: 'unauthorized', title: 'Expired' }), {
          status: 401,
          headers: { 'Content-Type': 'application/problem+json' }
        });
      }

      // Retried requests with new token succeed
      if (headers['Authorization'] === 'Bearer new-valid-token') {
        return new Response(JSON.stringify({ data: 'success' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      return new Response(null, { status: 500 });
    });

    // Fire two parallel requests that both 401
    const [res1, res2] = await Promise.all([
      apiClient<{ data: string }>('/reports/mine'),
      apiClient<{ data: string }>('/reports/mine')
    ]);

    expect(res1).toEqual({ data: 'success' });
    expect(res2).toEqual({ data: 'success' });
    expect(refreshCalls).toBe(1); // Exactly ONE single-flight refresh occurred!
    expect(getAccessToken()).toBe('new-valid-token');
    expect(getRefreshToken()).toBe('new-refresh-token');
  });

  it('refresh failure clears tokens and redirects to /login with return path', async () => {
    setAccessToken('stale-token');
    setRefreshToken('bad-refresh-token');

    const assignMock = vi.fn();
    delete (window as any).location;
    window.location = {
      pathname: '/my/reports',
      search: '?sort=asc',
      assign: assignMock
    } as any;

    vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) {
        return new Response(JSON.stringify({ code: 'invalid_token' }), {
          status: 401,
          headers: { 'Content-Type': 'application/problem+json' }
        });
      }
      return new Response(JSON.stringify({ code: 'unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/problem+json' }
      });
    });

    try {
      await apiClient('/reports/mine');
    } catch {
      // Expected to throw
    }

    expect(getAccessToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
    expect(assignMock).toHaveBeenCalledWith('/login?returnTo=%2Fmy%2Freports%3Fsort%3Dasc');
  });

  it('never puts tokens in URLs or query strings', async () => {
    setAccessToken('secret-token-xyz');
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    );

    await apiClient('/public/reports?page=1');

    const calledUrl = String(fetchSpy.mock.calls[0][0]);
    expect(calledUrl).not.toContain('secret-token-xyz');
    expect(calledUrl).not.toContain('token');
  });

  it('multipart helper sends FormData without manual Content-Type header override', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ imageId: 'img-1', status: 'pending' }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' }
      })
    );

    const formData = new FormData();
    formData.append('file', new Blob(['test'], { type: 'image/jpeg' }), 'photo.jpg');

    await uploadMultipart('/images', formData, { requiresAuth: false });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const options = fetchSpy.mock.calls[0][1];
    expect(options?.body).toBe(formData);
    const headers = options?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBeUndefined();
  });
});
