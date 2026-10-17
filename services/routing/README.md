# Routing & Assignment Service (`services/routing`)

Core Python domain service responsible for geographic ward resolution (PostGIS spatial queries), department category mappings, automatic assignment orchestration, and administrative reference data management ([D-044](../../docs/12-decision-log.md), [D-045](../../docs/12-decision-log.md)).

## Features

- **Spatial Resolution:** Automatic assignment of reports to wards via 5x5 PostGIS synthetic polygon grid (`ST_Intersects`).
- **Department Routing:** Dynamic resolution of municipal departments from report category slugs.
- **Event Choreography:** Consumes `report.submitted` over RabbitMQ (`routing.report-submitted`), publishes `report.assigned` via outbox relay.
- **Master Data Ownership:** CRUD APIs for wards, departments, and categories.
- **Category Synchronization:** Emits `category.upserted` on category mutations and republishes all categories on service startup.

## Development

```powershell
# Sync dependencies
uv sync --frozen

# Lint and formatting
uv run ruff check .
uv run ruff format --check .

# Test suite with Testcontainers and coverage gate
uv run pytest --cov=app --cov-report=term-missing
```
