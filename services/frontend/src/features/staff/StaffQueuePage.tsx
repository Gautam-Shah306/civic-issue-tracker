import React from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { listStaffReportsApi } from '../../api/reports.js';
import { listDepartmentsApi, listCategoriesApi, getWardsApi } from '../../api/routing.js';
import { formatDateTime } from '../../lib/format.js';
import { StatusBadge } from '../../components/StatusBadge.js';
import { Button } from '../../components/Button.js';
import { Field } from '../../components/Field.js';
import { Select } from '../../components/Select.js';
import { Spinner } from '../../components/Spinner.js';
import { ErrorNotice } from '../../components/ErrorNotice.js';
import { Pagination } from '../../components/Pagination.js';
import { FilterBar } from '../../components/FilterBar.js';
import { DataTable, Column } from '../../components/DataTable.js';
import { CopyButton } from '../../components/CopyButton.js';
import { Card } from '../../components/Card.js';
import type { Report, ReportStatus } from '../../api/types.js';

const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'All statuses' },
  { value: 'Submitted', label: 'Submitted' },
  { value: 'Verified', label: 'Verified' },
  { value: 'Assigned', label: 'Assigned' },
  { value: 'In Progress', label: 'In Progress' },
  { value: 'Resolved', label: 'Resolved' },
  { value: 'Closed', label: 'Closed' },
  { value: 'Rejected', label: 'Rejected' },
  { value: 'Reopened', label: 'Reopened' }
];

const SORT_OPTIONS = [
  { value: 'created_at:desc', label: 'Newest first' },
  { value: 'created_at:asc', label: 'Oldest first' },
  { value: 'updated_at:desc', label: 'Recently updated' },
  { value: 'updated_at:asc', label: 'Least recently updated' }
];

export const StaffQueuePage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();

  const statusParam = (searchParams.get('status') || '') as ReportStatus | '';
  const categoryParam = searchParams.get('category') || '';
  const departmentParam = searchParams.get('department') || '';
  const wardParam = searchParams.get('ward') || '';
  const qParam = searchParams.get('q') || '';
  const sortParam = searchParams.get('sort') || 'created_at:desc';
  const pageParam = parseInt(searchParams.get('page') || '1', 10);

  // Fetch routing metadata for filters
  const { data: departments = [] } = useQuery({
    queryKey: ['departments', 'active'],
    queryFn: () => listDepartmentsApi(false)
  });

  const { data: categories = [] } = useQuery({
    queryKey: ['categories', 'active'],
    queryFn: () => listCategoriesApi(false)
  });

  const { data: wardsData } = useQuery({
    queryKey: ['wards'],
    queryFn: () => getWardsApi()
  });

  const wards =
    wardsData?.features.map((f) => ({
      code: f.properties.code,
      name: f.properties.name
    })) || [];

  // Fetch paginated reports
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: [
      'staff-reports',
      pageParam,
      statusParam,
      categoryParam,
      departmentParam,
      wardParam,
      qParam,
      sortParam
    ],
    queryFn: () =>
      listStaffReportsApi({
        page: pageParam,
        pageSize: 15,
        status: statusParam ? statusParam : undefined,
        category: categoryParam || undefined,
        department: departmentParam || undefined,
        ward: wardParam || undefined,
        q: qParam || undefined,
        sort: sortParam
      })
  });

  const updateParam = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) {
      next.set(key, value);
    } else {
      next.delete(key);
    }
    if (key !== 'page') {
      next.delete('page'); // Reset to page 1 on filter changes
    }
    setSearchParams(next);
  };

  const handleClearFilters = () => {
    setSearchParams(new URLSearchParams());
  };

  const hasActiveFilters = Boolean(
    statusParam || categoryParam || departmentParam || wardParam || qParam
  );

  const columns: Column<Report>[] = [
    {
      key: 'id',
      header: 'ID',
      render: (r) => (
        <div className="flex items-center gap-1 font-mono text-xs">
          <span>{r.id.substring(0, 8)}</span>
          <CopyButton text={r.id} label="Copy" ariaLabel={`Copy ID ${r.id}`} />
        </div>
      )
    },
    {
      key: 'title',
      header: 'Title & Summary',
      render: (r) => (
        <div className="flex flex-col">
          <Link
            to={`/staff/reports/${r.id}`}
            className="font-medium text-text hover:text-primary hover:underline line-clamp-1"
          >
            {r.title}
          </Link>
          <span className="text-xs text-text-muted capitalize">
            {r.category.replace(/-/g, ' ')}
            {r.wardCode ? ` • Ward ${r.wardCode}` : ''}
          </span>
        </div>
      )
    },
    {
      key: 'departmentCode',
      header: 'Department',
      render: (r) => (
        <span className="text-xs font-medium text-text-muted uppercase">
          {r.departmentCode || '—'}
        </span>
      )
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => <StatusBadge status={r.status} />
    },
    {
      key: 'createdAt',
      header: 'Submitted',
      render: (r) => (
        <span className="text-xs text-text-muted whitespace-nowrap">
          {formatDateTime(r.createdAt)}
        </span>
      )
    },
    {
      key: 'actions',
      header: 'Action',
      render: (r) => (
        <Link to={`/staff/reports/${r.id}`}>
          <Button variant="secondary" size="sm">
            Review
          </Button>
        </Link>
      )
    }
  ];

  return (
    <div className="flex flex-col gap-6 max-w-6xl mx-auto py-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold text-text">Staff Queue</h1>
          <p className="text-sm text-text-muted mt-1">
            Review, verify, and progress municipal civic issue reports.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => refetch()} disabled={isLoading}>
          Refresh
        </Button>
      </div>

      <FilterBar hasActiveFilters={hasActiveFilters} onClear={handleClearFilters}>
        <Field
          id="search-query"
          label="Search"
          placeholder="Keywords in title or description"
          value={qParam}
          onChange={(e) => updateParam('q', e.target.value)}
        />

        <Select
          id="status-filter"
          label="Status"
          options={STATUS_OPTIONS}
          value={statusParam}
          onChange={(e) => updateParam('status', e.target.value)}
        />

        <Select
          id="category-filter"
          label="Category"
          options={[
            { value: '', label: 'All categories' },
            ...categories.map((c) => ({
              value: c.code,
              label: c.name
            }))
          ]}
          value={categoryParam}
          onChange={(e) => updateParam('category', e.target.value)}
        />

        <Select
          id="department-filter"
          label="Department"
          options={[
            { value: '', label: 'All departments' },
            ...departments.map((d) => ({
              value: d.code,
              label: d.name
            }))
          ]}
          value={departmentParam}
          onChange={(e) => updateParam('department', e.target.value)}
        />

        <Select
          id="ward-filter"
          label="Ward"
          options={[
            { value: '', label: 'All wards' },
            ...wards.map((w) => ({
              value: w.code,
              label: `${w.code} - ${w.name}`
            }))
          ]}
          value={wardParam}
          onChange={(e) => updateParam('ward', e.target.value)}
        />

        <Select
          id="sort-filter"
          label="Sort by"
          options={SORT_OPTIONS}
          value={sortParam}
          onChange={(e) => updateParam('sort', e.target.value)}
        />
      </FilterBar>

      {error && (
        <ErrorNotice title="Failed to load staff queue" message={(error as Error).message} />
      )}

      {isLoading ? (
        <div className="flex justify-center items-center py-16" aria-live="polite">
          <Spinner size="lg" label="Loading reports queue..." />
        </div>
      ) : (
        <>
          {/* Desktop Table View */}
          <div className="hidden md:block">
            <DataTable
              columns={columns}
              data={data?.items || []}
              keyExtractor={(r) => r.id}
              emptyMessage="No reports match your selected filters."
            />
          </div>

          {/* Mobile Card View */}
          <div className="flex flex-col gap-3 md:hidden">
            {(data?.items || []).length === 0 ? (
              <Card surface className="text-center p-6 text-sm text-text-muted">
                No reports match your selected filters.
              </Card>
            ) : (
              (data?.items || []).map((r) => (
                <Card key={r.id} surface className="p-4 flex flex-col gap-3">
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-mono text-xs text-text-muted">
                      #{r.id.substring(0, 8)}
                    </span>
                    <StatusBadge status={r.status} />
                  </div>
                  <div>
                    <Link
                      to={`/staff/reports/${r.id}`}
                      className="text-base font-semibold text-text hover:underline"
                    >
                      {r.title}
                    </Link>
                    <p className="text-xs text-text-muted mt-1 capitalize">
                      {r.category.replace(/-/g, ' ')}
                      {r.departmentCode ? ` • ${r.departmentCode.toUpperCase()}` : ''}
                      {r.wardCode ? ` • Ward ${r.wardCode}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center justify-between text-xs text-text-muted pt-2 border-t border-border">
                    <span>{formatDateTime(r.createdAt)}</span>
                    <Link to={`/staff/reports/${r.id}`}>
                      <Button variant="secondary" size="sm">
                        Review
                      </Button>
                    </Link>
                  </div>
                </Card>
              ))
            )}
          </div>

          {/* Pagination */}
          {data && data.pagination && data.pagination.totalPages > 1 && (
            <div className="flex justify-center pt-4">
              <Pagination
                page={data.pagination.page}
                totalPages={data.pagination.totalPages}
                onPageChange={(p) => updateParam('page', String(p))}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
};
