import L from 'leaflet';
import iconRetinaUrl from 'leaflet/dist/images/marker-icon-2x.png';
import iconUrl from 'leaflet/dist/images/marker-icon.png';
import shadowUrl from 'leaflet/dist/images/marker-shadow.png';
import { ReportStatus } from '../api/types.js';

let iconsFixed = false;
export function fixLeafletDefaultIcons(): void {
  if (iconsFixed) return;
  iconsFixed = true;
  delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: unknown })._getIconUrl;
  L.Icon.Default.mergeOptions({
    iconRetinaUrl,
    iconUrl,
    shadowUrl
  });
}

export function formatCoordinates(lat: number, lng: number): string {
  return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
}

export function boundsToBboxString(bounds: L.LatLngBounds): string {
  const sw = bounds.getSouthWest();
  const ne = bounds.getNorthEast();
  // minLng,minLat,maxLng,maxLat
  return `${sw.lng.toFixed(4)},${sw.lat.toFixed(4)},${ne.lng.toFixed(4)},${ne.lat.toFixed(4)}`;
}

export function getStatusMarkerClass(status: ReportStatus): string {
  switch (status) {
    case 'Resolved':
      return 'bg-success-bg text-success-text border-success-text';
    case 'Verified':
    case 'Assigned':
      return 'bg-info-bg text-info-text border-info-text';
    case 'In Progress':
    case 'Reopened':
      return 'bg-warning-bg text-warning-text border-warning-text';
    case 'Rejected':
      return 'bg-danger-bg text-danger-text border-danger-text';
    case 'Submitted':
    case 'Closed':
    default:
      return 'bg-neutral-bg text-neutral-text border-neutral-text';
  }
}

export function createStatusMarkerIcon(status: ReportStatus): L.DivIcon {
  const colorClasses = getStatusMarkerClass(status);
  return L.divIcon({
    className: 'custom-status-marker',
    html: `<div class="w-6 h-6 rounded-md border flex items-center justify-center font-semibold text-xs shadow-sm ${colorClasses}">●</div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    popupAnchor: [0, -12]
  });
}
