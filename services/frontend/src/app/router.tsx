import React from 'react';
import { createBrowserRouter, Navigate, Link } from 'react-router';
import { Layout } from './Layout.js';
import { HomePage } from '../features/public/HomePage.js';
import { PublicReportDetailPage } from '../features/public/PublicReportDetailPage.js';
import { LoginPage } from '../features/auth/LoginPage.js';
import { RegisterPage } from '../features/auth/RegisterPage.js';
import { SubmitReportPage } from '../features/citizen/SubmitReportPage.js';
import { MyReportsPage } from '../features/citizen/MyReportsPage.js';
import { MyReportDetailPage } from '../features/citizen/MyReportDetailPage.js';
import { RequireAuth } from '../auth/RequireAuth.js';
import { Card } from '../components/Card.js';
import { Button } from '../components/Button.js';

const NotFoundPage: React.FC = () => (
  <div className="max-w-md mx-auto py-12 text-center">
    <Card surface>
      <h1 className="text-2xl font-semibold text-text mb-2">Page Not Found</h1>
      <p className="text-sm text-text-muted mb-6">
        The requested page does not exist or has been moved.
      </p>
      <Link to="/">
        <Button variant="primary" size="sm">
          Return to Home
        </Button>
      </Link>
    </Card>
  </div>
);

export const router = createBrowserRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      {
        index: true,
        element: <HomePage />
      },
      {
        path: 'reports/:id',
        element: <PublicReportDetailPage />
      },
      {
        path: 'login',
        element: <LoginPage />
      },
      {
        path: 'register',
        element: <RegisterPage />
      },
      {
        path: 'submit',
        element: (
          <RequireAuth>
            <SubmitReportPage />
          </RequireAuth>
        )
      },
      {
        path: 'my',
        element: (
          <RequireAuth>
            <MyReportsPage />
          </RequireAuth>
        )
      },
      {
        path: 'my/:id',
        element: (
          <RequireAuth>
            <MyReportDetailPage />
          </RequireAuth>
        )
      },
      {
        path: '404',
        element: <NotFoundPage />
      },
      {
        path: '*',
        element: <Navigate to="/404" replace />
      }
    ]
  }
]);
