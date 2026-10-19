import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listUsersApi, createUserApi, patchUserApi } from '../../api/auth.js';
import { useAuth } from '../../auth/AuthProvider.js';
import { formatDateTime } from '../../lib/format.js';
import { Button } from '../../components/Button.js';
import { Field } from '../../components/Field.js';
import { Select } from '../../components/Select.js';
import { Spinner } from '../../components/Spinner.js';
import { ErrorNotice } from '../../components/ErrorNotice.js';
import { Pagination } from '../../components/Pagination.js';
import { FilterBar } from '../../components/FilterBar.js';
import { DataTable, Column } from '../../components/DataTable.js';
import { Badge } from '../../components/Badge.js';
import { Card } from '../../components/Card.js';
import { ConfirmPanel } from '../../components/ConfirmPanel.js';
import { ApiError } from '../../api/client.js';
import type { User, UserRole } from '../../api/types.js';

export const AdminUsersPage: React.FC = () => {
  const { user: currentUser } = useAuth();
  const queryClient = useQueryClient();

  // Filters state
  const [roleFilter, setRoleFilter] = useState('');
  const [activeFilter, setActiveFilter] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(1);

  // Create user form state
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<'officer' | 'admin'>('officer');
  const [createError, setCreateError] = useState<string | null>(null);

  // Active user action state (inline confirm)
  const [actionTarget, setActionTarget] = useState<{
    user: User;
    type: 'toggle-active' | 'change-role';
    nextRole?: UserRole;
  } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Query users
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin-users', page, roleFilter, activeFilter, searchQuery],
    queryFn: () =>
      listUsersApi({
        page,
        pageSize: 15,
        role: roleFilter || undefined,
        active: activeFilter === 'true' ? true : activeFilter === 'false' ? false : undefined,
        q: searchQuery || undefined
      })
  });

  // Create user mutation
  const createMutation = useMutation({
    mutationFn: () =>
      createUserApi({
        email: newEmail.trim(),
        displayName: newName.trim(),
        password: newPassword,
        role: newRole
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      setShowCreateForm(false);
      setNewEmail('');
      setNewName('');
      setNewPassword('');
      setNewRole('officer');
      setCreateError(null);
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError) {
        setCreateError(err.message || 'Failed to create user');
      } else {
        setCreateError((err as Error).message || 'Failed to create user');
      }
    }
  });

  // Patch user mutation
  const patchMutation = useMutation({
    mutationFn: async () => {
      if (!actionTarget) return;
      if (actionTarget.type === 'toggle-active') {
        return patchUserApi(actionTarget.user.id, {
          isActive: !actionTarget.user.isActive
        });
      }
      if (actionTarget.type === 'change-role' && actionTarget.nextRole) {
        return patchUserApi(actionTarget.user.id, {
          role: actionTarget.nextRole
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      setActionTarget(null);
      setActionError(null);
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError) {
        setActionError(err.message || 'Operation failed');
      } else {
        setActionError((err as Error).message || 'Operation failed');
      }
    }
  });

  const columns: Column<User>[] = [
    {
      key: 'name',
      header: 'User',
      render: (u) => {
        const isSelf = currentUser?.id === u.id;
        return (
          <div className="flex flex-col">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-text">{u.displayName}</span>
              {isSelf && (
                <span className="text-xs px-1.5 py-0.5 rounded-sm font-semibold bg-primary text-primary-text">
                  You
                </span>
              )}
            </div>
            <span className="text-xs text-text-muted">{u.email}</span>
          </div>
        );
      }
    },
    {
      key: 'role',
      header: 'Role',
      render: (u) => (
        <span className="capitalize text-xs font-semibold px-2 py-0.5 rounded-sm bg-surface border border-border">
          {u.role}
        </span>
      )
    },
    {
      key: 'isActive',
      header: 'Status',
      render: (u) => (
        <Badge variant={u.isActive ? 'success' : 'neutral'}>
          {u.isActive ? 'Active' : 'Inactive'}
        </Badge>
      )
    },
    {
      key: 'createdAt',
      header: 'Registered',
      render: (u) => <span className="text-xs text-text-muted">{formatDateTime(u.createdAt)}</span>
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (u) => {
        const isSelf = currentUser?.id === u.id;
        return (
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={isSelf}
              title={isSelf ? 'You cannot deactivate yourself' : undefined}
              onClick={() => {
                setActionError(null);
                setActionTarget({ user: u, type: 'toggle-active' });
              }}
            >
              {u.isActive ? 'Deactivate' : 'Activate'}
            </Button>

            <Button
              variant="ghost"
              size="sm"
              disabled={isSelf}
              title={isSelf ? 'You cannot change your own role' : undefined}
              onClick={() => {
                setActionError(null);
                const nextRole = u.role === 'admin' ? 'officer' : 'admin';
                setActionTarget({ user: u, type: 'change-role', nextRole });
              }}
            >
              Set {u.role === 'admin' ? 'Officer' : 'Admin'}
            </Button>
          </div>
        );
      }
    }
  ];

  return (
    <div className="flex flex-col gap-6 max-w-6xl mx-auto py-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold text-text">User Management</h1>
          <p className="text-sm text-text-muted mt-1">
            Manage administrative personnel, field officers, and citizens.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="primary" size="sm" onClick={() => setShowCreateForm(!showCreateForm)}>
            {showCreateForm ? 'Cancel' : '+ Add Staff User'}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => refetch()} disabled={isLoading}>
            Refresh
          </Button>
        </div>
      </div>

      {/* Create User Form Panel */}
      {showCreateForm && (
        <Card surface className="p-6 border-2 border-primary/20 flex flex-col gap-4">
          <h2 className="text-lg font-semibold text-text">Create Staff Account</h2>
          {createError && <ErrorNotice title="Failed to create user" message={createError} />}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              createMutation.mutate();
            }}
            className="grid grid-cols-1 sm:grid-cols-2 gap-4"
          >
            <Field
              id="new-user-email"
              label="Email Address"
              type="email"
              placeholder="officer@civic.test"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              required
            />
            <Field
              id="new-user-name"
              label="Full Name"
              placeholder="Jane Officer"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              required
            />
            <Field
              id="new-user-password"
              label="Initial Password"
              type="password"
              placeholder="At least 10 characters"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
            />
            <Select
              id="new-user-role"
              label="Assigned Role"
              options={[
                { value: 'officer', label: 'Department Officer' },
                { value: 'admin', label: 'Administrator' }
              ]}
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as 'officer' | 'admin')}
            />

            <div className="sm:col-span-2 flex justify-end gap-2 pt-2 border-t border-border">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setShowCreateForm(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                loading={createMutation.isPending}
                disabled={!newEmail || !newName || !newPassword}
              >
                Create Account
              </Button>
            </div>
          </form>
        </Card>
      )}

      {/* Inline Confirmation Panel for User Actions */}
      {actionTarget && (
        <ConfirmPanel
          title={
            actionTarget.type === 'toggle-active'
              ? `${actionTarget.user.isActive ? 'Deactivate' : 'Activate'} User`
              : `Change Role to ${actionTarget.nextRole}`
          }
          description={
            actionTarget.type === 'toggle-active'
              ? `Are you sure you want to ${actionTarget.user.isActive ? 'deactivate' : 'activate'} ${actionTarget.user.displayName} (${actionTarget.user.email})? Deactivated users cannot log in.`
              : `Change role of ${actionTarget.user.displayName} from ${actionTarget.user.role} to ${actionTarget.nextRole}?`
          }
          confirmVariant={
            actionTarget.type === 'toggle-active' && actionTarget.user.isActive
              ? 'danger'
              : 'primary'
          }
          isLoading={patchMutation.isPending}
          onConfirm={() => patchMutation.mutate()}
          onCancel={() => setActionTarget(null)}
        >
          {actionError && <ErrorNotice title="Action failed" message={actionError} />}
        </ConfirmPanel>
      )}

      {/* Filter Bar */}
      <FilterBar
        hasActiveFilters={Boolean(roleFilter || activeFilter || searchQuery)}
        onClear={() => {
          setRoleFilter('');
          setActiveFilter('');
          setSearchQuery('');
          setPage(1);
        }}
      >
        <Field
          id="user-search"
          label="Search"
          placeholder="Name or email"
          value={searchQuery}
          onChange={(e) => {
            setSearchQuery(e.target.value);
            setPage(1);
          }}
        />
        <Select
          id="user-role-filter"
          label="Role"
          options={[
            { value: '', label: 'All roles' },
            { value: 'citizen', label: 'Citizen' },
            { value: 'officer', label: 'Officer' },
            { value: 'admin', label: 'Admin' }
          ]}
          value={roleFilter}
          onChange={(e) => {
            setRoleFilter(e.target.value);
            setPage(1);
          }}
        />
        <Select
          id="user-status-filter"
          label="Status"
          options={[
            { value: '', label: 'All statuses' },
            { value: 'true', label: 'Active' },
            { value: 'false', label: 'Inactive' }
          ]}
          value={activeFilter}
          onChange={(e) => {
            setActiveFilter(e.target.value);
            setPage(1);
          }}
        />
      </FilterBar>

      {error && <ErrorNotice title="Failed to load users" message={(error as Error).message} />}

      {isLoading ? (
        <div className="flex justify-center items-center py-16" aria-live="polite">
          <Spinner size="lg" label="Loading users..." />
        </div>
      ) : (
        <>
          <DataTable
            columns={columns}
            data={data?.items || []}
            keyExtractor={(u) => u.id}
            emptyMessage="No users match your criteria."
          />

          {data && data.pagination && data.pagination.totalPages > 1 && (
            <div className="flex justify-center pt-4">
              <Pagination
                page={data.pagination.page}
                totalPages={data.pagination.totalPages}
                onPageChange={(p) => setPage(p)}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
};
