import React from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { getAnalyticsSummaryApi } from '../../api/analytics.js';
import { Card } from '../../components/Card.js';
import { Button } from '../../components/Button.js';
import { Spinner } from '../../components/Spinner.js';
import { ErrorNotice } from '../../components/ErrorNotice.js';
import { BarList, BarListItem } from '../../components/BarList.js';

export const AdminDashboardPage: React.FC = () => {
  const {
    data: summary,
    isLoading,
    error,
    refetch,
    isFetching
  } = useQuery({
    queryKey: ['analytics-summary'],
    queryFn: () => getAnalyticsSummaryApi()
  });

  const totalReports = summary?.totalReports ?? 0;
  const openReports = summary?.openReports ?? 0;
  const resolvedReports =
    summary?.resolvedReports ?? summary?.byStatus?.resolved ?? summary?.byStatus?.Resolved ?? 0;
  const avgHours = summary?.averageResolutionHours ?? summary?.avgResolutionHours ?? 0;

  const statusBars: BarListItem[] = summary?.byStatus
    ? Object.entries(summary.byStatus).map(([label, value]) => ({
        label: label.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        value: value ?? 0,
        colorClass:
          label.toLowerCase() === 'resolved' || label.toLowerCase() === 'closed'
            ? 'bg-success-text'
            : label.toLowerCase() === 'rejected'
              ? 'bg-danger-text'
              : 'bg-primary'
      }))
    : [];

  const categoryBars: BarListItem[] = summary?.byCategory
    ? Object.entries(summary.byCategory).map(([label, value]) => ({
        label: label.replace(/-/g, ' '),
        value: value ?? 0
      }))
    : [];

  const wardBars: BarListItem[] = summary?.byWard
    ? Object.entries(summary.byWard).map(([label, value]) => ({
        label: label.startsWith('Ward ') ? label : `Ward ${label}`,
        value: value ?? 0
      }))
    : [];

  const deptBars: BarListItem[] = summary?.byDepartment
    ? Object.entries(summary.byDepartment).map(([label, value]) => ({
        label: label.toUpperCase(),
        value: value ?? 0
      }))
    : [];

  return (
    <div className="flex flex-col gap-6 max-w-6xl mx-auto py-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold text-text">Administrator Dashboard</h1>
          <p className="text-sm text-text-muted mt-1">
            Overview of civic issue intake, resolution metrics, and system distribution.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
            loading={isFetching}
          >
            Refresh Data
          </Button>
        </div>
      </div>

      {error && (
        <ErrorNotice title="Failed to load dashboard metrics" message={(error as Error).message} />
      )}

      {isLoading ? (
        <div className="flex justify-center items-center py-16" aria-live="polite">
          <Spinner size="lg" label="Computing analytics summary..." />
        </div>
      ) : (
        <>
          {/* 4 Top KPI Stat Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <Card surface className="p-5 flex flex-col gap-1">
              <span className="text-xs font-semibold text-text-muted uppercase tracking-wider">
                Total Reports
              </span>
              <span className="text-3xl font-semibold text-text">
                {totalReports.toLocaleString()}
              </span>
              <span className="text-xs text-text-muted mt-1">Cumulative issues intake</span>
            </Card>

            <Card surface className="p-5 flex flex-col gap-1">
              <span className="text-xs font-semibold text-text-muted uppercase tracking-wider">
                Open Reports
              </span>
              <span className="text-3xl font-semibold text-text">
                {openReports.toLocaleString()}
              </span>
              <span className="text-xs text-text-muted mt-1">Awaiting or in active resolution</span>
            </Card>

            <Card surface className="p-5 flex flex-col gap-1">
              <span className="text-xs font-semibold text-text-muted uppercase tracking-wider">
                Resolved Reports
              </span>
              <span className="text-3xl font-semibold text-success-text">
                {resolvedReports.toLocaleString()}
              </span>
              <span className="text-xs text-text-muted mt-1">Successfully addressed</span>
            </Card>

            <Card surface className="p-5 flex flex-col gap-1">
              <span className="text-xs font-semibold text-text-muted uppercase tracking-wider">
                Avg Resolution Time
              </span>
              <span className="text-3xl font-semibold text-text">
                {avgHours} <span className="text-sm font-normal">hrs</span>
              </span>
              <span className="text-xs text-text-muted mt-1">Mean duration to Resolved</span>
            </Card>
          </div>

          {/* Quick Actions Bar */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Link to="/staff" className="w-full">
              <Button variant="secondary" className="w-full justify-center">
                Reports Queue
              </Button>
            </Link>
            <Link to="/admin/users" className="w-full">
              <Button variant="secondary" className="w-full justify-center">
                User Management
              </Button>
            </Link>
            <Link to="/admin/master-data" className="w-full">
              <Button variant="secondary" className="w-full justify-center">
                Master Data
              </Button>
            </Link>
            <Link to="/admin/audit" className="w-full">
              <Button variant="secondary" className="w-full justify-center">
                Audit Trail
              </Button>
            </Link>
          </div>

          {/* 4 Breakdown Sections with Pure-CSS BarList */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card surface className="p-6 flex flex-col gap-4">
              <h2 className="text-lg font-semibold text-text">Reports by Status</h2>
              <BarList items={statusBars} emptyMessage="No reports recorded yet." />
            </Card>

            <Card surface className="p-6 flex flex-col gap-4">
              <h2 className="text-lg font-semibold text-text">Reports by Category</h2>
              <BarList items={categoryBars} emptyMessage="No category distributions recorded." />
            </Card>

            <Card surface className="p-6 flex flex-col gap-4">
              <h2 className="text-lg font-semibold text-text">Reports by Ward</h2>
              <BarList items={wardBars} emptyMessage="No ward distributions recorded." />
            </Card>

            <Card surface className="p-6 flex flex-col gap-4">
              <h2 className="text-lg font-semibold text-text">Reports by Department</h2>
              <BarList items={deptBars} emptyMessage="No department distributions recorded." />
            </Card>
          </div>
        </>
      )}
    </div>
  );
};
