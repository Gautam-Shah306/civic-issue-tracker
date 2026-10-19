# Kubernetes Secrets Reference

This document catalogs every Kubernetes Secret referenced by the Helm chart (`deploy/helm/civic-service`) and the plain manifests (`deploy/k8s/`).

Per project security requirements and Decision **D-052**, **no Secret manifest of any kind is committed to this repository**.

## Referenced Secrets Table

| Namespace | Secret Name | Secret Keys | Consumer(s) | Notes |
|---|---|---|---|---|
| `civic-app` | `jwt-public` | `JWT_PUBLIC_KEY_B64` | `report`, `analytics`, `routing`, `image`, `gateway` | EdDSA public key (base64-encoded PKCS8/SPKI PEM) used to verify access tokens. |
| `civic-app` | `auth-secrets` | `DB_PASSWORD`<br>`RABBITMQ_URL`<br>`JWT_PRIVATE_KEY_B64`<br>`BOOTSTRAP_ADMIN_EMAIL`<br>`BOOTSTRAP_ADMIN_PASSWORD` | `auth` | Auth database password, RabbitMQ connection URL, EdDSA private signing key, and initial administrator bootstrap credentials. |
| `civic-app` | `report-secrets` | `DB_PASSWORD`<br>`RABBITMQ_URL` | `report` | Report database password and RabbitMQ connection URL. |
| `civic-app` | `notification-secrets` | `DB_PASSWORD`<br>`RABBITMQ_URL`<br>`SMTP_USER` (opt)<br>`SMTP_PASSWORD` (opt) | `notification` | Notification database password, RabbitMQ connection URL, and optional SMTP provider credentials. |
| `civic-app` | `analytics-secrets` | `DB_PASSWORD`<br>`MIGRATE_DB_PASSWORD`<br>`RABBITMQ_URL` | `analytics` | Runtime role (`civic_analytics_rw`) DB password, migration owner (`civic_analytics`) DB password, and RabbitMQ URL. |
| `civic-app` | `routing-secrets` | `DB_PASSWORD`<br>`RABBITMQ_URL` | `routing` | Routing database password and RabbitMQ connection URL. |
| `civic-app` | `image-secrets` | `DB_PASSWORD`<br>`RABBITMQ_URL`<br>`AWS_ACCESS_KEY_ID`<br>`AWS_SECRET_ACCESS_KEY` | `image` | Image database password, RabbitMQ connection URL, and S3 credentials for SeaweedFS. |
| `civic-app` | `gateway-secrets` | `REDIS_URL` | `gateway` | Redis connection URL with embedded authentication token. |
| `civic-data` | `postgres-superuser` | `POSTGRES_USER`<br>`POSTGRES_PASSWORD`<br>`POSTGRES_DB` | `postgres` (StatefulSet) | PostgreSQL superuser credentials used to initialize the primary cluster container. |
| `civic-data` | `db-init-secrets` | `POSTGRES_USER`<br>`POSTGRES_PASSWORD`<br>`POSTGRES_DB`<br>`AUTH_DB_PASSWORD`<br>`REPORT_DB_PASSWORD`<br>`NOTIFICATION_DB_PASSWORD`<br>`ANALYTICS_DB_PASSWORD`<br>`ANALYTICS_RW_DB_PASSWORD`<br>`ROUTING_DB_PASSWORD`<br>`IMAGE_DB_PASSWORD` | `db-init` (Job) | Database provisioning credentials matching those configured in `deploy/compose/db-init/db-init.sh`. |
| `civic-data` | `rabbitmq-credentials` | `RABBITMQ_DEFAULT_USER`<br>`RABBITMQ_DEFAULT_PASS` | `rabbitmq` (StatefulSet) | Broker default administrator account credentials. |
| `civic-data` | `redis-credentials` | `REDIS_PASSWORD` | `redis` (StatefulSet) | In-memory cache requirepass password. |
| `civic-data` | `seaweedfs-credentials` | `AWS_ACCESS_KEY_ID`<br>`AWS_SECRET_ACCESS_KEY` | `seaweedfs` (StatefulSet) | S3 master storage credentials. |

## Important Security and Operational Notes

1. **SealedSecrets at Cluster Time:** Real `SealedSecret` resources are generated at cluster provisioning time because sealing requires the active controller's public certificate. SealedSecrets cannot be generated offline before the cluster is initialized.
2. **Namespace Binding:** Sealed secrets are cryptographically bound to their target namespace (`civic-app` or `civic-data`). Shared values (such as database passwords, RabbitMQ credentials, and S3 access keys) are sealed separately into each namespace from a single authoritative credential source.
3. **URL-Safe Encoding in Connection Strings:** `RABBITMQ_URL` and `REDIS_URL` embed usernames and passwords directly in URL format. Any special characters in passwords must be URL-safe or URL-encoded (RFC 3986).
4. **Generator Script:** The automated SealedSecrets generation script will be delivered in Prompt 6.
5. **No Secret Manifests in VCS:** Zero plain Secret manifests exist in version control.
