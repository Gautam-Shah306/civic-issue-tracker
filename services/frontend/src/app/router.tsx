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
import { StaffQueuePage } from '../features/staff/StaffQueuePage.js';
import { StaffReportDetailPage } from '../features/staff/StaffReportDetailPage.js';
import { AdminDashboardPage } from '../features/admin/AdminDashboardPage.js';
import { AdminUsersPage } from '../features/admin/AdminUsersPage.js';
import { AdminMasterDataPage } from '../features/admin/AdminMasterDataPage.js';
import { AdminAuditPage } from '../features/admin/AdminAuditPage.js';
import { RequireAuth } from '../auth/RequireAuth.js';
import { RequireRole } from '../auth/RequireRole.js';
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
      // Staff Views
      {
        path: 'staff',
        element: (
          <RequireRole roles={['officer', 'admin']}>
            <StaffQueuePage />
          </RequireRole>
        )
      },
      {
        path: 'staff/reports/:id',
        element: (
          <RequireRole roles={['officer', 'admin']}>
            <StaffReportDetailPage />
          </RequireRole>
        )
      },
      // Admin Views
      {
        path: 'admin',
        element: (
          <RequireRole roles={['admin']}>
            <AdminDashboardPage />
          </RequireRole>
        )
      },
      {
        path: 'admin/reports',
        element: (
          <RequireRole roles={['admin']}>
            <StaffQueuePage />
          </RequireRole>
        )
      },
      {
        path: 'admin/users',
        element: (
          <RequireRole roles={['admin']}>
            <AdminUsersPage />
          </RequireRole>
        )
      },
      {
        path: 'admin/master-data',
        element: (
          <RequireRole roles={['admin']}>
            <AdminMasterDataPage />
          </RequireRole>
        )
      },
      {
        path: 'admin/audit',
        element: (
          <RequireRole roles={['admin']}>
            <AdminAuditPage />
          </RequireRole>
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
