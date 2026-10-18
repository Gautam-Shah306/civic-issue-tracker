import React, { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { getMineReportsApi } from '../../api/reports.js';
import { ReportStatus } from '../../api/types.js';
import { formatDateTime } from '../../lib/format.js';
import { StatusBadge } from '../../components/StatusBadge.js';
import { Button } from '../../components/Button.js';
import { Card } from '../../components/Card.js';
import { Select } from '../../components/Select.js';
import { Pagination } from '../../components/Pagination.js';
import { Spinner } from '../../components/Spinner.js';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorNotice } from '../../components/ErrorNotice.js';

export const MyReportsPage: React.FC = () => {
  const [page, setPage] = useState<number>(1);
  const [statusFilter, setStatusFilter] = useState<string>('');

  const {
    data: reportsData,
    isLoading,
    isError,
    refetch
  } = useQuery({
    queryKey: ['reports', 'mine', page, statusFilter],
    queryFn: () =>
      getMineReportsApi({
        page,
        pageSize: 10,
        status: (statusFilter as ReportStatus) || undefined
      })
  });

  const reports = reportsData?.items || [];
  const pagination = reportsData?.pagination;
  const totalPages = pagination?.totalPages || 1;

  const statusOptions = [
    { value: '', label: 'All Statuses' },
    { value: 'Submitted', label: 'Submitted' },
    { value: 'Verified', label: 'Verified' },
    { value: 'Assigned', label: 'Assigned' },
    { value: 'In Progress', label: 'In Progress' },
    { value: 'Resolved', label: 'Resolved' },
    { value: 'Closed', label: 'Closed' },
    { value: 'Rejected', label: 'Rejected' },
    { value: 'Reopened', label: 'Reopened' }
  ];

  return (
    <div className="flex flex-col gap-6 max-w-4xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-semibold text-text">My Reports</h1>
          <p className="text-sm text-text-muted mt-1">
            Track and manage all civic issues you have submitted.
          </p>
        </div>
        <Link to="/submit">
          <Button variant="primary" size="md">
            Submit New Report
          </Button>
        </Link>
      </div>

      {/* Filter bar */}
      <Card surface className="flex items-end justify-between gap-4">
        <div className="w-48">
          <Select
            id="my-status-filter"
            label="Filter by Status"
            options={statusOptions}
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(1);
            }}
            controlSize="sm"
          />
        </div>
      </Card>

      {/* Content */}
      {isLoading ? (
        <div className="flex justify-center items-center py-16" aria-live="polite">
          <Spinner size="lg" label="Loading your reports..." />
        </div>
      ) : isError ? (
        <ErrorNotice
          title="Failed to Load Reports"
          message="Could not load your submitted reports."
          onRetry={() => refetch()}
        />
      ) : reports.length === 0 ? (
        <EmptyState
          title="No reports found"
          description={
            statusFilter
              ? 'No reports match the selected status filter.'
              : 'You have not submitted any civic reports yet.'
          }
          action={
            <Link to="/submit">
              <Button variant="primary" size="sm">
                Submit Your First Report
              </Button>
            </Link>
          }
        />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-3">
            {reports.map((report) => (
              <Card
                key={report.id}
                className="flex flex-col sm:flex-row sm:items-center justify-between gap-4"
              >
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2 mb-1">
                    <StatusBadge status={report.status} />
                    <span className="text-xs uppercase font-medium text-text-muted">
                      {report.category}
                    </span>
                    {report.wardCode && (
                      <span className="text-xs text-text-muted">• Ward: {report.wardCode}</span>
                    )}
                  </div>
                  <Link
                    to={`/my/${report.id}`}
                    className="text-base font-semibold text-text hover:underline"
                  >
                    {report.title}
                  </Link>
                  <span className="text-xs text-text-muted">
                    Reported on {formatDateTime(report.createdAt)}
                    {report.address && ` • ${report.address}`}
                  </span>
                </div>

                <div className="flex sm:flex-col items-center sm:items-end justify-between sm:justify-center gap-2">
                  <Link to={`/my/${report.id}`}>
                    <Button variant="secondary" size="sm">
                      View Status &rarr;
                    </Button>
                  </Link>
                </div>
              </Card>
            ))}
          </div>

          <Pagination
            page={page}
            totalPages={totalPages}
            onPageChange={(newPage) => setPage(newPage)}
          />
        </div>
      )}
    </div>
  );
};
