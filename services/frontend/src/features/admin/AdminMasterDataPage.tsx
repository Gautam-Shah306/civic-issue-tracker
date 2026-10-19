import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { MapContainer, TileLayer, GeoJSON } from 'react-leaflet';
import {
  listDepartmentsApi,
  createDepartmentApi,
  patchDepartmentApi,
  listCategoriesApi,
  createCategoryApi,
  patchCategoryApi,
  getWardsApi,
  patchWardApi
} from '../../api/routing.js';
import { fixLeafletDefaultIcons } from '../../lib/geo.js';
import { Tabs, TabItem } from '../../components/Tabs.js';
import { DataTable, Column } from '../../components/DataTable.js';
import { Badge } from '../../components/Badge.js';
import { Button } from '../../components/Button.js';
import { Card } from '../../components/Card.js';
import { Field } from '../../components/Field.js';
import { Select } from '../../components/Select.js';
import { Spinner } from '../../components/Spinner.js';
import { ErrorNotice } from '../../components/ErrorNotice.js';
import { ConfirmPanel } from '../../components/ConfirmPanel.js';
import { ApiError } from '../../api/client.js';
import type { Department, RoutingCategory, Ward } from '../../api/types.js';

const MASTER_TABS: TabItem[] = [
  { id: 'categories', label: 'Categories' },
  { id: 'departments', label: 'Departments' },
  { id: 'wards', label: 'Wards' }
];

export const AdminMasterDataPage: React.FC = () => {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState('categories');

  useEffect(() => {
    fixLeafletDefaultIcons();
  }, []);

  // Category state
  const [showCatForm, setShowCatForm] = useState(false);
  const [catSlug, setCatSlug] = useState('');
  const [catName, setCatName] = useState('');
  const [catDept, setCatDept] = useState('');
  const [catError, setCatError] = useState<string | null>(null);

  // Department state
  const [showDeptForm, setShowDeptForm] = useState(false);
  const [deptCode, setDeptCode] = useState('');
  const [deptName, setDeptName] = useState('');
  const [deptEmail, setDeptEmail] = useState('');
  const [deptError, setDeptError] = useState<string | null>(null);

  // Ward edit state
  const [editingWard, setEditingWard] = useState<Ward | null>(null);
  const [wardName, setWardName] = useState('');
  const [wardActive, setWardActive] = useState(true);
  const [wardError, setWardError] = useState<string | null>(null);

  // Fetch all departments (all=true)
  const { data: departments = [], isLoading: loadingDepts } = useQuery({
    queryKey: ['departments', 'all'],
    queryFn: () => listDepartmentsApi(true)
  });

  // Fetch all categories (all=true)
  const { data: categories = [], isLoading: loadingCats } = useQuery({
    queryKey: ['categories', 'all'],
    queryFn: () => listCategoriesApi(true)
  });

  // Fetch wards GeoJSON
  const { data: wardsData, isLoading: loadingWards } = useQuery({
    queryKey: ['wards'],
    queryFn: () => getWardsApi()
  });

  const wards: Ward[] =
    wardsData?.features.map((f) => ({
      code: f.properties.code,
      name: f.properties.name,
      active: f.properties.active !== false,
      geometry: f.geometry
    })) || [];

  // Create category mutation
  const createCategoryMutation = useMutation({
    mutationFn: () =>
      createCategoryApi({
        slug: catSlug.trim().toLowerCase(),
        name: catName.trim(),
        departmentCode: catDept,
        active: true
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['categories'] });
      setShowCatForm(false);
      setCatSlug('');
      setCatName('');
      setCatDept('');
      setCatError(null);
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError) {
        setCatError(err.message || 'Failed to create category');
      } else {
        setCatError((err as Error).message || 'Failed to create category');
      }
    }
  });

  // Toggle category active mutation
  const toggleCategoryMutation = useMutation({
    mutationFn: (cat: RoutingCategory) =>
      patchCategoryApi(cat.code || (cat as unknown as { slug: string }).slug, {
        active: !cat.active
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['categories'] });
    }
  });

  // Create department mutation
  const createDepartmentMutation = useMutation({
    mutationFn: () =>
      createDepartmentApi({
        code: deptCode.trim().toLowerCase(),
        name: deptName.trim(),
        email: deptEmail.trim().toLowerCase(),
        active: true
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['departments'] });
      setShowDeptForm(false);
      setDeptCode('');
      setDeptName('');
      setDeptEmail('');
      setDeptError(null);
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError) {
        setDeptError(err.message || 'Failed to create department');
      } else {
        setDeptError((err as Error).message || 'Failed to create department');
      }
    }
  });

  // Toggle department active mutation
  const toggleDeptMutation = useMutation({
    mutationFn: (dept: Department) =>
      patchDepartmentApi(dept.code, {
        active: !dept.active
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['departments'] });
    }
  });

  // Patch ward mutation
  const patchWardMutation = useMutation({
    mutationFn: () => {
      if (!editingWard) throw new Error('No ward selected');
      return patchWardApi(editingWard.code, {
        name: wardName.trim(),
        active: wardActive
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['wards'] });
      setEditingWard(null);
      setWardError(null);
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError) {
        setWardError(err.message || 'Failed to update ward');
      } else {
        setWardError((err as Error).message || 'Failed to update ward');
      }
    }
  });

  // Column definitions
  const categoryColumns: Column<RoutingCategory>[] = [
    {
      key: 'code',
      header: 'Code / Slug',
      render: (c) => (
        <span className="font-mono text-xs font-semibold">
          {c.code || (c as unknown as { slug: string }).slug}
        </span>
      )
    },
    {
      key: 'name',
      header: 'Name',
      render: (c) => <span className="font-medium text-text">{c.name}</span>
    },
    {
      key: 'departmentCode',
      header: 'Department',
      render: (c) => (
        <span className="uppercase text-xs font-medium text-text-muted">{c.departmentCode}</span>
      )
    },
    {
      key: 'active',
      header: 'Status',
      render: (c) => (
        <Badge variant={c.active ? 'success' : 'neutral'}>{c.active ? 'Active' : 'Inactive'}</Badge>
      )
    },
    {
      key: 'actions',
      header: 'Action',
      render: (c) => (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => toggleCategoryMutation.mutate(c)}
          disabled={toggleCategoryMutation.isPending}
        >
          {c.active ? 'Deactivate' : 'Activate'}
        </Button>
      )
    }
  ];

  const departmentColumns: Column<Department>[] = [
    {
      key: 'code',
      header: 'Code',
      render: (d) => <span className="font-mono text-xs uppercase font-semibold">{d.code}</span>
    },
    {
      key: 'name',
      header: 'Department Name',
      render: (d) => <span className="font-medium text-text">{d.name}</span>
    },
    {
      key: 'email',
      header: 'Notification Email',
      render: (d) => <span className="text-xs text-text-muted">{d.email}</span>
    },
    {
      key: 'active',
      header: 'Status',
      render: (d) => (
        <Badge variant={d.active ? 'success' : 'neutral'}>{d.active ? 'Active' : 'Inactive'}</Badge>
      )
    },
    {
      key: 'actions',
      header: 'Action',
      render: (d) => (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => toggleDeptMutation.mutate(d)}
          disabled={toggleDeptMutation.isPending}
        >
          {d.active ? 'Deactivate' : 'Activate'}
        </Button>
      )
    }
  ];

  const wardColumns: Column<Ward>[] = [
    {
      key: 'code',
      header: 'Ward Code',
      render: (w) => <span className="font-mono text-xs font-semibold">{w.code}</span>
    },
    {
      key: 'name',
      header: 'Ward Name',
      render: (w) => <span className="font-medium text-text">{w.name}</span>
    },
    {
      key: 'active',
      header: 'Status',
      render: (w) => (
        <Badge variant={w.active ? 'success' : 'neutral'}>{w.active ? 'Active' : 'Inactive'}</Badge>
      )
    },
    {
      key: 'actions',
      header: 'Action',
      render: (w) => (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setEditingWard(w);
            setWardName(w.name);
            setWardActive(w.active);
            setWardError(null);
          }}
        >
          Edit
        </Button>
      )
    }
  ];

  return (
    <div className="flex flex-col gap-6 max-w-6xl mx-auto py-4">
      <div>
        <h1 className="text-3xl font-semibold text-text">Master Data Management</h1>
        <p className="text-sm text-text-muted mt-1">
          Maintain municipal service categories, department routes, and ward jurisdictions.
        </p>
      </div>

      <Tabs tabs={MASTER_TABS} activeTab={activeTab} onChange={(tabId) => setActiveTab(tabId)} />

      {/* Categories Tab */}
      {activeTab === 'categories' && (
        <div className="flex flex-col gap-6" id="tabpanel-categories">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold text-text">Categories</h2>
            <Button variant="primary" size="sm" onClick={() => setShowCatForm(!showCatForm)}>
              {showCatForm ? 'Cancel' : '+ New Category'}
            </Button>
          </div>

          {showCatForm && (
            <Card surface className="p-6 border-2 border-primary/20 flex flex-col gap-4">
              <h3 className="text-base font-semibold text-text">Create Category</h3>
              {catError && <ErrorNotice title="Failed to create category" message={catError} />}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  createCategoryMutation.mutate();
                }}
                className="grid grid-cols-1 sm:grid-cols-3 gap-4"
              >
                <Field
                  id="cat-slug"
                  label="Category Slug"
                  placeholder="e.g. traffic-light"
                  value={catSlug}
                  onChange={(e) => setCatSlug(e.target.value)}
                  hint="lowercase letters, numbers, hyphens"
                  required
                />
                <Field
                  id="cat-name"
                  label="Display Name"
                  placeholder="Traffic Light Malfunction"
                  value={catName}
                  onChange={(e) => setCatName(e.target.value)}
                  required
                />
                <Select
                  id="cat-dept"
                  label="Department Route"
                  options={[
                    { value: '', label: '-- Select Department --' },
                    ...departments.map((d) => ({
                      value: d.code,
                      label: `${d.name} (${d.code})`
                    }))
                  ]}
                  value={catDept}
                  onChange={(e) => setCatDept(e.target.value)}
                  required
                />

                <div className="sm:col-span-3 flex justify-end gap-2 pt-2 border-t border-border">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => setShowCatForm(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    variant="primary"
                    size="sm"
                    disabled={!catSlug || !catName || !catDept}
                    loading={createCategoryMutation.isPending}
                  >
                    Save Category
                  </Button>
                </div>
              </form>
            </Card>
          )}

          {loadingCats ? (
            <div className="py-12 flex justify-center">
              <Spinner size="lg" label="Loading categories..." />
            </div>
          ) : (
            <DataTable
              columns={categoryColumns}
              data={categories}
              keyExtractor={(c) => c.code || (c as unknown as { slug: string }).slug}
              emptyMessage="No categories defined."
            />
          )}
        </div>
      )}

      {/* Departments Tab */}
      {activeTab === 'departments' && (
        <div className="flex flex-col gap-6" id="tabpanel-departments">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold text-text">Departments</h2>
            <Button variant="primary" size="sm" onClick={() => setShowDeptForm(!showDeptForm)}>
              {showDeptForm ? 'Cancel' : '+ New Department'}
            </Button>
          </div>

          {showDeptForm && (
            <Card surface className="p-6 border-2 border-primary/20 flex flex-col gap-4">
              <h3 className="text-base font-semibold text-text">Create Department</h3>
              {deptError && <ErrorNotice title="Failed to create department" message={deptError} />}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  createDepartmentMutation.mutate();
                }}
                className="grid grid-cols-1 sm:grid-cols-3 gap-4"
              >
                <Field
                  id="dept-code"
                  label="Department Code"
                  placeholder="e.g. parks"
                  value={deptCode}
                  onChange={(e) => setDeptCode(e.target.value)}
                  hint="lowercase letters, numbers, hyphens"
                  required
                />
                <Field
                  id="dept-name"
                  label="Department Name"
                  placeholder="Parks & Recreation"
                  value={deptName}
                  onChange={(e) => setDeptName(e.target.value)}
                  required
                />
                <Field
                  id="dept-email"
                  label="Contact Email"
                  type="email"
                  placeholder="parks@civic.test"
                  value={deptEmail}
                  onChange={(e) => setDeptEmail(e.target.value)}
                  required
                />

                <div className="sm:col-span-3 flex justify-end gap-2 pt-2 border-t border-border">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => setShowDeptForm(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    variant="primary"
                    size="sm"
                    disabled={!deptCode || !deptName || !deptEmail}
                    loading={createDepartmentMutation.isPending}
                  >
                    Save Department
                  </Button>
                </div>
              </form>
            </Card>
          )}

          {loadingDepts ? (
            <div className="py-12 flex justify-center">
              <Spinner size="lg" label="Loading departments..." />
            </div>
          ) : (
            <DataTable
              columns={departmentColumns}
              data={departments}
              keyExtractor={(d) => d.code}
              emptyMessage="No departments defined."
            />
          )}
        </div>
      )}

      {/* Wards Tab */}
      {activeTab === 'wards' && (
        <div className="flex flex-col gap-6" id="tabpanel-wards">
          <h2 className="text-xl font-semibold text-text">Wards Jurisdiction</h2>

          {editingWard && (
            <ConfirmPanel
              title={`Edit Ward ${editingWard.code}`}
              description="Update the ward name or operational availability."
              confirmLabel="Save Changes"
              isLoading={patchWardMutation.isPending}
              onConfirm={() => patchWardMutation.mutate()}
              onCancel={() => setEditingWard(null)}
            >
              {wardError && <ErrorNotice title="Failed to update ward" message={wardError} />}
              <Field
                id="edit-ward-name"
                label="Ward Name"
                value={wardName}
                onChange={(e) => setWardName(e.target.value)}
                required
              />
              <Select
                id="edit-ward-active"
                label="Operational Status"
                options={[
                  { value: 'true', label: 'Active' },
                  { value: 'false', label: 'Inactive' }
                ]}
                value={wardActive ? 'true' : 'false'}
                onChange={(e) => setWardActive(e.target.value === 'true')}
              />
            </ConfirmPanel>
          )}

          {/* Interactive GeoJSON Map Preview */}
          <Card surface className="p-4 flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-text">Synthetic Ward Boundaries Map</h3>
            <p className="text-xs text-text-muted">
              Click a ward polygon to inspect jurisdiction boundary.
            </p>
            <div className="h-80 rounded-lg overflow-hidden border border-border">
              {wardsData ? (
                <MapContainer
                  center={[23.05, 72.58]}
                  zoom={11}
                  className="w-full h-full"
                  scrollWheelZoom={false}
                >
                  <TileLayer
                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                  />
                  <GeoJSON
                    data={wardsData as any}
                    style={() => ({
                      color: 'var(--color-border-strong, gray)',
                      weight: 1.5,
                      fillOpacity: 0.1
                    })}
                    onEachFeature={(feature, layer) => {
                      layer.bindPopup(
                        `<strong>Ward: ${feature.properties.code}</strong><br/>${feature.properties.name}`
                      );
                    }}
                  />
                </MapContainer>
              ) : (
                <div className="h-full flex items-center justify-center text-xs text-text-muted">
                  Loading ward boundaries...
                </div>
              )}
            </div>
          </Card>

          {loadingWards ? (
            <div className="py-12 flex justify-center">
              <Spinner size="lg" label="Loading wards..." />
            </div>
          ) : (
            <DataTable
              columns={wardColumns}
              data={wards}
              keyExtractor={(w) => w.code}
              emptyMessage="No wards defined."
            />
          )}
        </div>
      )}
    </div>
  );
};
