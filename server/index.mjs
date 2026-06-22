import express from "express";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyRuntimeConfig, getConfig, loadDotEnv, publicConfig, saveLocalEnv } from "./config.mjs";
import { listGeminiModels } from "./gemini.mjs";
import { compactRecording, discoverProject, searchPersons } from "./posthog.mjs";
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

async function stopRuntimeJob(job) {
  requestJobCancel(job);
  await saveJob(job);
  const promise = jobPromises.get(job.id);
  if (promise) await promise.catch(() => {});
  return job;
}

await loadDotEnv(repoRoot);
await fs.mkdir(artifactsRoot, { recursive: true });

const app = express();
app.use(express.json({ limit: "2mb" }));
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

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: error.message });
});

const port = getConfig().port;
app.listen(port, "127.0.0.1", () => {
  console.log(`Replay Lens API listening on http://127.0.0.1:${port}`);
});
