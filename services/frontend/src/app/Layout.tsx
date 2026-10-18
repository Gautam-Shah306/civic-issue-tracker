import React, { useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthProvider.js';
import { Button } from '../components/Button.js';

export const Layout: React.FC = () => {
  const { user, isAuthenticated, logout } = useAuth();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate('/');
    setMobileMenuOpen(false);
  };

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    `text-sm font-medium transition-colors ${
      isActive
        ? 'text-text font-semibold underline underline-offset-4'
        : 'text-text-muted hover:text-text'
    }`;

  return (
    <div className="min-h-screen flex flex-col bg-bg text-text">
      {/* Header */}
      <header className="border-b border-border bg-bg sticky top-0 z-20">
        <div className="content-container px-4 md:px-6 h-control-lg flex items-center justify-between">
          {/* Brand */}
          <Link
            to="/"
            className="flex flex-col focus-ring rounded-sm no-underline"
            onClick={() => setMobileMenuOpen(false)}
          >
            <span className="text-lg font-semibold tracking-tight text-text leading-tight">
              NagrikSetu
            </span>
            <span className="text-xs text-text-muted font-normal leading-tight">
              Civic Issue Tracker
            </span>
          </Link>

          {/* Desktop Navigation */}
          <nav aria-label="Main Navigation" className="hidden md:flex items-center gap-6">
            <NavLink to="/" end className={navLinkClass}>
              Map and list
            </NavLink>

            {isAuthenticated && (
              <>
                <NavLink to="/submit" className={navLinkClass}>
                  Submit report
                </NavLink>
                <NavLink to="/my" className={navLinkClass}>
                  My reports
                </NavLink>
              </>
            )}

            {user && (user.role === 'officer' || user.role === 'admin') && (
              <NavLink to="/staff" className={navLinkClass}>
                Staff
              </NavLink>
            )}

            {user && user.role === 'admin' && (
              <NavLink to="/admin" className={navLinkClass}>
                Admin
              </NavLink>
            )}

            {isAuthenticated ? (
              <div className="flex items-center gap-3 ml-2 border-l border-border pl-4">
                <span className="text-xs text-text-muted font-medium">{user?.displayName}</span>
                <Button variant="secondary" size="sm" onClick={handleLogout}>
                  Logout
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-3 ml-2 border-l border-border pl-4">
                <NavLink to="/login" className={navLinkClass}>
                  Login
                </NavLink>
                <Link to="/register">
                  <Button variant="primary" size="sm">
                    Register
                  </Button>
                </Link>
              </div>
            )}
          </nav>

          {/* Mobile menu button */}
          <div className="flex md:hidden items-center">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="p-2 text-text rounded-md focus-ring"
              aria-label={mobileMenuOpen ? 'Close navigation menu' : 'Open navigation menu'}
              aria-expanded={mobileMenuOpen}
            >
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                {mobileMenuOpen ? (
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                ) : (
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M4 6h16M4 12h16M4 18h16"
                  />
                )}
              </svg>
            </button>
          </div>
        </div>

        {/* Mobile dropdown menu */}
        {mobileMenuOpen && (
          <div className="md:hidden border-t border-border bg-surface px-4 py-4 flex flex-col gap-3">
            <NavLink to="/" end className={navLinkClass} onClick={() => setMobileMenuOpen(false)}>
              Map and list
            </NavLink>

            {isAuthenticated && (
              <>
                <NavLink
                  to="/submit"
                  className={navLinkClass}
                  onClick={() => setMobileMenuOpen(false)}
                >
                  Submit report
                </NavLink>
                <NavLink to="/my" className={navLinkClass} onClick={() => setMobileMenuOpen(false)}>
                  My reports
                </NavLink>
              </>
            )}

            {user && (user.role === 'officer' || user.role === 'admin') && (
              <NavLink
                to="/staff"
                className={navLinkClass}
                onClick={() => setMobileMenuOpen(false)}
              >
                Staff
              </NavLink>
            )}

            {user && user.role === 'admin' && (
              <NavLink
                to="/admin"
                className={navLinkClass}
                onClick={() => setMobileMenuOpen(false)}
              >
                Admin
              </NavLink>
            )}

            <div className="pt-3 border-t border-border flex flex-col gap-2">
              {isAuthenticated ? (
                <>
                  <span className="text-xs text-text-muted">
                    Signed in as <strong className="text-text">{user?.displayName}</strong> (
                    {user?.role})
                  </span>
                  <Button variant="secondary" size="sm" onClick={handleLogout} className="w-full">
                    Logout
                  </Button>
                </>
              ) : (
                <div className="flex gap-2">
                  <Link to="/login" className="flex-1" onClick={() => setMobileMenuOpen(false)}>
                    <Button variant="secondary" size="sm" className="w-full">
                      Login
                    </Button>
                  </Link>
                  <Link to="/register" className="flex-1" onClick={() => setMobileMenuOpen(false)}>
                    <Button variant="primary" size="sm" className="w-full">
                      Register
                    </Button>
                  </Link>
                </div>
              )}
            </div>
          </div>
        )}
      </header>

      {/* Main content */}
      <main className="flex-1 content-container px-4 md:px-6 py-6">
        <Outlet />
      </main>

      {/* Footer */}
      <footer className="border-t border-border bg-surface py-6 px-4 md:px-6 text-xs text-text-muted">
        <div className="content-container flex flex-col sm:flex-row items-center justify-between gap-2">
          <span>All data is synthetic</span>
          <span>
            Map tiles ©{' '}
            <a
              href="https://www.openstreetmap.org/copyright"
              target="_blank"
              rel="noopener noreferrer"
              className="underline text-text hover:text-primary-hover"
            >
              OpenStreetMap
            </a>{' '}
            contributors
          </span>
        </div>
      </footer>
    </div>
  );
};
