import { apiClient } from './client.js';
import { GeoJSONFeatureCollection } from './types.js';

export async function getWardsApi(): Promise<GeoJSONFeatureCollection> {
  return apiClient<GeoJSONFeatureCollection>('/routing/wards', {
    method: 'GET',
    requiresAuth: false
  });
}
