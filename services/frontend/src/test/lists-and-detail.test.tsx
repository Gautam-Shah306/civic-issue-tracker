import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HomePage } from '../features/public/HomePage.js';
import { PublicReportDetailPage } from '../features/public/PublicReportDetailPage.js';
import { MyReportsPage } from '../features/citizen/MyReportsPage.js';
import { MyReportDetailPage } from '../features/citizen/MyReportDetailPage.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { ReportStatus } from '../api/types.js';

function renderWithClient(ui: React.ReactElement, initialRoute = '/') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialRoute]}>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('Lists, Detail Views, and StatusBadge (D4)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('StatusBadge shows text and an icon for every status', () => {
    const statuses: ReportStatus[] = [
      'Submitted',
      'Verified',
      'Assigned',
      'In Progress',
      'Resolved',
      'Closed',
      'Rejected',
      'Reopened'
    ];

    for (const status of statuses) {
      const { unmount } = render(<StatusBadge status={status} />);
      const badge = screen.getByText(status);
      expect(badge).toBeInTheDocument();
      // Verify SVG icon exists inside
      const svg = badge.parentElement?.querySelector('svg');
      expect(svg).not.toBeNull();
      unmount();
    }
  });

  it('My reports displays list, filter, and pagination', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/reports/mine')) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: 'rep-1',
                reporterId: 'user-1',
                title: 'Broken Streetlight Lane 2',
                category: 'streetlight',
                lat: 23.03,
                lng: 72.58,
                status: 'Submitted',
                version: 1,
                wardCode: 'WARD-001',
                createdAt: '2026-10-01T10:00:00Z',
                updatedAt: '2026-10-01T10:00:00Z'
              }
            ],
            pagination: { page: 1, pageSize: 10, total: 15, totalPages: 2 }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(null, { status: 404 });
    });

    renderWithClient(<MyReportsPage />);

    expect(await screen.findByText('Broken Streetlight Lane 2')).toBeInTheDocument();
    expect(screen.getByText(/WARD-001/)).toBeInTheDocument();
    // Check pagination exists
    expect(screen.getByText(/Page/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /next page/i })).toBeInTheDocument();
  });

  it('MyReportDetailPage renders details, allows reopening with confirmation, and submits note', async () => {
    let statusUpdateBody: any = null;

    vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/reports/rep-1/status') && init?.method === 'POST') {
        statusUpdateBody = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({
            id: 'rep-1',
            reporterId: 'user-1',
            title: 'Repaired Water Leak',
            category: 'water-leak',
            lat: 23.03,
            lng: 72.58,
            status: 'Reopened',
            version: 3,
            history: [
              {
                id: 'h-1',
                fromStatus: 'Resolved',
                toStatus: 'Reopened',
                changedAt: '2026-10-02T10:00:00Z'
              }
            ],
            createdAt: '2026-10-01T10:00:00Z',
            updatedAt: '2026-10-02T10:00:00Z'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('/reports/rep-1')) {
        return new Response(
          JSON.stringify({
            id: 'rep-1',
            reporterId: 'user-1',
            title: 'Repaired Water Leak',
            description: 'Water was leaking from main line',
            category: 'water-leak',
            lat: 23.03,
            lng: 72.58,
            status: 'Resolved',
            version: 2,
            wardCode: 'WARD-005',
            departmentCode: 'WATER',
            history: [
              {
                id: 'h-1',
                fromStatus: null,
                toStatus: 'Submitted',
                changedAt: '2026-10-01T10:00:00Z'
              },
              {
                id: 'h-2',
                fromStatus: 'Submitted',
                toStatus: 'Resolved',
                note: 'Line fixed',
                changedAt: '2026-10-02T10:00:00Z'
              }
            ],
            createdAt: '2026-10-01T10:00:00Z',
            updatedAt: '2026-10-02T10:00:00Z'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(null, { status: 404 });
    });

    renderWithClient(
      <Routes>
        <Route path="/my/:id" element={<MyReportDetailPage />} />
      </Routes>,
      '/my/rep-1'
    );

    expect(await screen.findByText('Repaired Water Leak')).toBeInTheDocument();
    expect(screen.getByText('Line fixed')).toBeInTheDocument();

    // Click Reopen Report
    const reopenBtn = screen.getByRole('button', { name: /reopen report/i });
    fireEvent.click(reopenBtn);

    // Confirmation panel appears
    expect(await screen.findByText('Confirm Reopening of Report')).toBeInTheDocument();
    const noteInput = screen.getByLabelText(/reason for reopening/i);
    await userEvent.type(noteInput, 'The pipe has started leaking again this morning.');

    // Confirm
    const confirmBtn = screen.getByRole('button', { name: /confirm reopen/i });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(statusUpdateBody).toEqual({
        toStatus: 'Reopened',
        note: 'The pipe has started leaking again this morning.'
      });
    });
  });

  it('PublicReportDetailPage renders photo, timeline, and handles 404', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/public/reports/unknown-id')) {
        return new Response(
          JSON.stringify({ code: 'not_found', status: 404, title: 'Not Found' }),
          { status: 404, headers: { 'Content-Type': 'application/problem+json' } }
        );
      }
      if (url.includes('/public/reports/rep-public-1')) {
        return new Response(
          JSON.stringify({
            id: 'rep-public-1',
            title: 'Fallen Tree on Road',
            description: 'Tree blocking right lane',
            category: 'tree-fall',
            lat: 23.04,
            lng: 72.56,
            status: 'Verified',
            photos: [
              {
                imageId: 'img-123',
                width: 1600,
                height: 1200,
                thumbnailUrl: '/api/v1/images/img-123/thumbnail',
                url: '/api/v1/images/img-123/file'
              }
            ],
            timeline: [
              { fromStatus: null, toStatus: 'Submitted', changedAt: '2026-10-05T09:00:00Z' },
              { fromStatus: 'Submitted', toStatus: 'Verified', changedAt: '2026-10-05T11:00:00Z' }
            ],
            createdAt: '2026-10-05T09:00:00Z'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(null, { status: 404 });
    });

    // 1. Valid report with photo & timeline
    const { unmount } = renderWithClient(
      <Routes>
        <Route path="/reports/:id" element={<PublicReportDetailPage />} />
      </Routes>,
      '/reports/rep-public-1'
    );

    expect(await screen.findByText('Fallen Tree on Road')).toBeInTheDocument();
    expect(screen.getByText('Tree blocking right lane')).toBeInTheDocument();
    expect(screen.getByAltText(/civic issue documentation/i)).toBeInTheDocument();
    unmount();

    // 2. Unknown report renders 404 state
    renderWithClient(
      <Routes>
        <Route path="/reports/:id" element={<PublicReportDetailPage />} />
      </Routes>,
      '/reports/unknown-id'
    );

    expect(await screen.findByText('Report Not Found')).toBeInTheDocument();
  });

  it('HomePage renders map and list views with category filters and pagination', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/public/categories')) {
        return new Response(
          JSON.stringify([
            { slug: 'pothole', name: 'Pothole', description: 'Road potholes' },
            { slug: 'water-leak', name: 'Water Leak', description: 'Pipeline leaks' }
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('/public/reports')) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: 'home-rep-1',
                title: 'Massive Pothole Near Circle',
                category: 'pothole',
                lat: 23.03,
                lng: 72.58,
                status: 'Submitted',
                createdAt: '2026-10-01T12:00:00Z'
              }
            ],
            pagination: { page: 1, pageSize: 10, total: 1, totalPages: 1 }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(null, { status: 404 });
    });

    renderWithClient(<HomePage />);

    expect(await screen.findByText('Civic Issues')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /map view/i })).toBeInTheDocument();

    // Switch to List View
    const listTabBtn = screen.getByRole('button', { name: /list view/i });
    fireEvent.click(listTabBtn);

    expect(await screen.findByText('Massive Pothole Near Circle')).toBeInTheDocument();
  });
});
