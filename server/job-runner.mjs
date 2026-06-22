import { promises as fs } from "node:fs";
import path from "node:path";
import {
  compactRecording,
  discoverProject,
  fetchRecordingsByIds,
  listRecordings,
  querySessionRecordingIds,
  recordingActivityScore,
  recordingDuplicateKey,
  recordingMatchesUserTerms,
  recordingScore,
  recordingUserKey
} from "./posthog.mjs";
import { renderReplayClip } from "./replay.mjs";
import { analyzeReplayWithGeminiDetailed, synthesizeBatchDetailed } from "./gemini.mjs";

export const DEFAULT_JOB_CONFIG = {
  count: 10,
  parallelism: 1,
  candidateLimit: 100,
  recordingIds: [],
  speed: 12,
  minClipSeconds: 12,
  maxClipSeconds: 45,
  minRecordingSeconds: 60,
  minActiveSeconds: 0,
  minClicks: 0,
  minKeypresses: 0,
  filterStaleRecordings: true,
  minActivityScore: 10,
  minMp4Bytes: 15000,
  maxAgeDays: 0,
  includeOngoing: false,
  dedupeSimilar: true,
  diversifyUsers: true,
  maxPerUser: 1,
  userIncludes: "",
  urlIncludes: "",
  urlExcludes: "",
  analysisFocus: "",
  geminiModel: "",
  width: 1280,
  height: 720
};

export function makeJobId() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  const safe = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, safe));
}

function stringValue(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function boolValue(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return fallback;
}

export function splitTerms(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  return String(value || "")
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function buildJobConfig(input = {}) {
  const config = {
    count: clampNumber(input.count, DEFAULT_JOB_CONFIG.count, 1, 25),
    parallelism: clampNumber(input.parallelism, DEFAULT_JOB_CONFIG.parallelism, 1, 5),
    candidateLimit: clampNumber(input.candidateLimit, DEFAULT_JOB_CONFIG.candidateLimit, 10, 250),
    recordingIds: Array.isArray(input.recordingIds) ? input.recordingIds.map(String).filter(Boolean) : [],
    speed: clampNumber(input.speed, DEFAULT_JOB_CONFIG.speed, 1, 60),
    minClipSeconds: clampNumber(input.minClipSeconds, DEFAULT_JOB_CONFIG.minClipSeconds, 6, 60),
    maxClipSeconds: clampNumber(input.maxClipSeconds, DEFAULT_JOB_CONFIG.maxClipSeconds, 10, 90),
    minRecordingSeconds: clampNumber(input.minRecordingSeconds, DEFAULT_JOB_CONFIG.minRecordingSeconds, 0, 7200),
    minActiveSeconds: clampNumber(input.minActiveSeconds, DEFAULT_JOB_CONFIG.minActiveSeconds, 0, 7200),
    minClicks: clampNumber(input.minClicks, DEFAULT_JOB_CONFIG.minClicks, 0, 10000),
    minKeypresses: clampNumber(input.minKeypresses, DEFAULT_JOB_CONFIG.minKeypresses, 0, 100000),
    filterStaleRecordings: boolValue(input.filterStaleRecordings, DEFAULT_JOB_CONFIG.filterStaleRecordings),
    minActivityScore: clampNumber(input.minActivityScore, DEFAULT_JOB_CONFIG.minActivityScore, 0, 100000),
    minMp4Bytes: clampNumber(input.minMp4Bytes, DEFAULT_JOB_CONFIG.minMp4Bytes, 0, 10000000),
    maxAgeDays: clampNumber(input.maxAgeDays, DEFAULT_JOB_CONFIG.maxAgeDays, 0, 365),
    includeOngoing: boolValue(input.includeOngoing, DEFAULT_JOB_CONFIG.includeOngoing),
    dedupeSimilar: boolValue(input.dedupeSimilar, DEFAULT_JOB_CONFIG.dedupeSimilar),
    diversifyUsers: boolValue(input.diversifyUsers, DEFAULT_JOB_CONFIG.diversifyUsers),
    maxPerUser: clampNumber(input.maxPerUser, DEFAULT_JOB_CONFIG.maxPerUser, 0, 25),
    userIncludes: stringValue(input.userIncludes, DEFAULT_JOB_CONFIG.userIncludes),
    urlIncludes: stringValue(input.urlIncludes, DEFAULT_JOB_CONFIG.urlIncludes),
    urlExcludes: stringValue(input.urlExcludes, DEFAULT_JOB_CONFIG.urlExcludes),
    analysisFocus: stringValue(input.analysisFocus, DEFAULT_JOB_CONFIG.analysisFocus).slice(0, 2000),
    geminiModel: stringValue(input.geminiModel, DEFAULT_JOB_CONFIG.geminiModel).slice(0, 120),
    width: clampNumber(input.width, DEFAULT_JOB_CONFIG.width, 800, 1920),
    height: clampNumber(input.height, DEFAULT_JOB_CONFIG.height, 450, 1080)
  };

  if (config.candidateLimit < config.count) config.candidateLimit = config.count;
  if (config.minClipSeconds > config.maxClipSeconds) config.maxClipSeconds = config.minClipSeconds;

  return config;
}

export function makeJob({ id = makeJobId(), artifactsRoot, config }) {
  return {
    id,
    status: "queued",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    outputDir: path.join(artifactsRoot, "jobs", id),
    config: buildJobConfig(config),
    progress: { completed: 0, currentRecordingId: null, activeRecordingIds: [], activeRecordings: [], message: "Queued" },
    selectedRecordings: [],
    results: [],
    failures: [],
    synthesis: null,
    synthesisUsage: null,
    synthesisCost: null,
    error: null,
    cancelRequested: false,
    canceledAt: null,
    project: null
  };
}

export function sanitizeJob(job) {
  const id = job.id;
  return {
    id,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    progress: job.progress,
    config: job.config,
    selectedRecordings: job.selectedRecordings,
    results: job.results,
    failures: job.failures,
    synthesis: job.synthesis,
    synthesisUsage: job.synthesisUsage || null,
    synthesisCost: job.synthesisCost || null,
    costs: summarizeJobCosts(job),
    error: job.error,
    cancelRequested: Boolean(job.cancelRequested),
    canceledAt: job.canceledAt || null,
    project: job.project,
    artifactBase: job.artifactBase || `/artifacts/jobs/${id}`,
    downloads: {
      json: `/api/jobs/${id}/export.json`,
      markdown: `/api/jobs/${id}/agent-handoff.md`
    }
  };
}

export async function saveJob(job) {
  await fs.mkdir(job.outputDir, { recursive: true });
  await fs.writeFile(path.join(job.outputDir, "job.json"), JSON.stringify(sanitizeJob(job), null, 2));
}

export async function loadJob({ artifactsRoot, id }) {
  const jobPath = path.join(artifactsRoot, "jobs", id, "job.json");
  const raw = await fs.readFile(jobPath, "utf8");
  const job = JSON.parse(raw);
  job.id = job.id || id;
  job.outputDir = job.outputDir || path.join(artifactsRoot, "jobs", job.id);
  return job;
}

function numberValue(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function costValue(cost) {
  return cost && typeof cost === "object" ? cost : null;
}

function addCost(summary, cost, process) {
  const value = costValue(cost);
  if (!value) return;
  summary.processes.push({
    process,
    priced: Boolean(value.priced),
    estimatedUsd: value.estimatedUsd,
    inputTokens: numberValue(value.inputTokens),
    outputTokens: numberValue(value.outputTokens),
    totalTokens: numberValue(value.totalTokens),
    model: value.model || "",
    provider: value.provider || ""
  });
  summary.inputTokens += numberValue(value.inputTokens);
  summary.outputTokens += numberValue(value.outputTokens);
  summary.totalTokens += numberValue(value.totalTokens);
  if (value.priced && value.estimatedUsd !== null && value.estimatedUsd !== undefined) {
    summary.pricedProcessCount += 1;
    summary.estimatedUsd += numberValue(value.estimatedUsd);
  } else {
    summary.unpricedProcessCount += 1;
  }
}

export function summarizeJobCosts(job) {
  const summary = {
    currency: "USD",
    estimatedUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    pricedProcessCount: 0,
    unpricedProcessCount: 0,
    processCount: 0,
    costsAreEstimated: true,
    source: "https://ai.google.dev/gemini-api/docs/pricing",
    sourceDate: "2026-06-22",
    processes: []
  };

  for (const result of job.results || []) {
    addCost(summary, result.cost || result.metadata?.geminiCost, {
      type: "recording_analysis",
      recordingId: result.recording?.id || ""
    });
  }
  addCost(summary, job.synthesisCost, { type: "batch_synthesis" });

  summary.processCount = summary.processes.length;
  summary.estimatedUsd = Number(summary.estimatedUsd.toFixed(8));
  return summary;
}

export function applyRecordingFilters(recording, jobConfig) {
  if (!jobConfig.includeOngoing && recording.ongoing) return false;
  if (Number(recording.recording_duration || 0) < jobConfig.minRecordingSeconds) return false;
  if (Number(recording.active_seconds || 0) < jobConfig.minActiveSeconds) return false;
  if (Number(recording.click_count || 0) < jobConfig.minClicks) return false;
  if (Number(recording.keypress_count || 0) < jobConfig.minKeypresses) return false;
  if (jobConfig.filterStaleRecordings) {
    const active = Number(recording.active_seconds || 0);
    const clicks = Number(recording.click_count || 0);
    const keys = Number(recording.keypress_count || 0);
    const mouse = Number(recording.mouse_activity_count || 0);
    const activityScore = recordingActivityScore(recording);
    const hasAnyMeaningfulActivity = active >= 2 || clicks > 0 || keys > 0 || mouse >= 5;
    if (!hasAnyMeaningfulActivity || activityScore < jobConfig.minActivityScore) return false;
  }

  if (jobConfig.maxAgeDays > 0 && recording.start_time) {
    const startedAt = new Date(recording.start_time).getTime();
    const cutoff = Date.now() - jobConfig.maxAgeDays * 24 * 60 * 60 * 1000;
    if (Number.isFinite(startedAt) && startedAt < cutoff) return false;
  }

  const url = String(recording.start_url || recording.url || "");
  const userIncludes = splitTerms(jobConfig.userIncludes);
  if (userIncludes.length && !recordingMatchesUserTerms(recording, userIncludes)) return false;

  const includes = splitTerms(jobConfig.urlIncludes);
  if (includes.length && !includes.some((term) => url.includes(term))) return false;

  const excludes = splitTerms(jobConfig.urlExcludes);
  if (excludes.some((term) => url.includes(term))) return false;

  return true;
}

export function recordingScanLimit(jobConfig) {
  return splitTerms(jobConfig.userIncludes).length
    ? Math.max(jobConfig.candidateLimit, 5000)
    : jobConfig.candidateLimit;
}

export function recordingQueryLimit(jobConfig) {
  const queryTerms = [
    ...splitTerms(jobConfig.userIncludes),
    ...splitTerms(jobConfig.urlIncludes),
    ...splitTerms(jobConfig.urlExcludes)
  ];
  return queryTerms.length
    ? Math.min(1000, Math.max(250, jobConfig.candidateLimit * 5))
    : 0;
}

async function loadCandidateSourceRecordings({ config, projectId, jobConfig }) {
  const userTerms = splitTerms(jobConfig.userIncludes);
  const urlIncludes = splitTerms(jobConfig.urlIncludes);
  const urlExcludes = splitTerms(jobConfig.urlExcludes);
  const queryLimit = recordingQueryLimit(jobConfig);
  if (queryLimit > 0) {
    try {
      const recordingIds = await querySessionRecordingIds(config, projectId, {
        userTerms,
        urlIncludes,
        urlExcludes,
        maxAgeDays: jobConfig.maxAgeDays,
        limit: queryLimit
      });
      const recordings = await fetchRecordingsByIds(config, projectId, recordingIds);
      return { recordings, source: "hogql", queryLimit };
    } catch (error) {
      const scanLimit = recordingScanLimit(jobConfig);
      const recordings = await listRecordings(config, projectId, jobConfig.candidateLimit, { maxResults: scanLimit });
      return { recordings, source: "list", scanLimit, queryError: error.message };
    }
  }

  const scanLimit = recordingScanLimit(jobConfig);
  const recordings = await listRecordings(config, projectId, jobConfig.candidateLimit, { maxResults: scanLimit });
  return { recordings, source: "list", scanLimit };
}

export async function listFilteredRecordings({ config, projectId, jobConfig }) {
  const source = await loadCandidateSourceRecordings({ config, projectId, jobConfig });
  const allRecordings = source.recordings;
  const selected = selectRecordings({ recordings: allRecordings, jobConfig, budget: jobConfig.candidateLimit });
  return {
    recordings: selected,
    diagnostics: {
      scanned: allRecordings.length,
      matchedFilters: allRecordings.filter((recording) => applyRecordingFilters(recording, jobConfig)).length,
      selected: selected.length,
      scanLimit: source.scanLimit || source.queryLimit || allRecordings.length,
      source: source.source,
      queryError: source.queryError || null,
      deepUserScan: splitTerms(jobConfig.userIncludes).length > 0 || source.source === "hogql"
    }
  };
}

export function selectRecordings({ recordings, jobConfig, explicitIds = new Set(), budget = jobConfig.count * 4 }) {
  const selected = [];
  const seenIds = new Set();
  const seenDuplicateKeys = new Set();
  const userCounts = new Map();
  const hasUserFilter = splitTerms(jobConfig.userIncludes).length > 0;
  const sorted = [...recordings].sort((a, b) => recordingScore(b) - recordingScore(a));

  for (const recording of sorted) {
    if (selected.length >= budget) break;
    if (seenIds.has(recording.id)) continue;
    if (!explicitIds.size && !applyRecordingFilters(recording, jobConfig)) continue;

    const duplicateKey = recordingDuplicateKey(recording);
    if (!explicitIds.size && jobConfig.dedupeSimilar && seenDuplicateKeys.has(duplicateKey)) continue;

    const userKey = recordingUserKey(recording);
    const currentUserCount = userCounts.get(userKey) || 0;
    if (
      !explicitIds.size &&
      !hasUserFilter &&
      jobConfig.diversifyUsers &&
      jobConfig.maxPerUser > 0 &&
      currentUserCount >= jobConfig.maxPerUser
    ) {
      continue;
    }

    seenIds.add(recording.id);
    seenDuplicateKeys.add(duplicateKey);
    userCounts.set(userKey, currentUserCount + 1);
    selected.push(recording);
  }

  return selected;
}

function isCapacityError(error) {
  return /429|quota|rate limit|rate-limit|throttled|Expected available/i.test(error?.message || "");
}

function cancelError() {
  const error = new Error("Canceled by user");
  error.name = "AbortError";
  error.canceled = true;
  return error;
}

function isCanceledError(error) {
  return Boolean(error?.canceled) || error?.name === "AbortError" || /Canceled by user|aborted/i.test(error?.message || "");
}

function isTerminalStatus(status) {
  return ["completed", "partial", "failed", "canceled"].includes(status);
}

function throwIfCanceled(job) {
  if (job.cancelRequested) throw cancelError();
}

export function requestJobCancel(job) {
  if (!job || isTerminalStatus(job.status)) return job;
  job.cancelRequested = true;
  job.canceledAt = job.canceledAt || new Date().toISOString();
  job.status = "canceling";
  job.progress = job.progress || {};
  job.progress.message = "Cancel requested; stopping active work and saving completed results";
  job.abortController?.abort();
  return job;
}

export function markJobInterrupted(job, message = "Interrupted after local server restart; completed results were kept.") {
  if (!job || isTerminalStatus(job.status)) return job;
  job.status = job.results?.length ? "partial" : "failed";
  job.error = job.error || "The local server stopped before this batch finished.";
  job.finishedAt = job.finishedAt || new Date().toISOString();
  job.cancelRequested = false;
  job.progress = job.progress || {};
  job.progress.activeRecordings = [];
  job.progress.activeRecordingIds = [];
  job.progress.currentRecordingId = null;
  job.progress.message = message;
  return job;
}

function makeJobSaver(save, job) {
  let saveQueue = Promise.resolve();
  return async function persistJob() {
    saveQueue = saveQueue.catch(() => {}).then(() => save(job));
    return saveQueue;
  };
}

function setRecordingStage(job, recordingId, stage) {
  const activeRecordings = (job.progress.activeRecordings || [])
    .filter((item) => item.id !== recordingId);
  if (stage) activeRecordings.push({ id: recordingId, stage });
  job.progress.activeRecordings = activeRecordings;
  job.progress.activeRecordingIds = activeRecordings.map((item) => item.id);
  job.progress.currentRecordingId = activeRecordings[0]?.id || null;

  if (activeRecordings.length) {
    const summary = activeRecordings
      .map((item) => `${item.stage} ${item.id}`)
      .join("; ");
    job.progress.message = `Processing ${activeRecordings.length} replay${activeRecordings.length === 1 ? "" : "s"}: ${summary}`;
  }
}

async function processRecording({ recording, job, config, geminiConfig, projectId, persist }) {
  const compact = compactRecording(recording, { config, projectId });
  const recordingDir = path.join(job.outputDir, recording.id);
  try {
    throwIfCanceled(job);
    setRecordingStage(job, recording.id, "rendering");
    await persist();
    const clip = await renderReplayClip({
      config,
      projectId,
      recording: compact,
      outputDir: recordingDir,
      speed: job.config.speed,
      minSeconds: job.config.minClipSeconds,
      maxSeconds: job.config.maxClipSeconds,
      width: job.config.width,
      height: job.config.height,
      signal: job.abortController?.signal
    });
    if (clip.metadata.mp4Bytes < job.config.minMp4Bytes) {
      throw new Error(`Rendered MP4 is too small (${clip.metadata.mp4Bytes} bytes), likely blank.`);
    }

    throwIfCanceled(job);
    setRecordingStage(job, recording.id, "analyzing");
    await persist();
    const analysisResult = await analyzeReplayWithGeminiDetailed({
      config: geminiConfig,
      mp4Path: clip.mp4Path,
      metadata: {
        ...clip.metadata,
        analysisFocus: job.config.analysisFocus || undefined,
        geminiModel: geminiConfig.geminiModel
      },
      analysisFocus: job.config.analysisFocus,
      signal: job.abortController?.signal
    });
    const analysis = analysisResult.analysis;
    const metadata = {
      ...clip.metadata,
      geminiUsage: analysisResult.usageMetadata,
      geminiCost: analysisResult.cost
    };
    const analysisPath = path.join(recordingDir, "analysis.json");
    await fs.writeFile(analysisPath, JSON.stringify(analysis, null, 2));
    await fs.writeFile(path.join(recordingDir, `${recording.id}-metadata.json`), JSON.stringify(metadata, null, 2));

    if (job.results.length < job.config.count) {
      job.results.push({
        recording: compact,
        analysis,
        artifacts: {
          mp4: `/artifacts/jobs/${job.id}/${recording.id}/${path.basename(clip.mp4Path)}`,
          html: `/artifacts/jobs/${job.id}/${recording.id}/${path.basename(clip.htmlPath)}`,
          analysis: `/artifacts/jobs/${job.id}/${recording.id}/analysis.json`,
          metadata: `/artifacts/jobs/${job.id}/${recording.id}/${recording.id}-metadata.json`
        },
        metadata,
        cost: analysisResult.cost
      });
    }
    return { ok: true, recording: compact };
  } catch (error) {
    if (isCanceledError(error) || job.cancelRequested) {
      return { ok: false, recording: compact, canceled: true };
    }
    job.failures.push({ recording: compact, error: error.message });
    return { ok: false, recording: compact, error, stop: isCapacityError(error) };
  } finally {
    setRecordingStage(job, recording.id, null);
    job.progress.completed = job.results.length;
    if (!job.progress.activeRecordingIds.length) {
      job.progress.message = job.results.length >= job.config.count
        ? "Target count reached"
        : "Waiting for next replay";
    }
    await persist();
  }
}

async function processCandidates({ candidates, job, config, geminiConfig, projectId, persist }) {
  const parallelism = Math.max(1, Number(job.config.parallelism || 1));
  const inFlight = new Set();
  let cursor = 0;
  let stop = false;

  function launchAvailable() {
    while (
      !stop &&
      !job.cancelRequested &&
      cursor < candidates.length &&
      inFlight.size < parallelism &&
      job.results.length + inFlight.size < job.config.count
    ) {
      const recording = candidates[cursor];
      cursor += 1;
      const task = processRecording({ recording, job, config, geminiConfig, projectId, persist })
        .finally(() => {
          inFlight.delete(task);
        });
      inFlight.add(task);
    }
  }

  launchAvailable();
  while (inFlight.size) {
    const outcome = await Promise.race(inFlight);
    if (outcome?.stop) stop = true;
    if (outcome?.canceled || job.cancelRequested) stop = true;
    launchAvailable();
  }
}

export async function runJob({ job, config, save = saveJob }) {
  try {
    const geminiConfig = {
      ...config,
      geminiModel: job.config.geminiModel || config.geminiModel
    };
    const persist = makeJobSaver(save, job);
    job.abortController = new AbortController();
    job.status = "running";
    await persist();
    throwIfCanceled(job);
    const project = await discoverProject(config);
    job.project = { id: project.id, name: project.name };
    throwIfCanceled(job);
    const explicitIds = new Set(job.config.recordingIds || []);
    const source = explicitIds.size
      ? { recordings: await fetchRecordingsByIds(config, project.id, [...explicitIds]), source: "explicit" }
      : await loadCandidateSourceRecordings({ config, projectId: project.id, jobConfig: job.config });
    const candidatePool = source.recordings;
    const candidates = selectRecordings({
      recordings: candidatePool,
      jobConfig: job.config,
      explicitIds,
      budget: job.config.count * 4
    });

    job.selectedRecordings = candidates.map((recording) => compactRecording(recording, { config, projectId: project.id }));
    await persist();
    throwIfCanceled(job);

    await processCandidates({
      candidates,
      job,
      config,
      geminiConfig,
      projectId: project.id,
      persist
    });

    if (!job.cancelRequested && job.results.length > 0) {
      job.progress.message = "Synthesizing aggregate report";
      await persist();
      const synthesisResult = await synthesizeBatchDetailed({
        config: geminiConfig,
        analysisFocus: job.config.analysisFocus,
        analyses: job.results.map((result) => ({
          recordingId: result.recording.id,
          recording: result.recording,
          analysis: result.analysis
        })),
        signal: job.abortController?.signal
      });
      job.synthesis = synthesisResult.synthesis;
      job.synthesisUsage = synthesisResult.usageMetadata;
      job.synthesisCost = synthesisResult.cost;
      await fs.writeFile(path.join(job.outputDir, "aggregate-report.json"), JSON.stringify(job.synthesis, null, 2));
    }

    job.status = job.cancelRequested ? "canceled" : job.results.length >= job.config.count ? "completed" : "partial";
    job.finishedAt = new Date().toISOString();
    job.progress.activeRecordings = [];
    job.progress.activeRecordingIds = [];
    job.progress.currentRecordingId = null;
    if (job.status === "completed") job.progress.message = "Done";
    else if (job.status === "canceled") job.progress.message = `Canceled; saved ${job.results.length} completed result${job.results.length === 1 ? "" : "s"}`;
    else job.progress.message = "Stopped before target count";
    await persist();
  } catch (error) {
    if (isCanceledError(error) || job.cancelRequested) {
      job.status = "canceled";
      job.error = null;
      job.cancelRequested = true;
      job.canceledAt = job.canceledAt || new Date().toISOString();
      job.progress.activeRecordings = [];
      job.progress.activeRecordingIds = [];
      job.progress.currentRecordingId = null;
      job.progress.message = `Canceled; saved ${job.results.length} completed result${job.results.length === 1 ? "" : "s"}`;
    } else {
      job.status = "failed";
      job.error = error.stack || error.message;
      job.progress.message = "Failed";
    }
    job.finishedAt = new Date().toISOString();
    await save(job).catch(() => {});
  }
  return job;
}

export function buildExportPayload(job) {
  const safe = sanitizeJob(job);
  return {
    exportedAt: new Date().toISOString(),
    app: "replay_lens",
    job: safe,
    agentInstructions: [
      "Use recording IDs, artifact URLs, and visual evidence before proposing fixes.",
      "Treat exact_bugs as evidence-backed. Treat ux_friction and open_questions as leads that need confirmation.",
      "Do not infer customer identity or unmasked private data from replay artifacts."
    ]
  };
}

function inlineJson(value) {
  return JSON.stringify(value ?? null, null, 2);
}

function listBugMarkdown(bugs = []) {
  if (!Array.isArray(bugs) || !bugs.length) return "- None reported.\n";
  return bugs
    .map((bug, index) => {
      const title = bug.title || `Bug ${index + 1}`;
      const severity = bug.severity || "unknown";
      const evidence = bug.visual_evidence || bug.evidence || bug.user_impact || "No evidence text.";
      const recordings = bug.affected_recording_ids ? `\n  - Recordings: ${bug.affected_recording_ids.join(", ")}` : "";
      return `- ${title} (${severity})\n  - Evidence: ${evidence}${recordings}`;
    })
    .join("\n");
}

function formatEstimatedCost(cost) {
  if (!cost || cost.estimatedUsd === null || cost.estimatedUsd === undefined) return "n/a";
  if (
    cost.processCount === 0 &&
    cost.pricedProcessCount === 0 &&
    cost.unpricedProcessCount === 0
  ) {
    return "n/a";
  }
  const value = Number(cost.estimatedUsd || 0);
  if (value > 0 && value < 0.01) return `$${value.toFixed(4)} est.`;
  return `$${value.toFixed(2)} est.`;
}

export function buildAgentHandoffMarkdown(job) {
  const safe = sanitizeJob(job);
  const lines = [
    "# Replay Lens Agent Handoff",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Job: ${safe.id}`,
    `Status: ${safe.status}`,
    `Project: ${safe.project?.name || "unknown"} (${safe.project?.id || "unknown"})`,
    `Estimated Gemini cost: ${formatEstimatedCost(safe.costs)} (${Number(safe.costs?.inputTokens || 0).toLocaleString()} input tokens, ${Number(safe.costs?.outputTokens || 0).toLocaleString()} output tokens)`,
    "",
    "## Run Config",
    "",
    "```json",
    inlineJson(safe.config),
    "```",
    "",
    "## Aggregate Summary",
    "",
    safe.synthesis?.executive_summary || "No aggregate summary generated.",
    "",
    "## Prioritized Exact Bugs",
    "",
    listBugMarkdown(safe.synthesis?.exact_bugs_prioritized),
    "",
    "## Per-Recording Findings",
    ""
  ];

  for (const result of safe.results || []) {
    lines.push(`### ${result.recording?.id || "Recording"}`);
    lines.push("");
    lines.push(`- URL: ${result.recording?.url || "unknown"}`);
    lines.push(`- MP4: ${result.artifacts?.mp4 || "not available"}`);
    lines.push(`- Analysis JSON: ${result.artifacts?.analysis || "not available"}`);
    lines.push(`- Estimated Gemini cost: ${formatEstimatedCost(result.cost || result.metadata?.geminiCost)}`);
    lines.push(`- Summary: ${result.analysis?.summary || "No summary returned."}`);
    lines.push("");
    lines.push("Exact bugs:");
    lines.push(listBugMarkdown(result.analysis?.exact_bugs));
    lines.push("");
    if (Array.isArray(result.analysis?.frustration_signals) && result.analysis.frustration_signals.length) {
      lines.push("Frustration signals:");
      for (const signal of result.analysis.frustration_signals) {
        lines.push(`- ${signal.timestamp_estimate || "n/a"}: ${signal.signal || signal.evidence || "Signal"}`);
      }
      lines.push("");
    }
  }

  if (safe.failures?.length) {
    lines.push("## Failures");
    lines.push("");
    for (const failure of safe.failures) {
      lines.push(`- ${failure.recording?.id || "unknown"}: ${failure.error}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
}
