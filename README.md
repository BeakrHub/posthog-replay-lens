# Replay Lens

Local-first session replay analysis powered by Gemini video understanding.

Replay Lens pulls PostHog session recording snapshots, renders them locally with `rrweb`, records a short sped-up MP4, and asks Gemini to identify user behavior, frustration signals, UX friction, and evidence-backed bugs.

Replay Lens is an independent open-source tool. It is not affiliated with, sponsored by, or endorsed by PostHog.

## Features

- Local web UI for browsing recordings, starting batch analysis, and reviewing reports.
- Server-side secrets only; API keys never go to the browser.
- Uses PostHog snapshot data directly, so it does not require PostHog Replay Vision beta access.
- Renders replay clips locally with Playwright and `rrweb`.
- Removes long inactive replay gaps before recording the MP4 so Gemini spends budget on active behavior.
- Sends generated MP4 clips to Gemini with a strict evidence-focused bug prompt.
- Retries transient Gemini API failures before marking a recording failed.
- Can process multiple replay render/Gemini jobs in parallel with a per-run concurrency limit.
- Supports Google AI Studio API keys and Vertex AI / GCP Gemini credentials.
- Lets each UI or cron run override the Gemini model string.
- Can load accessible Gemini `generateContent` models from the configured provider.
- Shows live batch progress with the selected replay queue, per-recording status, latest finding, failures, and progress counts.
- Shows estimated Gemini cost for each replay analysis and the full batch using token usage returned by Gemini responses.
- Lets you stop a running batch while keeping completed replay analyses and downloads.
- Produces per-recording JSON plus a structured aggregate bug/friction report with prioritized bugs, patterns, quick wins, and evidence gaps.
- Filter recordings by URL, specific users, age, active time, click count, keypress count, and ongoing status.
- Uses PostHog HogQL query filtering for user, URL, and age filters when available, then applies local replay-quality filters.
- Search PostHog persons by email/name and click user chips into the specific-user filter.
- Filter stale recordings with little or no activity before spending render/Gemini time.
- Skip similar duplicate traces and diversify batches across users by default.
- Open candidate and analyzed recordings directly in PostHog replay.
- Embed generated replay videos next to Gemini findings.
- Download job results as JSON or an agent-ready Markdown handoff.
- Run the same analysis pipeline from cron with `npm run analyze`.
- Run a built-in scheduled server loop that skips already-seen replay IDs, stores merged flagged issues, and sends Slack summaries when configured.

## Requirements

- Node.js 20+
- `ffmpeg` on your PATH
- A PostHog personal API key with `session_recording:read`
- Either a Gemini API key (`GOOGLE_AI_API_KEY`) or Vertex AI access through GCP

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env
```

Fill in `.env`, or run the app and use the **Connections And Credentials** panel to save local credentials:

```bash
npm run dev
```

Open the UI at `http://127.0.0.1:5173`.

The setup panel can store PostHog and Gemini settings in the running local server. When **Save to local .env so cron uses these settings** is enabled, it also writes a gitignored `.env` file for future server starts and scheduled cron runs.

## UI Flow

1. Set **Candidate Filters**: user, URL, max age, recording length, activity, stale filtering, duplicate filtering, and candidate pool size.
2. Select **Load Candidate Set** to preview eligible PostHog sessions without rendering videos or calling Gemini.
3. Review **Candidate Recordings**. Open a replay in PostHog if needed, or click rows to force exact recordings.
4. Set **Render And Gemini Settings**: videos to analyze, parallelism, replay speed, min/max video clip length, Gemini model, and Gemini focus.
5. Select **Start Analysis Batch** to render replay MP4s, send them to Gemini, and build an aggregate report. If candidates are loaded and filters have not changed, the batch uses the loaded candidate IDs shown in the table. If no candidates are loaded, it fetches candidates with the current filters at run time.
6. Watch the active batch update live: selected queue, currently processing replay, analyzed count, failures, and latest finding.
7. Stop a running batch if needed; completed recordings stay saved and downloadable.
8. Delete a running batch if needed; Replay Lens stops active work before removing local artifacts.
9. Review videos next to Gemini findings, inspect the aggregate report, then download JSON or the agent-ready Markdown handoff.

**Refresh Status** only reloads API/key status and batch history. It does not fetch new candidates or start analysis.

Candidate filters control which PostHog recordings are loaded: user, URL, max age, recording length, activity, stale filtering, duplicate filtering, and candidate pool size. Render/Gemini settings control what happens after a recording is chosen: videos to analyze, parallelism, replay speed, min/max video clip length, Gemini model, and Gemini focus.

## Configuration Limits

The UI shows allowed ranges and blocks invalid batch starts. The API and cron runner clamp the same values before a run starts.

- Videos: `1-25`; parallel jobs: `1-5`; candidate pool: `10-250` and never below the requested video count.
- Replay speed: `1-60x`; `8-16x` is usually a good range for compact clips.
- Replay speed is treated as the minimum render speed. Long active-compressed sessions may be raised automatically up to `60x` to fit useful activity into the clip cap.
- Clip length: min clip `6-60` seconds, max clip `10-90` seconds; max clip is raised if cron passes a lower value than min clip.
- Recording filters: min recording `0-7200` seconds, min active `0-7200` seconds, min clicks `0-10000`, min keys `0-100000`, min signal `0-100000`, max age `0-365` days.
- Max/user: `0-25`; `0` means unlimited recordings per matching user.

## Cron Usage

The UI includes a Scheduled Batch Command panel that generates a crontab line from the current batch settings and filters. The UI does not install cron for you; copy the generated line into `crontab -e` and replace `/path/to/replay_lens` with the repository path.

You can also run a one-off analysis directly:

```bash
npm run analyze -- \
  --count 10 \
  --parallelism 2 \
  --speed 12 \
  --gemini-model gemini-3.1-pro-preview \
  --candidate-limit 100 \
  --min-recording-seconds 60 \
  --min-active-seconds 20 \
  --min-activity-score 10 \
  --min-clicks 2 \
  --max-per-user 1 \
  --max-age-days 7 \
  --user-includes user_ab12cd34ef,email@example.com \
  --url-includes /ask,/projects \
  --url-excludes /admin,/settings \
  --analysis-focus "Find frustration, broken workflows, failed tool calls, and exact UI bugs"
```

Example crontab entry:

```cron
0 9 * * * cd /path/to/replay_lens && npm run analyze -- --count 10 --speed 12 --max-age-days 1 >> artifacts/cron.log 2>&1
```

## Railway Deployment

Replay Lens includes a `Dockerfile` and `railway.toml` for Railway. The Docker image uses the official Playwright base image, installs `ffmpeg`, builds the React UI, and serves the UI and API from one Express process.

Create a Railway service from this GitHub repo and set these variables:

```text
POSTHOG_PERSONAL_API_KEY=...
POSTHOG_PROJECT_ID=...
POSTHOG_API_HOST=https://us.posthog.com
GEMINI_PROVIDER=ai-studio
GOOGLE_AI_API_KEY=...
GEMINI_REPLAY_MODEL=gemini-3.5-flash
REPLAY_LENS_PASSWORD=...
POSTHOG_SNAPSHOT_CHUNK_SIZE=20
POSTHOG_MAX_THROTTLE_WAIT_SECONDS=90
```

Railway provides `PORT`; do not hard-code it. In production the server binds `0.0.0.0:$PORT`.

When `REPLAY_LENS_PASSWORD` is set, the web UI, API, and generated replay artifacts require a password session cookie. Leave it unset only for local-only development.

For the built-in unattended loop, keep one long-running Railway web service and set:

```text
REPLAY_LENS_PUBLIC_URL=https://your-service.up.railway.app
AUTOMATION_ENABLED=true
AUTOMATION_INTERVAL_HOURS=5
AUTOMATION_COUNT=10
AUTOMATION_PARALLELISM=2
AUTOMATION_CANDIDATE_LIMIT=150
AUTOMATION_MAX_AGE_DAYS=7
AUTOMATION_MIN_ACTIVE_SECONDS=20
AUTOMATION_MIN_ACTIVITY_SCORE=10
AUTOMATION_MAX_PER_USER=1
SLACK_WEBHOOK_URL=...
```

Attach a Railway volume mounted at `/app/artifacts` if you want job artifacts and `artifacts/automation/state.json` to survive redeploys. That state file is what prevents the five-hour loop from analyzing the same recording IDs repeatedly.

The web UI includes a **Scheduled Replay Watch** panel that shows whether automation is enabled, when the next run is scheduled, how many replay IDs have been seen, recent runs, Slack status, and the exact flagged issues with user/date/recording context. You can also start the automation job manually from that panel.

The automated loop creates an agent-ready Markdown handoff for each batch. Linear ticket creation and PR creation should be layered on top with separate Linear/GitHub credentials and a PR-only approval workflow.

## Outputs

Each run writes to `artifacts/jobs/<job-id>/`.

- `job.json`: full job status and report data.
- `<recording-id>.mp4`: generated sped-up replay clip.
- `analysis.json`: per-recording Gemini output.
- `<recording-id>-metadata.json`: render metadata, Gemini usage metadata, and estimated cost for that recording.
- `aggregate-report.json`: cross-recording synthesis.
- `/api/jobs/<job-id>/export.json`: downloadable full JSON bundle.
- `/api/jobs/<job-id>/agent-handoff.md`: downloadable Markdown brief for another coding agent.

In the UI, completed batches remain in **Batch History** until deleted. The active batch panel updates while the run is processing, and the aggregate report appears after synthesis completes.

## Cost Estimates

Gemini `generateContent` responses include live `usageMetadata` token counts, including prompt, candidate, thinking, and total tokens. They do not return the final billed dollar price for the request.

Replay Lens stores the raw response usage metadata and calculates an estimated USD cost from Google's public Gemini API paid-tier standard pricing table as of 2026-06-22: <https://ai.google.dev/gemini-api/docs/pricing>. Estimates can differ from the final invoice because of free-tier usage, Vertex AI billing settings, priority/flex/batch pricing, discounts, context caching, grounding charges, or later price changes.

## Gemini Models

The default model comes from `GEMINI_REPLAY_MODEL` and defaults to `gemini-3.5-flash`, Google AI's current stable Flash model. The UI and cron runner can override that per batch with a raw model string, for example:

```bash
npm run analyze -- --count 5 --gemini-model gemini-3.1-pro-preview
```

The UI can refresh the model list from the configured provider. For AI Studio it calls the Gemini Models API and filters to models that support `generateContent`; for Vertex AI it calls the GCP publisher model list when a bearer token or local `gcloud` auth is available. Curated current options include `gemini-3.5-flash`, `gemini-flash-latest`, and `gemini-3.1-pro-preview`.

AI Studio mode calls:

```text
https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent
```

Vertex AI mode calls:

```text
https://<location-endpoint>/v1/projects/<project>/locations/<location>/publishers/google/models/<model>:generateContent
```

If you type a model that your configured provider cannot access, the batch will fail at the Gemini analysis step and the job failure will show the provider response.

## Selection Behavior

Automatic batches are sorted by a signal score, then filtered before rendering:

- Duplicate recording IDs are always skipped.
- `userIncludes` / `--user-includes` limits automatic candidate selection to matching users. It can match the hashed `user_...` shown in the UI, PostHog `distinct_id`, person ID, or common person properties like email/name when PostHog returns them.
- For user, URL, and max-age filters, Replay Lens first tries PostHog HogQL query filtering to get matching session IDs, then fetches those recordings directly. If that query is unavailable, it falls back to paginated session-recording scans and local filtering.
- Similar duplicate traces are skipped by default using a fingerprint of hashed user, normalized route, start-time bucket, duration bucket, active-time bucket, and click bucket.
- Stale recordings are skipped by default when they have almost no active time, clicks, keypresses, or mouse activity. The combined threshold is controlled by `minActivityScore` / `--min-activity-score`.
- User identifiers are hashed before they are stored in job output or shown in the UI.
- `maxPerUser` defaults to `1`, so a normal batch tries to cover distinct users instead of repeatedly analyzing one person's sessions.
- When `userIncludes` is set, the user diversity cap is skipped so a single-user investigation can return many sessions for that user.
- Manual recording selections are treated as explicit choices and bypass automatic diversity caps.

Use `--filter-stale-recordings false` if you intentionally want passive sessions, and use `--dedupe-similar false` when you intentionally want repeated similar sessions from the same user.

## Replay Analysis Caveat

The Gemini prompt tells the model that generated clips are local reconstructions of PostHog/rrweb replay data. Replays can have masked text, missing frames, blank periods, compressed timing, cursor jitter, delayed DOM updates, or imperfect local rendering. The model is instructed not to call those reconstruction artifacts product bugs unless the actual product UI visibly behaves incorrectly.

## Safety Notes

Session replays may contain sensitive user data. Review your PostHog masking configuration before sending clips to any model provider. Generated videos, raw events, logs, and reports are written under `artifacts/`, which is gitignored by default.

## Troubleshooting

- If the UI shows `Cannot GET /api/gemini/models`, restart `npm run dev`. That means the browser is talking to a stale local API process without the model-discovery route.
- If model refresh fails, the UI falls back to curated Gemini model names so you can still type or select a model manually.
- If Gemini returns a transient `500`/`503`/`429`, Replay Lens retries with backoff before recording the failure. If it still fails after retries, lower **Parallel jobs** or try a different Gemini model/provider.
- If a batch returns `partial`, check the failure list in the active batch panel. PostHog throttling, blank renders, and inaccessible Gemini models are surfaced there.
- If the local dev server restarts during a batch, Replay Lens marks the saved batch as `partial` on the next refresh because the in-memory worker is gone.
- If you filter to a single user and get too few recordings, raise **Max/user** or set `--max-per-user 0`.
- If PostHog reports `Cannot request more than 20 blob keys at once`, restart the local server after updating. Replay Lens clamps `POSTHOG_SNAPSHOT_CHUNK_SIZE` to PostHog's 20-key request limit.

## Project Notes

Replay Lens is MIT licensed. Contributions and vulnerability reporting are covered by `CONTRIBUTING.md` and `SECURITY.md`.

## How It Works

1. Lists session recordings from the PostHog API.
2. Fetches replay snapshot blobs in range chunks to reduce throttling.
3. Decompresses PostHog's compressed `cv: "2024-10"` rrweb events.
4. Starts rendering at the first full DOM snapshot.
5. Compresses long inactive gaps out of the replay timeline.
6. Plays the replay at configurable or auto-raised speed and records a local MP4.
7. Sends the video to Gemini with an evidence-based product review prompt.
8. Synthesizes multiple analyses into a prioritized bug report.
