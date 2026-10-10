# Code Style Guidelines

## General
- 12-factor config from environment variables.
- Use UTC timestamps everywhere.
- No secrets or personal data in code, logs, or fixtures.
- Keep functions small and focused.
- Explicit error handling; no silent fallbacks. Log every fallback.

## Node/TypeScript
- TypeScript strict mode enabled.
- No `any` without a justifying comment.
- Use ESLint and Prettier.
- Use Zod for validation at boundaries.
- Use pino for structured JSON logs.
- Follow Fastify conventions.
- Handle async errors explicitly.
- Use Vitest for tests.
- File names must be `kebab-case`.

## Python
- Full type annotations required.
- Docstrings required on public functions and classes.
- Use Ruff for linting and formatting.
- Use `pathlib.Path` for filesystem paths.
- Use Pydantic models at boundaries.
- Use structured JSON logging.
- Use `pytest` for tests.
- File names and variables must be `snake_case`.

## Logging
- Output structured JSON to `stdout`.
- Include a `correlation_id` field in all logs.
- Never log secrets, tokens, passwords, or personal data.

## API and Events
- Endpoints must be versioned under `/api/v1/`.
- Maintain a consistent error response shape.
- Event envelope fields must match `docs/03` section 2.
- Contracts live in `/contracts` and are the source of truth.

## Git
- Follow Conventional Commits format.
- One logical change per commit.
- Never commit `.env` files or keys.

## Testing
- Write unit and integration tests for all features.
- A 60% coverage gate on core logic is required (MNT-03).

*(Note: Tool versions will be pinned when the first service is created.)*
