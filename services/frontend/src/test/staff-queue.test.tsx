import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StaffQueuePage } from '../features/staff/StaffQueuePage';
import { StaffReportDetailPage } from '../features/staff/StaffReportDetailPage';
import * as reportsApi from '../api/reports';
import * as routingApi from '../api/routing';
import * as authProvider from '../auth/AuthProvider';
import type { Report, User } from '../api/types';

const mockOfficerUser: User = {
  id: 'usr-officer-1',
  email: 'officer@civic.test',
  displayName: 'Jane Officer',
  role: 'officer',
  isActive: true,
  createdAt: '2026-10-10T10:00:00.000Z',
  updatedAt: '2026-10-10T10:00:00.000Z'
};

const mockAdminUser: User = {
  id: 'usr-admin-1',
  email: 'admin@civic.test',
  displayName: 'Super Admin',
  role: 'admin',
  isActive: true,
  createdAt: '2026-10-10T10:00:00.000Z',
  updatedAt: '2026-10-10T10:00:00.000Z'
};

const mockReport: Report = {
  id: 'rep-test-1234-5678',
  reporterId: 'usr-citizen-42',
  title: 'Severe Pothole on Station Road',
  description: 'Deep road cavity causing vehicular damage.',
  category: 'pothole',
  lat: 23.0225,
  lng: 72.5714,
  address: 'Near Station Gate 3',
  status: 'Submitted',
  version: 1,
  wardCode: 'W-R1C1',
  departmentCode: 'roads',
  photos: [
    {
      imageId: 'img-123',
      width: 800,
      height: 600,
      thumbnailUrl: '/api/v1/images/img-123/thumbnail',
      url: '/api/v1/images/img-123/file'
    }
  ],
  history: [
    {
      id: 'h-1',
      fromStatus: null,
      toStatus: 'Submitted',
      changedBy: 'usr-citizen-42',
      changedAt: '2026-10-18T10:00:00.000Z'
    }
  ],
  createdAt: '2026-10-18T10:00:00.000Z',
  updatedAt: '2026-10-18T10:00:00.000Z'
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

describe('Staff Queue and Detail Views', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    vi.spyOn(authProvider, 'useAuth').mockReturnValue({
      user: mockOfficerUser,
      isAuthenticated: true,
      isLoading: false,
      login: vi.fn(),
      register: vi.fn(),
      logout: vi.fn()
    });

    vi.spyOn(routingApi, 'listDepartmentsApi').mockResolvedValue([
      { code: 'roads', name: 'Roads & Bridges', email: 'roads@civic.test', active: true },
      { code: 'water', name: 'Water & Sewage', email: 'water@civic.test', active: true }
    ]);

    vi.spyOn(routingApi, 'listCategoriesApi').mockResolvedValue([
      { code: 'pothole', name: 'Pothole', departmentCode: 'roads', slaHours: 48, active: true }
    ]);

    vi.spyOn(routingApi, 'getWardsApi').mockResolvedValue({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { code: 'W-R1C1', name: 'North West Sector 1' },
          geometry: { type: 'Polygon', coordinates: [] }
        }
      ]
    });
  });

  describe('StaffQueuePage', () => {
    it('renders exactly one h1 and filter controls', async () => {
      vi.spyOn(reportsApi, 'listStaffReportsApi').mockResolvedValue({
        items: [mockReport],
        pagination: { page: 1, pageSize: 15, total: 1, totalPages: 1 }
      });

      renderWithProviders(<StaffQueuePage />);

      const headings = screen.getAllByRole('heading', { level: 1 });
      expect(headings).toHaveLength(1);
      expect(headings[0]).toHaveTextContent('Staff Queue');

      expect(screen.getByLabelText(/Search/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/Status/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/Category/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/Department/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/Ward/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/Sort by/i)).toBeInTheDocument();

      await waitFor(() => {
        expect(screen.getAllByText('Severe Pothole on Station Road').length).toBeGreaterThan(0);
      });
    });

    it('displays empty state when no reports match filters', async () => {
      vi.spyOn(reportsApi, 'listStaffReportsApi').mockResolvedValue({
        items: [],
        pagination: { page: 1, pageSize: 15, total: 0, totalPages: 0 }
      });

      renderWithProviders(<StaffQueuePage />);

      await waitFor(() => {
        expect(
          screen.getAllByText(/No reports match your selected filters/i).length
        ).toBeGreaterThan(0);
      });
    });

    it('triggers list query when filter inputs change', async () => {
      const listSpy = vi.spyOn(reportsApi, 'listStaffReportsApi').mockResolvedValue({
        items: [mockReport],
        pagination: { page: 1, pageSize: 15, total: 1, totalPages: 1 }
      });

      renderWithProviders(<StaffQueuePage />);

      const searchInput = screen.getByLabelText(/Search/i);
      fireEvent.change(searchInput, { target: { value: 'cavity' } });

      await waitFor(() => {
        expect(listSpy).toHaveBeenCalledWith(expect.objectContaining({ q: 'cavity' }));
      });
    });
  });

  describe('StaffReportDetailPage', () => {
    it('renders report details, map, copy button, and timeline history', async () => {
      vi.spyOn(reportsApi, 'getReportApi').mockResolvedValue(mockReport);

      renderWithProviders(
        <Routes>
          <Route path="/staff/reports/:id" element={<StaffReportDetailPage />} />
        </Routes>,
        '/staff/reports/rep-test-1234-5678'
      );

      await waitFor(() => {
        expect(screen.getByText('Severe Pothole on Station Road')).toBeInTheDocument();
      });

      expect(screen.getByText('Deep road cavity causing vehicular damage.')).toBeInTheDocument();
      expect(screen.getByText('History & Audit Trail')).toBeInTheDocument();
      expect(screen.getByTestId('map-container')).toBeInTheDocument();

      // Check reporter copy button
      const copyButtons = screen.getAllByRole('button', { name: /Copy/i });
      expect(copyButtons.length).toBeGreaterThan(0);
    });

    it('shows allowed transitions and enforces rejection reason validation', async () => {
      vi.spyOn(reportsApi, 'getReportApi').mockResolvedValue(mockReport);
      const updateStatusSpy = vi.spyOn(reportsApi, 'updateReportStatusApi').mockResolvedValue({
        ...mockReport,
        status: 'Rejected'
      });

      renderWithProviders(
        <Routes>
          <Route path="/staff/reports/:id" element={<StaffReportDetailPage />} />
        </Routes>,
        '/staff/reports/rep-test-1234-5678'
      );

      await waitFor(() => {
        expect(screen.getByLabelText(/Progress to Status/i)).toBeInTheDocument();
      });

      const statusSelect = screen.getByLabelText(/Progress to Status/i);
      expect(statusSelect).toBeInTheDocument();

      // Select 'Rejected' (requires reason)
      fireEvent.change(statusSelect, { target: { value: 'Rejected' } });

      await waitFor(() => {
        expect(screen.getByLabelText(/Rejection Reason/i)).toBeInTheDocument();
      });

      // Submit button should be disabled until reason is chosen
      const proceedBtn = screen.getByRole('button', { name: /Proceed to Rejected/i });
      expect(proceedBtn).toBeDisabled();

      // Select reason
      fireEvent.change(screen.getByLabelText(/Rejection Reason/i), {
        target: { value: 'duplicate' }
      });

      expect(proceedBtn).not.toBeDisabled();
      fireEvent.click(proceedBtn);

      // Confirm panel appears
      await waitFor(() => {
        expect(screen.getByText(/Confirm Transition to Rejected/i)).toBeInTheDocument();
      });

      const confirmBtn = screen.getByRole('button', { name: 'Confirm' });
      fireEvent.click(confirmBtn);

      await waitFor(() => {
        expect(updateStatusSpy).toHaveBeenCalledWith('rep-test-1234-5678', {
          toStatus: 'Rejected',
          reasonCode: 'duplicate',
          note: undefined
        });
      });
    });

    it('shows department reassignment panel for administrators', async () => {
      vi.spyOn(authProvider, 'useAuth').mockReturnValue({
        user: mockAdminUser,
        isAuthenticated: true,
        isLoading: false,
        login: vi.fn(),
        register: vi.fn(),
        logout: vi.fn()
      });

      vi.spyOn(reportsApi, 'getReportApi').mockResolvedValue(mockReport);
      const reassignSpy = vi.spyOn(routingApi, 'reassignReportApi').mockResolvedValue({
        reportId: mockReport.id,
        departmentCode: 'water',
        wardCode: 'W-R1C1',
        source: 'manual',
        assignedAt: '2026-10-18T12:00:00.000Z'
      });

      renderWithProviders(
        <Routes>
          <Route path="/staff/reports/:id" element={<StaffReportDetailPage />} />
        </Routes>,
        '/staff/reports/rep-test-1234-5678'
      );

      await waitFor(() => {
        expect(screen.getByText('Department Reassignment')).toBeInTheDocument();
      });

      const deptSelect = screen.getByLabelText(/Target Department/i);
      fireEvent.change(deptSelect, { target: { value: 'water' } });

      const reassignBtn = screen.getByRole('button', { name: /Reassign Report/i });
      expect(reassignBtn).not.toBeDisabled();
      fireEvent.click(reassignBtn);

      await waitFor(() => {
        expect(reassignSpy).toHaveBeenCalledWith('rep-test-1234-5678', {
          departmentCode: 'water',
          wardCode: undefined
        });
      });
    });
  });
});
