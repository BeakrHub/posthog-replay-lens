import express from "express";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyRuntimeConfig, getConfig, loadDotEnv, publicConfig, saveLocalEnv } from "./config.mjs";
import { listGeminiModels } from "./gemini.mjs";
import { compactRecording, discoverProject, searchPersons } from "./posthog.mjs";
import {
  automationConfigFromEnv,
  automationSummary,
  buildAutomationJobConfig,
  loadAutomationState,
  saveAutomationState,
  sendSlackSummary,
  updateStateFromJob
} from "./automation.mjs";
import {
  buildAgentHandoffMarkdown,
  buildExportPayload,
  buildJobConfig,
  listFilteredRecordings,
  loadJob,
  makeJob,
  markJobInterrupted,
  requestJobCancel,
  runJob,
  sanitizeJob,
  saveJob
} from "./job-runner.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const artifactsRoot = path.join(repoRoot, "artifacts");
const jobs = new Map();
const jobPromises = new Map();
const authCookieName = "replay_lens_session";
const automationRuntime = {
  running: false,
  currentJobId: null,
  nextRunAt: null,
  lastStartedAt: null,
  lastFinishedAt: null,
  lastError: null,
  lastSlack: null,
  timer: null
};

async function getJobById(id) {
  const runtimeJob = jobs.get(id);
  if (runtimeJob) return runtimeJob;
  return normalizeJobForCurrentProcess(await loadJob({ artifactsRoot, id }));
}

async function normalizeJobForCurrentProcess(job) {
  if (isActiveJob(job) && !jobPromises.has(job.id)) {
    markJobInterrupted(job);
    await saveJob(job);
  }
  return job;
}

async function listSavedJobs() {
  const jobsDir = path.join(artifactsRoot, "jobs");
  let names = [];
  try {
    names = await fs.readdir(jobsDir);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const saved = await Promise.all(
    names.map(async (name) => {
      try {
        return await normalizeJobForCurrentProcess(await loadJob({ artifactsRoot, id: name }));
      } catch {
        return null;
      }
    })
  );
  return saved.filter(Boolean);
}

function isActiveJob(job) {
  return job?.status === "running" || job?.status === "queued" || job?.status === "canceling";
}

function trackJobRun(job) {
  const promise = runJob({ job, config: getConfig() })
    .catch((error) => {
      console.error(error);
    })
    .finally(() => {
      jobPromises.delete(job.id);
    });
  jobPromises.set(job.id, promise);
  return promise;
}

function automationRuntimePublic() {
  return {
    running: automationRuntime.running,
    currentJobId: automationRuntime.currentJobId,
    nextRunAt: automationRuntime.nextRunAt,
    lastStartedAt: automationRuntime.lastStartedAt,
    lastFinishedAt: automationRuntime.lastFinishedAt,
    lastError: automationRuntime.lastError,
    lastSlack: automationRuntime.lastSlack
  };
}

async function startAutomationRun(trigger = "manual") {
  if (automationRuntime.running) {
    const error = new Error("Automation is already running.");
    error.statusCode = 409;
    throw error;
  }

  const automationConfig = automationConfigFromEnv();
  const state = await loadAutomationState(artifactsRoot);
  const job = makeJob({
    artifactsRoot,
    config: buildAutomationJobConfig(automationConfig, state)
  });
  job.automation = {
    trigger,
    startedAt: new Date().toISOString(),
    excludedSeenRecordingCount: state.seenRecordingIds?.length || 0
  };
  jobs.set(job.id, job);
  await saveJob(job);

  automationRuntime.running = true;
  automationRuntime.currentJobId = job.id;
  automationRuntime.lastStartedAt = job.startedAt;
  automationRuntime.lastFinishedAt = null;
  automationRuntime.lastError = null;
  automationRuntime.lastSlack = null;

  const promise = runJob({ job, config: getConfig() })
    .then(async (finishedJob) => {
      const latestState = await loadAutomationState(artifactsRoot);
      const { state: nextState, newIssues } = updateStateFromJob(latestState, finishedJob, automationConfig);
      await saveAutomationState(artifactsRoot, nextState);
      try {
        automationRuntime.lastSlack = await sendSlackSummary({
          job: finishedJob,
          config: automationConfig,
          newIssues,
          state: nextState
        });
      } catch (error) {
        automationRuntime.lastSlack = { sent: false, reason: error.message };
        console.error(error);
      }
      return finishedJob;
    })
    .catch((error) => {
      automationRuntime.lastError = error.stack || error.message;
      console.error(error);
    })
    .finally(() => {
      automationRuntime.running = false;
      automationRuntime.currentJobId = null;
      automationRuntime.lastFinishedAt = new Date().toISOString();
      jobPromises.delete(job.id);
    });
  jobPromises.set(job.id, promise);
  void promise;

  return job;
}

function automationIntervalMs(config = automationConfigFromEnv()) {
  return Math.max(60_000, Math.round(Number(config.intervalHours || 5) * 60 * 60 * 1000));
}

function scheduleAutomationRun(delayMs) {
  if (automationRuntime.timer) clearTimeout(automationRuntime.timer);
  automationRuntime.nextRunAt = new Date(Date.now() + delayMs).toISOString();
  automationRuntime.timer = setTimeout(async () => {
    try {
      if (!automationRuntime.running) await startAutomationRun("schedule");
    } catch (error) {
      automationRuntime.lastError = error.stack || error.message;
      console.error(error);
    } finally {
      scheduleAutomationRun(automationIntervalMs());
    }
  }, delayMs);
}

function startAutomationScheduler() {
  const config = automationConfigFromEnv();
  if (!config.enabled) return;
  scheduleAutomationRun(config.runOnStart ? 5000 : automationIntervalMs(config));
}

async function stopRuntimeJob(job) {
  requestJobCancel(job);
  await saveJob(job);
  const promise = jobPromises.get(job.id);
  if (promise) await promise.catch(() => {});
  return job;
}

function htmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseCookies(header = "") {
  const cookies = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }
  return cookies;
}

function authPassword() {
  return String(process.env.REPLAY_LENS_PASSWORD || "").trim();
}

function safeRedirect(input) {
  const target = String(input || "/");
  if (target.startsWith("/") && !target.startsWith("//")) return target;
  return "/";
}

function timingSafeTextEqual(left, right) {
  const leftHash = crypto.createHash("sha256").update(String(left)).digest();
  const rightHash = crypto.createHash("sha256").update(String(right)).digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
}

function signSession(expiresAt, password) {
  return crypto.createHmac("sha256", password).update(String(expiresAt)).digest("base64url");
}

function makeSessionToken(password) {
  const expiresAt = Date.now() + 1000 * 60 * 60 * 24 * 14;
  return `${expiresAt}.${signSession(expiresAt, password)}`;
}

function hasValidSession(req, password) {
  const token = parseCookies(req.headers.cookie)[authCookieName];
  if (!token || !token.includes(".")) return false;
  const [expiresAt, signature] = token.split(".");
  const expires = Number(expiresAt);
  if (!Number.isFinite(expires) || expires < Date.now()) return false;
  return timingSafeTextEqual(signature, signSession(expiresAt, password));
}

function renderLoginPage({ error = "", next = "/" } = {}) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Replay Lens Sign In</title>
    <style>
      :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f5f7fb; color: #111827; }
      main { width: min(420px, calc(100vw - 40px)); border: 1px solid #d8dee9; border-radius: 12px; background: #fff; box-shadow: 0 18px 50px rgb(15 23 42 / 10%); padding: 28px; }
      .eyebrow { margin: 0 0 8px; color: #3155b7; font-size: 12px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
      h1 { margin: 0 0 10px; font-size: 26px; line-height: 1.15; }
      p { margin: 0 0 20px; color: #596273; line-height: 1.5; }
      label { display: block; margin: 0 0 8px; color: #424b5c; font-size: 14px; font-weight: 700; }
      input { box-sizing: border-box; width: 100%; height: 48px; border: 1px solid #cfd6e2; border-radius: 8px; padding: 0 14px; font: inherit; font-weight: 650; outline: none; }
      input:focus { border-color: #3155b7; box-shadow: 0 0 0 3px rgb(49 85 183 / 15%); }
      button { width: 100%; height: 48px; margin-top: 14px; border: 0; border-radius: 8px; background: #3155b7; color: #fff; font: inherit; font-weight: 800; cursor: pointer; }
      .error { margin: 0 0 14px; border: 1px solid #fecaca; border-radius: 8px; background: #fff1f2; color: #991b1b; padding: 10px 12px; font-weight: 700; }
    </style>
  </head>
  <body>
    <main>
      <p class="eyebrow">Team Access</p>
      <h1>Replay Lens</h1>
      <p>Enter the team password to view replay analyses, API data, and generated artifacts.</p>
      ${error ? `<div class="error">${htmlEscape(error)}</div>` : ""}
      <form method="post" action="/login">
        <input type="hidden" name="next" value="${htmlEscape(next)}" />
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" autofocus required />
        <button type="submit">Continue</button>
      </form>
    </main>
  </body>
</html>`;
}

function requirePasswordGate(req, res, next) {
  const password = authPassword();
  if (!password) {
    next();
    return;
  }
  if (hasValidSession(req, password)) {
    next();
    return;
  }
  if (req.path.startsWith("/api")) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.status(401).send("Authentication required.");
    return;
  }
  res.redirect(`/login?next=${encodeURIComponent(req.originalUrl || "/")}`);
}

await loadDotEnv(repoRoot);
await fs.mkdir(artifactsRoot, { recursive: true });

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false, limit: "20kb" }));

app.get("/login", (req, res) => {
  if (!authPassword()) {
    res.redirect("/");
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderLoginPage({ next: safeRedirect(req.query.next) }));
});

app.post("/login", (req, res) => {
  const password = authPassword();
  if (!password) {
    res.redirect("/");
    return;
  }
  const next = safeRedirect(req.body?.next);
  if (!timingSafeTextEqual(req.body?.password || "", password)) {
    res.status(401).setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderLoginPage({ error: "Incorrect password.", next }));
    return;
  }
  res.cookie(authCookieName, makeSessionToken(password), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 24 * 14
  });
  res.redirect(next);
});

app.post("/logout", (_req, res) => {
  res.clearCookie(authCookieName, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production"
  });
  res.redirect("/login");
});

app.use(requirePasswordGate);
app.use("/artifacts", express.static(artifactsRoot));

app.get("/api/health", async (_req, res) => {
  const config = getConfig();
  res.json({ ok: true, config: publicConfig(config) });
});

app.post("/api/config", async (req, res, next) => {
  try {
    const config = applyRuntimeConfig(req.body || {});
    if (req.body?.persist) await saveLocalEnv(repoRoot, config);
    res.json({
      ok: true,
      persisted: Boolean(req.body?.persist),
      config: publicConfig(config)
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/gemini/models", async (_req, res, next) => {
  try {
    const config = getConfig();
    const models = await listGeminiModels({ config });
    res.json({
      provider: config.geminiProvider,
      defaultModel: config.geminiModel,
      models
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/automation", async (_req, res, next) => {
  try {
    const config = automationConfigFromEnv();
    const state = await loadAutomationState(artifactsRoot);
    res.json(automationSummary({ state, config, runtime: automationRuntimePublic() }));
  } catch (error) {
    next(error);
  }
});

app.post("/api/automation/run", async (_req, res, next) => {
  try {
    const job = await startAutomationRun("manual");
    res.status(202).json({
      ok: true,
      job: sanitizeJob(job),
      automation: automationRuntimePublic()
    });
  } catch (error) {
    if (error.statusCode) res.status(error.statusCode).json({ error: error.message });
    else next(error);
  }
});

app.get("/api/users", async (req, res, next) => {
  try {
    const config = getConfig();
    const project = await discoverProject(config);
    const users = await searchPersons(config, project.id, req.query.search || "", req.query.limit || 12);
    res.json({
      project: { id: project.id, name: project.name },
      users
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/recordings", async (req, res, next) => {
  try {
    const config = getConfig();
    const project = await discoverProject(config);
    const jobConfig = buildJobConfig({
      ...req.query,
      candidateLimit: req.query.limit || req.query.candidateLimit
    });
    const { recordings, diagnostics } = await listFilteredRecordings({ config, projectId: project.id, jobConfig });
    res.json({
      project: { id: project.id, name: project.name },
      filters: jobConfig,
      diagnostics,
      recordings: recordings.map((recording) => compactRecording(recording, { config, projectId: project.id }))
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/jobs", async (req, res, next) => {
  try {
    const job = makeJob({ artifactsRoot, config: req.body || {} });
    jobs.set(job.id, job);
    await saveJob(job);
    void trackJobRun(job);
    res.status(202).json(sanitizeJob(job));
  } catch (error) {
    next(error);
  }
});

app.get("/api/jobs", async (_req, res, next) => {
  try {
    const merged = new Map();
    for (const job of await listSavedJobs()) merged.set(job.id, job);
    for (const job of jobs.values()) merged.set(job.id, job);
    res.json([...merged.values()].map(sanitizeJob).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))));
  } catch (error) {
    next(error);
  }
});

app.get("/api/jobs/:id", async (req, res, next) => {
  try {
    const job = await getJobById(req.params.id);
    res.json(sanitizeJob(job));
  } catch (error) {
    if (error.code === "ENOENT") res.status(404).json({ error: "Job not found" });
    else next(error);
  }
});

app.post("/api/jobs/:id/cancel", async (req, res, next) => {
  try {
    const job = jobs.get(req.params.id);
    if (!job) {
      const savedJob = await getJobById(req.params.id);
      res.json(sanitizeJob(savedJob));
      return;
    }
    if (!isActiveJob(job)) {
      res.status(409).json({ error: `Job is already ${job.status}.` });
      return;
    }
    requestJobCancel(job);
    await saveJob(job);
    res.json(sanitizeJob(job));
  } catch (error) {
    if (error.code === "ENOENT") res.status(404).json({ error: "Job not found" });
    else next(error);
  }
});

app.get("/api/jobs/:id/export.json", async (req, res, next) => {
  try {
    const job = await getJobById(req.params.id);
    res.setHeader("Content-Disposition", `attachment; filename="${req.params.id}-replay-lens.json"`);
    res.json(buildExportPayload(job));
  } catch (error) {
    if (error.code === "ENOENT") res.status(404).json({ error: "Job not found" });
    else next(error);
  }
});

app.get("/api/jobs/:id/agent-handoff.md", async (req, res, next) => {
  try {
    const job = await getJobById(req.params.id);
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${req.params.id}-agent-handoff.md"`);
    res.send(buildAgentHandoffMarkdown(job));
  } catch (error) {
    if (error.code === "ENOENT") res.status(404).json({ error: "Job not found" });
    else next(error);
  }
});

app.delete("/api/jobs/:id", async (req, res, next) => {
  try {
    const runtimeJob = jobs.get(req.params.id);
    let stopped = false;
    if (isActiveJob(runtimeJob)) {
      stopped = true;
      await stopRuntimeJob(runtimeJob);
    } else {
      await getJobById(req.params.id);
    }
    jobs.delete(req.params.id);
    await fs.rm(path.join(artifactsRoot, "jobs", req.params.id), { recursive: true, force: true });
    res.json({ ok: true, id: req.params.id, stopped });
  } catch (error) {
    if (error.code === "ENOENT") res.status(404).json({ error: "Job not found" });
    else next(error);
  }
});

app.delete("/api/jobs", async (_req, res, next) => {
  try {
    const allJobs = await listSavedJobs();
    const deleted = [];
    const skipped = [];
    for (const job of allJobs) {
      if (isActiveJob(job)) {
        skipped.push(job.id);
        continue;
      }
      jobs.delete(job.id);
      await fs.rm(path.join(artifactsRoot, "jobs", job.id), { recursive: true, force: true });
      deleted.push(job.id);
    }
    res.json({ ok: true, deleted, skipped });
  } catch (error) {
    next(error);
  }
});

app.use("/api", (req, res) => {
  res.status(404).json({
    error: `API route not found: ${req.method} ${req.originalUrl}. Restart npm run dev if the frontend was updated recently.`
  });
});

const distRoot = path.join(repoRoot, "dist");
try {
  await fs.access(path.join(distRoot, "index.html"));
  app.use(express.static(distRoot));
  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(distRoot, "index.html"));
  });
} catch {
  if (process.env.NODE_ENV === "production") {
    console.warn("No dist/index.html found; run npm run build before starting production server.");
  }
}

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: error.message });
});

const port = getConfig().port;
const host = process.env.HOST || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
app.listen(port, host, () => {
  console.log(`Replay Lens listening on http://${host}:${port}`);
  startAutomationScheduler();
});
