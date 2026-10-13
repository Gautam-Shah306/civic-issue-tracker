# Node Service Template (`services/_template`)

This directory is the copy source template for Node.js microservices in the Civic Issue Tracker project.

## How to create a new service from this template

1. **Copy the directory:**

   ```bash
   cp -r services/_template services/<new-service-name>
   ```

2. **Update Service Metadata:**
   - In `services/<new-service-name>/package.json`:
     - Rename `"name": "@civic-issue-tracker/service-template"` to `"@civic-issue-tracker/<new-service-name>"`.
     - Set initial version `"0.1.0"`.
   - In `services/<new-service-name>/src/config.ts`:
     - Change the default `SERVICE_NAME` to your new service name (e.g. `civic-auth`).

3. **Delete the demo route:**
   - In `src/app.ts`, delete the demo route:
     ```typescript
     // Delete this demo route in actual services
     app.get('/api/v1/ping', ...)
     ```
   - In `test/app.test.ts`, replace the ping tests with domain-specific endpoint tests.

4. **Add CI Workflow:**
   - Create `.github/workflows/service-<new-service-name>.yml` calling the reusable workflow `.github/workflows/node-service.yml` with `service: <new-service-name>`.

5. **Generate Dependencies:**
   - Run `npm install --ignore-scripts --min-release-age=7 --save-exact` inside the Docker builder container to lock dependencies.
