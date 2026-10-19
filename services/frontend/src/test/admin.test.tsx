import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdminDashboardPage } from '../features/admin/AdminDashboardPage';
import { AdminUsersPage } from '../features/admin/AdminUsersPage';
import { AdminMasterDataPage } from '../features/admin/AdminMasterDataPage';
import { AdminAuditPage } from '../features/admin/AdminAuditPage';
import { RequireRole } from '../auth/RequireRole';
import * as analyticsApi from '../api/analytics';
import * as authApi from '../api/auth';
import * as routingApi from '../api/routing';
import * as authProvider from '../auth/AuthProvider';
import type { User, AnalyticsSummary, AuditLogItem } from '../api/types';

const mockAdminUser: User = {
  id: 'usr-admin-1',
  email: 'admin@civic.test',
  displayName: 'Admin User',
  role: 'admin',
  isActive: true,
  createdAt: '2026-10-10T10:00:00.000Z',
  updatedAt: '2026-10-10T10:00:00.000Z'
};

const mockOfficerUser: User = {
  id: 'usr-officer-2',
  email: 'officer@civic.test',
  displayName: 'Officer Bob',
  role: 'officer',
  isActive: true,
  createdAt: '2026-10-12T10:00:00.000Z',
  updatedAt: '2026-10-12T10:00:00.000Z'
};

const mockSummary: AnalyticsSummary = {
  totalReports: 142,
  openReports: 38,
  resolvedReports: 94,
  avgResolutionHours: 18.5,
  byStatus: {
    Submitted: 12,
    Assigned: 15,
    'In Progress': 11,
    Resolved: 94,
    Rejected: 10
  },
  byCategory: {
    pothole: 55,
    garbage: 40,
    streetlight: 27,
    'water-leak': 20
  },
  byWard: {
    'W-R1C1': 45,
    'W-R1C2': 32
  },
  byDepartment: {
    roads: 55,
    sanitation: 40,
    electricity: 27,
    water: 20
  }
};

const mockAuditItem: AuditLogItem = {
  id: 'audit-1',
  eventId: '11111111-1111-1111-1111-111111111111',
  eventType: 'report.status-changed',
  eventVersion: 1,
  subjectId: 'rep-uuid-1',
  correlationId: '22222222-2222-2222-2222-222222222222',
  actorId: 'usr-admin-1',
  occurredAt: '2026-10-18T10:30:00.000Z',
  recordedAt: '2026-10-18T10:30:01.000Z',
  payload: {
    reportId: 'rep-uuid-1',
    fromStatus: 'Submitted',
    toStatus: 'Assigned',
    departmentCode: 'roads'
  }
};

function renderWithProviders(ui: React.ReactElement, initialRoute = '/') {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 }
    }
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialRoute]}>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('Administrator Views and Role Guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.spyOn(authProvider, 'useAuth').mockReturnValue({
      user: mockAdminUser,
      isAuthenticated: true,
      isLoading: false,
      login: vi.fn(),
      register: vi.fn(),
      logout: vi.fn()
    });
  });

  describe('AdminDashboardPage', () => {
    it('renders exactly one h1 and 4 summary KPI metric cards', async () => {
      vi.spyOn(analyticsApi, 'getAnalyticsSummaryApi').mockResolvedValue(mockSummary);

      renderWithProviders(<AdminDashboardPage />);

      const headings = screen.getAllByRole('heading', { level: 1 });
      expect(headings).toHaveLength(1);
      expect(headings[0]).toHaveTextContent('Administrator Dashboard');

      await waitFor(() => {
        expect(screen.getByText('142')).toBeInTheDocument();
        expect(screen.getByText('38')).toBeInTheDocument();
        expect(screen.getAllByText('94').length).toBeGreaterThan(0);
        expect(screen.getByText(/18.5/)).toBeInTheDocument();
      });

      // Pure CSS BarList breakdown cards
      expect(screen.getByText('Reports by Status')).toBeInTheDocument();
      expect(screen.getByText('Reports by Category')).toBeInTheDocument();
      expect(screen.getByText('Reports by Ward')).toBeInTheDocument();
      expect(screen.getByText('Reports by Department')).toBeInTheDocument();
    });

    it('refetches summary metrics on clicking refresh button', async () => {
      const summarySpy = vi
        .spyOn(analyticsApi, 'getAnalyticsSummaryApi')
        .mockResolvedValue(mockSummary);

      renderWithProviders(<AdminDashboardPage />);

      await waitFor(() => {
        expect(screen.getByText('142')).toBeInTheDocument();
      });

      const refreshBtn = screen.getByRole('button', { name: /Refresh Data/i });
      fireEvent.click(refreshBtn);

      expect(summarySpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('AdminUsersPage', () => {
    it('renders users list, identifies own row with You badge, and disables self-harm actions', async () => {
      vi.spyOn(authApi, 'listUsersApi').mockResolvedValue({
        items: [mockAdminUser, mockOfficerUser],
        pagination: { page: 1, pageSize: 15, total: 2, totalPages: 1 }
      });

      renderWithProviders(<AdminUsersPage />);

      const headings = screen.getAllByRole('heading', { level: 1 });
      expect(headings).toHaveLength(1);
      expect(headings[0]).toHaveTextContent('User Management');

      await waitFor(() => {
        expect(screen.getByText('Admin User')).toBeInTheDocument();
        expect(screen.getByText('Officer Bob')).toBeInTheDocument();
      });

      // You badge on self row
      expect(screen.getByText('You')).toBeInTheDocument();

      // Deactivate button on self row is disabled
      const deactivateButtons = screen.getAllByRole('button', { name: /Deactivate/i });
      expect(deactivateButtons[0]).toBeDisabled(); // self
      expect(deactivateButtons[1]).not.toBeDisabled(); // officer bob
    });

    it('allows creating a new staff account via creation form', async () => {
      vi.spyOn(authApi, 'listUsersApi').mockResolvedValue({
        items: [mockAdminUser],
        pagination: { page: 1, pageSize: 15, total: 1, totalPages: 1 }
      });

      const createSpy = vi.spyOn(authApi, 'createUserApi').mockResolvedValue({
        id: 'usr-new-3',
        email: 'newstaff@civic.test',
        displayName: 'New Staff',
        role: 'officer',
        isActive: true,
        createdAt: '2026-10-18T11:00:00.000Z',
        updatedAt: '2026-10-18T11:00:00.000Z'
      });

      renderWithProviders(<AdminUsersPage />);

      const addBtn = screen.getByRole('button', { name: /\+ Add Staff User/i });
      fireEvent.click(addBtn);

      await waitFor(() => {
        expect(screen.getByText('Create Staff Account')).toBeInTheDocument();
      });

      fireEvent.change(screen.getByLabelText(/Email Address/i), {
        target: { value: 'newstaff@civic.test' }
      });
      fireEvent.change(screen.getByLabelText(/Full Name/i), {
        target: { value: 'New Staff' }
      });
      fireEvent.change(screen.getByLabelText(/Initial Password/i), {
        target: { value: 'Secr3tPassword123!' }
      });

      const submitBtn = screen.getByRole('button', { name: /Create Account/i });
      fireEvent.click(submitBtn);

      await waitFor(() => {
        expect(createSpy).toHaveBeenCalledWith({
          email: 'newstaff@civic.test',
          displayName: 'New Staff',
          password: 'Secr3tPassword123!',
          role: 'officer'
        });
      });
    });
  });

  describe('AdminMasterDataPage', () => {
    it('switches between categories, departments, and wards tabs', async () => {
      vi.spyOn(routingApi, 'listCategoriesApi').mockResolvedValue([
        { code: 'pothole', name: 'Pothole', departmentCode: 'roads', slaHours: 48, active: true }
      ]);
      vi.spyOn(routingApi, 'listDepartmentsApi').mockResolvedValue([
        { code: 'roads', name: 'Roads Dept', email: 'roads@civic.test', active: true }
      ]);
      vi.spyOn(routingApi, 'getWardsApi').mockResolvedValue({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { code: 'W-R1C1', name: 'Ward 1' },
            geometry: { type: 'Polygon', coordinates: [] }
          }
        ]
      });

      renderWithProviders(<AdminMasterDataPage />);

      const headings = screen.getAllByRole('heading', { level: 1 });
      expect(headings).toHaveLength(1);
      expect(headings[0]).toHaveTextContent('Master Data Management');

      // Default active tab is Categories
      await waitFor(() => {
        expect(screen.getByText('Pothole')).toBeInTheDocument();
      });

      // Switch to Departments tab
      const deptTab = screen.getByRole('tab', { name: /Departments/i });
      fireEvent.click(deptTab);

      await waitFor(() => {
        expect(screen.getByText('Roads Dept')).toBeInTheDocument();
      });

      // Switch to Wards tab
      const wardsTab = screen.getByRole('tab', { name: /Wards/i });
      fireEvent.click(wardsTab);

      await waitFor(() => {
        expect(screen.getByText('W-R1C1')).toBeInTheDocument();
        expect(screen.getByTestId('map-container')).toBeInTheDocument();
      });
    });
  });

  describe('AdminAuditPage', () => {
    it('renders audit logs and inspects JSON payload', async () => {
      vi.spyOn(analyticsApi, 'getAuditLogsApi').mockResolvedValue({
        items: [mockAuditItem],
        total: 1,
        page: 1,
        pageSize: 15,
        totalPages: 1
      });

      renderWithProviders(<AdminAuditPage />);

      const headings = screen.getAllByRole('heading', { level: 1 });
      expect(headings).toHaveLength(1);
      expect(headings[0]).toHaveTextContent('System Audit Trail');

      await waitFor(() => {
        expect(screen.getByText('report.status-changed')).toBeInTheDocument();
      });

      const inspectBtn = screen.getByRole('button', { name: /Inspect/i });
      fireEvent.click(inspectBtn);

      await waitFor(() => {
        expect(screen.getByText(/Event Details/i)).toBeInTheDocument();
        expect(screen.getByText(/"departmentCode": "roads"/i)).toBeInTheDocument();
      });
    });
  });

  describe('RequireRole authorization guard', () => {
    it('redirects unauthorized roles away to home page', () => {
      vi.spyOn(authProvider, 'useAuth').mockReturnValue({
        user: {
          id: 'usr-citizen-1',
          email: 'citizen@civic.test',
          displayName: 'Citizen Bob',
          role: 'citizen',
          isActive: true,
          createdAt: '2026-10-10T10:00:00.000Z',
          updatedAt: '2026-10-10T10:00:00.000Z'
        },
        isAuthenticated: true,
        isLoading: false,
        login: vi.fn(),
        register: vi.fn(),
        logout: vi.fn()
      });

      renderWithProviders(
        <Routes>
          <Route path="/" element={<div>Home Page</div>} />
          <Route
            path="/admin"
            element={
              <RequireRole roles={['admin']}>
                <div>Secret Admin Area</div>
              </RequireRole>
            }
          />
        </Routes>,
        '/admin'
      );

      expect(screen.getByText('Home Page')).toBeInTheDocument();
      expect(screen.queryByText('Secret Admin Area')).not.toBeInTheDocument();
    });
  });
});
