import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { User } from '../api/types.js';
import { getMeApi, loginApi, logoutApi, refreshApi, registerApi } from '../api/auth.js';
import { clearTokens, getRefreshToken } from '../api/client.js';

export interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (credentials: { email: string; password: string }) => Promise<void>;
  register: (payload: { email: string; password: string; displayName: string }) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  // Restore session on load from refresh token
  useEffect(() => {
    let mounted = true;
    async function restoreSession() {
      const storedRefreshToken = getRefreshToken();
      if (!storedRefreshToken) {
        if (mounted) setIsLoading(false);
        return;
      }

      try {
        await refreshApi();
        const me = await getMeApi();
        if (mounted) {
          setUser(me);
        }
      } catch {
        clearTokens();
        if (mounted) {
          setUser(null);
        }
      } finally {
        if (mounted) {
          setIsLoading(false);
        }
      }
    }

    restoreSession();
    return () => {
      mounted = false;
    };
  }, []);

  const login = useCallback(async (credentials: { email: string; password: string }) => {
    const res = await loginApi(credentials);
    setUser(res.user);
  }, []);

  const register = useCallback(
    async (payload: { email: string; password: string; displayName: string }) => {
      const res = await registerApi(payload);
      setUser(res.user);
    },
    []
  );

  const logout = useCallback(async () => {
    try {
      await logoutApi();
    } finally {
      setUser(null);
    }
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated: !!user,
        isLoading,
        login,
        register,
        logout
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
