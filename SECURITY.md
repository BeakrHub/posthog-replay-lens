# Security

## Sensitive Data

Session replays can contain personal, customer, or proprietary data. Replay Lens stores generated replay artifacts under `artifacts/`, and that directory is ignored by git.

Before sending clips to Gemini or another model provider, review your PostHog masking settings and your data-processing obligations.

## Supported Secrets

Secrets are read from environment variables or a local `.env` file:

- `POSTHOG_PERSONAL_API_KEY`
- `GOOGLE_AI_API_KEY`
- `POSTHOG_PROJECT_ID`
- `POSTHOG_PROJECT_TOKEN`

These values must never be committed. The browser only receives redacted credential status from `/api/health`.

## Reporting Issues

Please avoid attaching replay videos, raw event exports, keys, or customer identifiers to public issues. Share minimal reproduction details and redact sensitive values.
