import { apiClient, uploadMultipart } from './client.js';
import { ImageMetadata, ImageUploadResult } from './types.js';

export async function uploadImageApi(file: File): Promise<ImageUploadResult> {
  const formData = new FormData();
  formData.append('file', file);

  return uploadMultipart<ImageUploadResult>('/images', formData, {
    requiresAuth: true
  });
}

export async function getImageMetadataApi(imageId: string): Promise<ImageMetadata> {
  return apiClient<ImageMetadata>(`/images/${imageId}`, {
    method: 'GET',
    requiresAuth: true
  });
}
