{{/*
Expand the name of the chart.
*/}}
{{- define "civic-service.name" -}}
{{- default .Values.service.name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "civic-service.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- .Values.service.name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{/*
Chart label
*/}}
{{- define "civic-service.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "civic-service.labels" -}}
helm.sh/chart: {{ include "civic-service.chart" . }}
{{ include "civic-service.selectorLabels" . }}
app.kubernetes.io/part-of: civic-issue-tracker
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "civic-service.selectorLabels" -}}
app.kubernetes.io/name: {{ .Values.service.name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "civic-service.serviceAccountName" -}}
{{- include "civic-service.fullname" . }}
{{- end }}

{{/*
Resolve image reference: if image.digest is set use repo@digest else repo:tag
*/}}
{{- define "civic-service.image" -}}
{{- if .Values.image.digest }}
{{- printf "%s@%s" .Values.image.repository .Values.image.digest }}
{{- else }}
{{- printf "%s:%s" .Values.image.repository .Values.image.tag }}
{{- end }}
{{- end }}
