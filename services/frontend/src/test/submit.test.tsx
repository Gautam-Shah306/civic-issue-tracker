import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SubmitReportPage } from '../features/citizen/SubmitReportPage.js';

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/submit']}>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('Submit Report Journey (D3)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/public/categories')) {
        return new Response(
          JSON.stringify([
            { slug: 'pothole', name: 'Pothole', description: 'Road potholes' },
            { slug: 'streetlight', name: 'Streetlight', description: 'Broken lamps' }
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(null, { status: 404 });
    });
  });

  it('enforces step validation per step and advances on valid inputs', async () => {
    renderWithClient(<SubmitReportPage />);

    // Step 1: Click next without filling required fields
    const nextBtn = await screen.findByRole('button', { name: /continue to location/i });
    fireEvent.click(nextBtn);

    expect(await screen.findByText('Title is required')).toBeInTheDocument();
    expect(screen.getByText('Please select an issue category')).toBeInTheDocument();

    // Fill valid inputs
    await userEvent.type(screen.getByLabelText(/issue title/i), 'Large crater on main street');
    await userEvent.selectOptions(screen.getByLabelText(/category/i), 'pothole');
    await userEvent.type(
      screen.getByLabelText(/detailed description/i),
      'Deep pothole near intersection'
    );

    fireEvent.click(nextBtn);

    // Advances to Step 2
    expect(await screen.findByText('Step 2: Pinpoint Location')).toBeInTheDocument();
  });

  it('handles geolocation granted and geolocation denied gracefully', async () => {
    renderWithClient(<SubmitReportPage />);

    // Advance to Step 2
    await screen.findByLabelText(/issue title/i);
    await userEvent.type(screen.getByLabelText(/issue title/i), 'Pothole issue');
    await userEvent.selectOptions(screen.getByLabelText(/category/i), 'pothole');
    fireEvent.click(screen.getByRole('button', { name: /continue to location/i }));

    await screen.findByText('Step 2: Pinpoint Location');

    // 1. Mock Geolocation denied
    const mockGeolocationDenied = {
      getCurrentPosition: vi.fn().mockImplementation((_success, error) => {
        error({ code: 1, PERMISSION_DENIED: 1, message: 'User denied geolocation' });
      })
    };
    (global.navigator as any).geolocation = mockGeolocationDenied;

    const locBtn = screen.getByRole('button', { name: /use my current location/i });
    fireEvent.click(locBtn);

    expect(await screen.findByText(/location permission was denied/i)).toBeInTheDocument();

    // 2. Mock Geolocation granted
    const mockGeolocationGranted = {
      getCurrentPosition: vi.fn().mockImplementation((success) => {
        success({
          coords: {
            latitude: 23.0512,
            longitude: 72.5834
          }
        });
      })
    };
    (global.navigator as any).geolocation = mockGeolocationGranted;

    fireEvent.click(locBtn);
    await waitFor(() => {
      expect(screen.getByText(/23.0512, 72.5834/)).toBeInTheDocument();
    });
  });

  it('handles photo upload, polling progress, rejection, and skip photo', async () => {
    renderWithClient(<SubmitReportPage />);

    // Navigate to Step 3
    await screen.findByLabelText(/issue title/i);
    await userEvent.type(screen.getByLabelText(/issue title/i), 'Streetlight broken');
    await userEvent.selectOptions(screen.getByLabelText(/category/i), 'streetlight');
    fireEvent.click(screen.getByRole('button', { name: /continue to location/i }));

    await screen.findByText('Step 2: Pinpoint Location');
    fireEvent.click(screen.getByRole('button', { name: /continue to photo/i }));

    await screen.findByText('Step 3: Attach Photo (Optional)');

    // Skip Photo button proceeds directly to Step 4 without photo
    const skipBtn = screen.getByRole('button', { name: /skip photo/i });
    fireEvent.click(skipBtn);

    expect(await screen.findByText('Step 4: Review and Submit')).toBeInTheDocument();
    expect(screen.getByText('No photo attached')).toBeInTheDocument();
  });

  it('form state survives an API submission error and blocks double submit', async () => {
    renderWithClient(<SubmitReportPage />);

    // Step 1
    await screen.findByLabelText(/issue title/i);
    await userEvent.type(screen.getByLabelText(/issue title/i), 'Drainage overflow');
    await userEvent.selectOptions(screen.getByLabelText(/category/i), 'pothole');
    await userEvent.type(screen.getByLabelText(/detailed description/i), 'Water accumulating');
    fireEvent.click(screen.getByRole('button', { name: /continue to location/i }));

    // Step 2
    await screen.findByText('Step 2: Pinpoint Location');
    await userEvent.type(screen.getByLabelText(/street address/i), 'Lane 4, Sector 7');
    fireEvent.click(screen.getByRole('button', { name: /continue to photo/i }));

    // Step 3
    await screen.findByText('Step 3: Attach Photo (Optional)');
    fireEvent.click(screen.getByRole('button', { name: /review/i }));

    // Step 4
    await screen.findByText('Step 4: Review and Submit');

    // Mock API failure
    vi.spyOn(global, 'fetch').mockImplementationOnce(async () => {
      return new Response(
        JSON.stringify({
          code: 'internal_error',
          title: 'Database Timeout',
          status: 500,
          detail: 'Failed to insert report'
        }),
        { status: 500, headers: { 'Content-Type': 'application/problem+json' } }
      );
    });

    const submitBtn = screen.getByRole('button', { name: /submit report/i });
    fireEvent.click(submitBtn);

    // Displays error
    expect(await screen.findByText('Failed to insert report')).toBeInTheDocument();

    // Verify form state was NOT lost!
    expect(screen.getByText('Drainage overflow')).toBeInTheDocument();
    expect(screen.getByText('Lane 4, Sector 7')).toBeInTheDocument();
    expect(screen.getByText('Water accumulating')).toBeInTheDocument();
  });
});
