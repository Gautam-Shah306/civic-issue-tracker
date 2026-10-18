import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { MapContainer, TileLayer, Marker, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import { getPublicCategoriesApi } from '../../api/public.js';
import { submitReportApi } from '../../api/reports.js';
import { getImageMetadataApi, uploadImageApi } from '../../api/images.js';
import { Report } from '../../api/types.js';
import { fixLeafletDefaultIcons, formatCoordinates } from '../../lib/geo.js';
import { Button } from '../../components/Button.js';
import { Card } from '../../components/Card.js';
import { Field } from '../../components/Field.js';
import { TextArea } from '../../components/TextArea.js';
import { Select } from '../../components/Select.js';
import { StatusBadge } from '../../components/StatusBadge.js';
import { ErrorNotice } from '../../components/ErrorNotice.js';
import { Spinner } from '../../components/Spinner.js';
import { ApiError } from '../../api/client.js';

// Interactive pin drop on click
function LocationMarker({
  position,
  onChange
}: {
  position: { lat: number; lng: number };
  onChange: (pos: { lat: number; lng: number }) => void;
}) {
  const markerRef = useRef<L.Marker>(null);

  useMapEvents({
    click(e) {
      onChange({ lat: e.latlng.lat, lng: e.latlng.lng });
    }
  });

  const eventHandlers = useMemo(
    () => ({
      dragend() {
        const marker = markerRef.current;
        if (marker != null) {
          const latlng = marker.getLatLng();
          onChange({ lat: latlng.lat, lng: latlng.lng });
        }
      }
    }),
    [onChange]
  );

  return (
    <Marker
      draggable={true}
      eventHandlers={eventHandlers}
      position={[position.lat, position.lng]}
      ref={markerRef}
    />
  );
}

export const SubmitReportPage: React.FC = () => {
  useEffect(() => {
    fixLeafletDefaultIcons();
  }, []);

  const [currentStep, setCurrentStep] = useState<number>(1);

  // Form State
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [location, setLocation] = useState<{ lat: number; lng: number }>({
    lat: 23.03,
    lng: 72.58
  });
  const [address, setAddress] = useState('');

  // Photo State
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [photoId, setPhotoId] = useState<string | null>(null);
  const [uploadStatus, setUploadStatus] = useState<
    'idle' | 'uploading' | 'processing' | 'ready' | 'rejected' | 'timeout'
  >('idle');
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [photoError, setPhotoError] = useState<string | null>(null);

  // Submission State
  const [stepErrors, setStepErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [createdReport, setCreatedReport] = useState<Report | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState<string>(() => crypto.randomUUID());

  // Geolocation error
  const [geoError, setGeoError] = useState<string | null>(null);
  const [isLocating, setIsLocating] = useState<boolean>(false);

  // Fetch categories
  const { data: categories = [], isLoading: isCatLoading } = useQuery({
    queryKey: ['public', 'categories'],
    queryFn: getPublicCategoriesApi
  });

  const categoryOptions = useMemo(() => {
    return [
      { value: '', label: '-- Select a category --' },
      ...categories.map((c) => ({ value: c.slug, label: c.name }))
    ];
  }, [categories]);

  // Clean preview URL on unmount
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  // Geolocation handler
  const handleUseMyLocation = () => {
    setGeoError(null);
    if (!navigator.geolocation) {
      setGeoError('Geolocation is not supported by your browser.');
      return;
    }
    setIsLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocation({
          lat: Number(pos.coords.latitude.toFixed(6)),
          lng: Number(pos.coords.longitude.toFixed(6))
        });
        setIsLocating(false);
      },
      (err) => {
        setIsLocating(false);
        if (err.code === err.PERMISSION_DENIED) {
          setGeoError('Location permission was denied. You can manually drag the pin on the map.');
        } else if (err.code === err.POSITION_UNAVAILABLE) {
          setGeoError('Location information is currently unavailable.');
        } else {
          setGeoError('Location request timed out. Please select location on the map.');
        }
      },
      { timeout: 10000, enableHighAccuracy: true }
    );
  };

  // Step 1 validation
  const validateStep1 = (): boolean => {
    const errors: Record<string, string> = {};
    if (!title.trim()) {
      errors.title = 'Title is required';
    } else if (title.trim().length > 120) {
      errors.title = 'Title cannot exceed 120 characters';
    }

    if (!category) {
      errors.category = 'Please select an issue category';
    }

    if (description.length > 2000) {
      errors.description = 'Description cannot exceed 2000 characters';
    }

    setStepErrors(errors);
    return Object.keys(errors).length === 0;
  };

  // Step 2 validation
  const validateStep2 = (): boolean => {
    const errors: Record<string, string> = {};
    if (location.lat < -90 || location.lat > 90) {
      errors.lat = 'Latitude must be between -90 and 90';
    }
    if (location.lng < -180 || location.lng > 180) {
      errors.lng = 'Longitude must be between -180 and 180';
    }
    if (address.length > 300) {
      errors.address = 'Address cannot exceed 300 characters';
    }
    setStepErrors(errors);
    return Object.keys(errors).length === 0;
  };

  // Handle Photo selection and processing
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPhotoError(null);
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate type: JPEG, PNG, WebP
    const validTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!validTypes.includes(file.type)) {
      setPhotoError('Invalid image format. Allowed formats are JPEG, PNG, and WebP.');
      return;
    }

    // Validate size: 8 MiB
    if (file.size > 8 * 1024 * 1024) {
      setPhotoError('Image size exceeds 8 MiB limit. Please choose a smaller photo.');
      return;
    }

    setSelectedFile(file);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(URL.createObjectURL(file));
    setPhotoId(null);
    setUploadStatus('idle');
  };

  // Upload and poll photo
  const handleUploadPhoto = async () => {
    if (!selectedFile) return;
    setPhotoError(null);
    setUploadStatus('uploading');
    setUploadProgress(10);

    try {
      const res = await uploadImageApi(selectedFile);
      const uploadedImageId = res.imageId;
      setUploadStatus('processing');

      // Poll up to 30 seconds (1s interval)
      let attempts = 0;
      const maxAttempts = 30;

      const pollInterval = setInterval(async () => {
        attempts++;
        setUploadProgress(Math.min(95, 10 + Math.round((attempts / maxAttempts) * 85)));

        try {
          const meta = await getImageMetadataApi(uploadedImageId);
          if (meta.status === 'ready') {
            clearInterval(pollInterval);
            setPhotoId(uploadedImageId);
            setUploadStatus('ready');
            setUploadProgress(100);
          } else if (meta.status === 'rejected') {
            clearInterval(pollInterval);
            setUploadStatus('rejected');
            setPhotoError('Photo was rejected by validation service (corrupt or unreadable).');
          }
        } catch {
          // If metadata fails repeatedly or reaches timeout
          if (attempts >= maxAttempts) {
            clearInterval(pollInterval);
            setUploadStatus('timeout');
            setPhotoError('Photo processing timed out. You may retry or proceed without a photo.');
          }
        }

        if (attempts >= maxAttempts && uploadStatus !== 'ready') {
          clearInterval(pollInterval);
          setUploadStatus('timeout');
          setPhotoError('Photo processing timed out. You may retry or proceed without a photo.');
        }
      }, 1000);
    } catch (err: unknown) {
      setUploadStatus('idle');
      if (err instanceof ApiError) {
        setPhotoError(err.message);
      } else {
        setPhotoError('Failed to upload image. Please check connection and retry.');
      }
    }
  };

  const handleSkipPhoto = () => {
    setSelectedFile(null);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setPhotoId(null);
    setUploadStatus('idle');
    setCurrentStep(4);
  };

  // Final submit
  const handleSubmitReport = async () => {
    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const payload = {
        title: title.trim(),
        description: description.trim(),
        category,
        location: {
          lat: location.lat,
          lng: location.lng,
          address: address.trim() || undefined
        },
        photoIds: photoId ? [photoId] : undefined
      };

      const res = await submitReportApi(payload, idempotencyKey);
      setCreatedReport(res);
      // New idempotency key for subsequent submissions
      setIdempotencyKey(crypto.randomUUID());
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setSubmitError(err.message || 'Failed to submit report.');
      } else {
        setSubmitError('Failed to submit report. Please check your connection and retry.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  // If report submitted successfully
  if (createdReport) {
    return (
      <div className="max-w-2xl mx-auto py-8">
        <Card className="text-center p-8 flex flex-col items-center gap-4">
          <div className="w-12 h-12 bg-success-bg text-success-text rounded-md flex items-center justify-center">
            <svg className="w-6 h-6" viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                clipRule="evenodd"
              />
            </svg>
          </div>
          <h1 className="text-2xl font-semibold text-text">Report Submitted Successfully</h1>
          <p className="text-sm text-text-muted max-w-md">
            Your civic report has been received and registered into the system. You can track its
            live status updates anytime.
          </p>

          <div className="p-4 rounded-md border border-border bg-surface w-full max-w-md flex flex-col gap-2 text-left">
            <div className="flex justify-between items-center">
              <span className="text-xs text-text-muted">Report ID</span>
              <span className="text-xs font-mono font-medium text-text">{createdReport.id}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-xs text-text-muted">Status</span>
              <StatusBadge status={createdReport.status} />
            </div>
            <div className="flex justify-between items-center">
              <span className="text-xs text-text-muted">Title</span>
              <span className="text-xs font-medium text-text truncate max-w-xs">
                {createdReport.title}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3 mt-4">
            <Link to={`/my/${createdReport.id}`}>
              <Button variant="primary" size="md">
                View in My Reports
              </Button>
            </Link>
            <Link to={`/reports/${createdReport.id}`}>
              <Button variant="secondary" size="md">
                Public Detail
              </Button>
            </Link>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto py-6 flex flex-col gap-6">
      {/* Step Progress Indicator */}
      <div>
        <h1 className="text-2xl font-semibold text-text mb-2">Report a Civic Issue</h1>
        <p className="text-sm text-text-muted mb-6">
          Submit municipal issues with details, map coordinates, and optional photos.
        </p>

        <div className="flex items-center justify-between border-b border-border pb-4">
          {[
            { step: 1, label: 'Details' },
            { step: 2, label: 'Location' },
            { step: 3, label: 'Photo' },
            { step: 4, label: 'Review' }
          ].map((s) => (
            <div key={s.step} className="flex items-center gap-2">
              <span
                className={`w-7 h-7 rounded-md flex items-center justify-center text-xs font-semibold ${
                  currentStep === s.step
                    ? 'bg-primary text-primary-text'
                    : currentStep > s.step
                      ? 'bg-neutral-bg text-neutral-text'
                      : 'border border-border text-text-muted'
                }`}
              >
                {s.step}
              </span>
              <span
                className={`text-sm hidden sm:inline ${
                  currentStep === s.step ? 'font-semibold text-text' : 'text-text-muted'
                }`}
              >
                {s.label}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* STEP 1: Details */}
      {currentStep === 1 && (
        <Card className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold text-text">Step 1: Issue Details</h2>

          <Field
            id="report-title"
            label="Issue Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={120}
            hint="Brief summary of the issue (max 120 chars)"
            error={stepErrors.title}
            required
          />

          <Select
            id="report-category"
            label="Category"
            options={categoryOptions}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            error={stepErrors.category}
            disabled={isCatLoading}
            required
          />

          <TextArea
            id="report-description"
            label="Detailed Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={2000}
            showCount
            hint="Describe the issue, landmarks, severity, or hazards (optional)"
            error={stepErrors.description}
          />

          <div className="flex justify-end pt-4">
            <Button
              variant="primary"
              size="md"
              onClick={() => {
                if (validateStep1()) setCurrentStep(2);
              }}
            >
              Continue to Location &rarr;
            </Button>
          </div>
        </Card>
      )}

      {/* STEP 2: Location */}
      {currentStep === 2 && (
        <Card className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold text-text">Step 2: Pinpoint Location</h2>
          <p className="text-sm text-text-muted">
            Click on the map or drag the pin to mark the exact location of the issue.
          </p>

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-surface p-3 rounded-md border border-border">
            <span className="text-xs font-mono text-text">
              Coordinates: <strong>{formatCoordinates(location.lat, location.lng)}</strong>
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={handleUseMyLocation}
              disabled={isLocating}
            >
              {isLocating ? 'Locating...' : 'Use my current location'}
            </Button>
          </div>

          {geoError && <ErrorNotice message={geoError} />}

          <div className="w-full h-80 rounded-md border border-border overflow-hidden">
            <MapContainer
              center={[location.lat, location.lng]}
              zoom={13}
              style={{ width: '100%', height: '100%' }}
            >
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              <LocationMarker position={location} onChange={setLocation} />
            </MapContainer>
          </div>

          <Field
            id="report-address"
            label="Street Address or Landmark (optional)"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            maxLength={300}
            hint="e.g. Near City Center Gate 3"
            error={stepErrors.address}
          />

          <div className="flex justify-between pt-4">
            <Button variant="secondary" size="md" onClick={() => setCurrentStep(1)}>
              &larr; Back
            </Button>
            <Button
              variant="primary"
              size="md"
              onClick={() => {
                if (validateStep2()) setCurrentStep(3);
              }}
            >
              Continue to Photo &rarr;
            </Button>
          </div>
        </Card>
      )}

      {/* STEP 3: Photo (optional) */}
      {currentStep === 3 && (
        <Card className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold text-text">Step 3: Attach Photo (Optional)</h2>
          <p className="text-sm text-text-muted">
            Photos help municipal officers verify and prioritize the issue. Supported formats: JPEG,
            PNG, WebP (max 8 MiB).
          </p>

          {photoError && <ErrorNotice message={photoError} />}

          <div className="flex flex-col gap-2">
            <label htmlFor="photo-input" className="text-sm font-medium text-text">
              Select Photo
            </label>
            <input
              id="photo-input"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={handleFileChange}
              className="text-sm text-text file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-surface file:text-text hover:file:bg-border cursor-pointer"
            />
          </div>

          {previewUrl && (
            <div className="flex flex-col gap-3 p-4 rounded-md border border-border bg-surface">
              <div className="max-w-xs max-h-48 overflow-hidden rounded-md border border-border">
                <img src={previewUrl} alt="Issue preview" className="object-cover w-full h-full" />
              </div>

              {uploadStatus === 'idle' && (
                <div>
                  <Button variant="primary" size="sm" onClick={handleUploadPhoto}>
                    Upload and Verify Photo
                  </Button>
                </div>
              )}

              {(uploadStatus === 'uploading' || uploadStatus === 'processing') && (
                <div className="flex items-center gap-3">
                  <Spinner size="sm" />
                  <span className="text-xs text-text font-medium">
                    {uploadStatus === 'uploading'
                      ? 'Uploading...'
                      : 'Processing and verifying photo...'}
                    ({uploadProgress}%)
                  </span>
                </div>
              )}

              {uploadStatus === 'ready' && (
                <div className="text-xs font-semibold text-success-text flex items-center gap-1">
                  <span>✓ Photo processed and ready!</span>
                </div>
              )}
            </div>
          )}

          <div className="flex justify-between pt-4">
            <Button variant="secondary" size="md" onClick={() => setCurrentStep(2)}>
              &larr; Back
            </Button>
            <div className="flex gap-2">
              <Button variant="secondary" size="md" onClick={handleSkipPhoto}>
                Skip Photo
              </Button>
              <Button
                variant="primary"
                size="md"
                disabled={uploadStatus === 'uploading' || uploadStatus === 'processing'}
                onClick={() => setCurrentStep(4)}
              >
                Review &rarr;
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* STEP 4: Review and Submit */}
      {currentStep === 4 && (
        <Card className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold text-text">Step 4: Review and Submit</h2>
          <p className="text-sm text-text-muted">
            Please review the details of your report before submitting.
          </p>

          {submitError && (
            <ErrorNotice
              title="Submission Failed"
              message={submitError}
              onRetry={handleSubmitReport}
            />
          )}

          <div className="rounded-md border border-border divide-y divide-border bg-surface">
            <div className="p-3 flex justify-between">
              <span className="text-xs text-text-muted font-medium">Title</span>
              <span className="text-sm text-text font-medium text-right">{title}</span>
            </div>
            <div className="p-3 flex justify-between">
              <span className="text-xs text-text-muted font-medium">Category</span>
              <span className="text-sm text-text capitalize">{category}</span>
            </div>
            <div className="p-3 flex justify-between">
              <span className="text-xs text-text-muted font-medium">Location</span>
              <span className="text-sm text-text font-mono">
                {formatCoordinates(location.lat, location.lng)}
              </span>
            </div>
            {address && (
              <div className="p-3 flex justify-between">
                <span className="text-xs text-text-muted font-medium">Address</span>
                <span className="text-sm text-text text-right">{address}</span>
              </div>
            )}
            {description && (
              <div className="p-3 flex flex-col gap-1">
                <span className="text-xs text-text-muted font-medium">Description</span>
                <p className="text-sm text-text whitespace-pre-wrap">{description}</p>
              </div>
            )}
            <div className="p-3 flex justify-between items-center">
              <span className="text-xs text-text-muted font-medium">Photo</span>
              <span className="text-sm text-text">
                {photoId ? '1 photo attached (verified)' : 'No photo attached'}
              </span>
            </div>
          </div>

          <div className="flex justify-between pt-4">
            <Button
              variant="secondary"
              size="md"
              disabled={isSubmitting}
              onClick={() => setCurrentStep(3)}
            >
              &larr; Back
            </Button>
            <Button
              variant="primary"
              size="md"
              disabled={isSubmitting}
              onClick={handleSubmitReport}
            >
              {isSubmitting ? 'Submitting Report...' : 'Submit Report'}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
};
