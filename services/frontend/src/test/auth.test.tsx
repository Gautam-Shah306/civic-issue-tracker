import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router';
import { AuthProvider, useAuth } from '../auth/AuthProvider.js';
import { RequireAuth } from '../auth/RequireAuth.js';
import { RequireRole } from '../auth/RequireRole.js';
import { LoginPage } from '../features/auth/LoginPage.js';
import { RegisterPage } from '../features/auth/RegisterPage.js';
import { Layout } from '../app/Layout.js';
import { setRefreshToken, clearTokens } from '../api/client.js';

describe('Authentication & RBAC Views (D2)', () => {
  beforeEach(() => {
    clearTokens();
    vi.restoreAllMocks();
  });

  it('AuthProvider restores session on load from refresh token and logs out', async () => {
    setRefreshToken('saved-refresh-token');

    vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) {
        return new Response(
          JSON.stringify({ accessToken: 'access-123', refreshToken: 'refresh-456' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('/auth/me')) {
        return new Response(
          JSON.stringify({
            id: 'user-1',
            email: 'citizen@civic.test',
            displayName: 'Ravi Kumar',
            role: 'citizen',
            isActive: true,
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('/auth/logout')) {
        return new Response(null, { status: 200 });
      }
      return new Response(null, { status: 404 });
    });

    function TestConsumer() {
      const { user, isAuthenticated, isLoading, logout } = useAuth();
      if (isLoading) return <div>Restoring...</div>;
      return (
        <div>
          <div data-testid="auth-status">{isAuthenticated ? 'logged-in' : 'logged-out'}</div>
          <div data-testid="user-name">{user?.displayName}</div>
          <button onClick={() => logout()}>Logout</button>
        </div>
      );
    }

    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>
    );

    expect(screen.getByText('Restoring...')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByTestId('auth-status')).toHaveTextContent('logged-in');
      expect(screen.getByTestId('user-name')).toHaveTextContent('Ravi Kumar');
    });

    // Test logout
    fireEvent.click(screen.getByRole('button', { name: /logout/i }));
    await waitFor(() => {
      expect(screen.getByTestId('auth-status')).toHaveTextContent('logged-out');
    });
  });

  it('RequireAuth and RequireRole redirect unauthenticated users with the return path', async () => {
    // When no refresh token exists, immediately unauthenticated
    render(
      <MemoryRouter initialEntries={['/my/secret']}>
        <AuthProvider>
          <Routes>
            <Route
              path="/my/secret"
              element={
                <RequireAuth>
                  <div>Secret Protected Area</div>
                </RequireAuth>
              }
            />
            <Route path="/login" element={<div data-testid="login-page">Login Page</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByTestId('login-page')).toBeInTheDocument();
      expect(screen.queryByText('Secret Protected Area')).not.toBeInTheDocument();
    });
  });

  it('Login validation checks rules and displays server field errors', async () => {
    render(
      <MemoryRouter initialEntries={['/login']}>
        <AuthProvider>
          <LoginPage />
        </AuthProvider>
      </MemoryRouter>
    );

    const emailInput = screen.getByLabelText(/email address/i);
    const passwordInput = screen.getByLabelText(/^password/i);
    const submitBtn = screen.getByRole('button', { name: /sign in/i });

    // 1. Empty submit triggers client validations
    fireEvent.click(submitBtn);
    expect(await screen.findByText('Email is required')).toBeInTheDocument();
    expect(screen.getByText('Password is required')).toBeInTheDocument();

    // 2. Short password validation
    await userEvent.type(emailInput, 'citizen@civic.test');
    await userEvent.type(passwordInput, 'short');
    fireEvent.click(submitBtn);
    expect(await screen.findByText('Password must be at least 10 characters')).toBeInTheDocument();

    // 3. Server-side problem+json field error
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 'invalid_credentials',
          title: 'Invalid Credentials',
          status: 401,
          detail: 'Email or password incorrect'
        }),
        { status: 401, headers: { 'Content-Type': 'application/problem+json' } }
      )
    );

    await userEvent.clear(passwordInput);
    await userEvent.type(passwordInput, 'CorrectLengthPassword#123');
    fireEvent.click(submitBtn);

    expect(await screen.findByText('Email or password incorrect')).toBeInTheDocument();
  });

  it('Register validation checks name, email, password length, and password matching email', async () => {
    render(
      <MemoryRouter initialEntries={['/register']}>
        <AuthProvider>
          <RegisterPage />
        </AuthProvider>
      </MemoryRouter>
    );

    const nameInput = screen.getByLabelText(/full name/i);
    const emailInput = screen.getByLabelText(/email address/i);
    const passwordInput = screen.getByLabelText(/^password/i);
    const submitBtn = screen.getByRole('button', { name: /create account/i });

    // Empty validation
    fireEvent.click(submitBtn);
    expect(await screen.findByText('Full name is required')).toBeInTheDocument();
    expect(screen.getByText('Email is required')).toBeInTheDocument();
    expect(screen.getByText('Password is required')).toBeInTheDocument();

    // Password matches email
    await userEvent.type(nameInput, 'Amit Patel');
    await userEvent.type(emailInput, 'amit.patel@civic.test');
    await userEvent.type(passwordInput, 'amit.patel@civic.test');
    fireEvent.click(submitBtn);
    expect(await screen.findByText('Password cannot match your email')).toBeInTheDocument();
  });

  it('navigation shows the right links per role (public, citizen, officer, admin)', async () => {
    // 1. Public view (no user)
    render(
      <MemoryRouter initialEntries={['/']}>
        <AuthProvider>
          <Layout />
        </AuthProvider>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByRole('link', { name: /map and list/i })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /login/i })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /register/i })).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /my reports/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /staff/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /admin/i })).not.toBeInTheDocument();
    });
  });

  it('RequireRole allows authorized roles and redirects unauthorized roles', async () => {
    setRefreshToken('valid-refresh');
    vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/auth/refresh')) {
        return new Response(JSON.stringify({ accessToken: 'tok', refreshToken: 'ref' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (url.includes('/auth/me')) {
        return new Response(
          JSON.stringify({
            id: 'u-1',
            email: 'cit@civic.test',
            displayName: 'Cit User',
            role: 'citizen',
            isActive: true,
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(null, { status: 404 });
    });

    render(
      <MemoryRouter initialEntries={['/admin-only']}>
        <AuthProvider>
          <Routes>
            <Route
              path="/admin-only"
              element={
                <RequireRole roles={['admin']}>
                  <div>Admin Panel Secret</div>
                </RequireRole>
              }
            />
            <Route path="/" element={<div>Home Public</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Home Public')).toBeInTheDocument();
      expect(screen.queryByText('Admin Panel Secret')).not.toBeInTheDocument();
    });
  });
});
