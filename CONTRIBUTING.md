# Contributing

Thanks for improving Replay Lens.

## Development

```bash
npm install
npx playwright install chromium
npm run dev
```

Run checks before opening a pull request:

```bash
npm run check
npm audit --audit-level=low
```

## Guardrails

- Do not commit `.env`, replay videos, raw events, screenshots, reports, or generated artifacts.
- Keep API keys on the server side only.
- Treat session recordings as sensitive data, even when PostHog masking is enabled.
- Prefer small, focused changes with clear reproduction notes for bug fixes.
