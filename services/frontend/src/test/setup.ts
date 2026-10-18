import '@testing-library/jest-dom/vitest';
import { vi, beforeEach } from 'vitest';
import React from 'react';

vi.mock('leaflet', async () => {
  const actual = await vi.importActual<any>('leaflet');
  return {
    ...actual,
    default: {
      ...actual.default,
      Icon: {
        Default: {
          prototype: {},
          mergeOptions: vi.fn()
        }
      },
      divIcon: vi.fn().mockImplementation((opts) => ({ ...opts, _isDivIcon: true }))
    }
  };
});

vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }: any) =>
    React.createElement('div', { 'data-testid': 'map-container' }, children),
  TileLayer: () => React.createElement('div', { 'data-testid': 'tile-layer' }),
  Marker: ({ children, position }: any) =>
    React.createElement(
      'div',
      { 'data-testid': 'map-marker', 'data-position': JSON.stringify(position) },
      children
    ),
  Popup: ({ children }: any) =>
    React.createElement('div', { 'data-testid': 'marker-popup' }, children),
  GeoJSON: ({ data }: any) =>
    React.createElement('div', {
      'data-testid': 'geojson-layer',
      'data-features': data?.features?.length
    }),
  useMapEvents: () => ({
    getBounds: () => ({
      getSouthWest: () => ({ lat: 23.0, lng: 72.5 }),
      getNorthEast: () => ({ lat: 23.1, lng: 72.6 })
    })
  })
}));

beforeEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});
