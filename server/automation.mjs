import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { buildAgentHandoffMarkdown, summarizeJobCosts } from "./job-runner.mjs";

const STATE_VERSION = 1;

function boolValue(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function numberValue(value, fallback, min, max) {
  const parsed = Number(value);
  const safe = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, safe));
}

function stringValue(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function splitList(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  return String(value || "")
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function stableHash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .slice(0, 180);
}

function automationDir(artifactsRoot) {
  return path.join(artifactsRoot, "automation");
}

function automationStatePath(artifactsRoot) {
  return path.join(automationDir(artifactsRoot), "state.json");
}

export function automationConfigFromEnv(env = process.env) {
  return {
    enabled: boolValue(env.AUTOMATION_ENABLED, false),
    runOnStart: boolValue(env.AUTOMATION_RUN_ON_START, false),
    intervalHours: numberValue(env.AUTOMATION_INTERVAL_HOURS, 5, 0.25, 168),
    count: numberValue(env.AUTOMATION_COUNT, 10, 1, 30),
    parallelism: numberValue(env.AUTOMATION_PARALLELISM, 2, 1, 5),
    candidateLimit: numberValue(env.AUTOMATION_CANDIDATE_LIMIT, 150, 10, 250),
    speed: numberValue(env.AUTOMATION_SPEED, 12, 1, 60),
    minRecordingSeconds: numberValue(env.AUTOMATION_MIN_RECORDING_SECONDS, 60, 0, 7200),
    minActiveSeconds: numberValue(env.AUTOMATION_MIN_ACTIVE_SECONDS, 20, 0, 7200),
    minActivityScore: numberValue(env.AUTOMATION_MIN_ACTIVITY_SCORE, 10, 0, 100000),
    minClicks: numberValue(env.AUTOMATION_MIN_CLICKS, 0, 0, 10000),
    maxAgeDays: numberValue(env.AUTOMATION_MAX_AGE_DAYS, 7, 0, 365),
    maxPerUser: numberValue(env.AUTOMATION_MAX_PER_USER, 1, 0, 25),
    includeOngoing: boolValue(env.AUTOMATION_INCLUDE_ONGOING, false),
    filterStaleRecordings: boolValue(env.AUTOMATION_FILTER_STALE_RECORDINGS, true),
    dedupeSimilar: boolValue(env.AUTOMATION_DEDUPE_SIMILAR, true),
    diversifyUsers: boolValue(env.AUTOMATION_DIVERSIFY_USERS, true),
    minClipSeconds: numberValue(env.AUTOMATION_MIN_CLIP_SECONDS, 12, 6, 60),
    maxClipSeconds: numberValue(env.AUTOMATION_MAX_CLIP_SECONDS, 45, 10, 90),
    urlIncludes: stringValue(env.AUTOMATION_URL_INCLUDES),
    urlExcludes: stringValue(env.AUTOMATION_URL_EXCLUDES),
    userIncludes: stringValue(env.AUTOMATION_USER_INCLUDES),
    geminiModel: stringValue(env.AUTOMATION_GEMINI_MODEL),
    analysisFocus: stringValue(
      env.AUTOMATION_ANALYSIS_FOCUS,
      "Primary: find evidence-backed production bugs, user frustration, broken flows, confusing states, failed actions, and exact UI issues. Secondary: summarize key Beakr use cases, customer workflows, feature adoption, and how people are using the product. Ignore PostHog replay capture artifacts."
    ),
    slackWebhookUrl: stringValue(env.SLACK_WEBHOOK_URL),
    slackMention: stringValue(env.SLACK_MENTION),
    baseUrl: publicBaseUrl(env)
  };
}

export function publicBaseUrl(env = process.env) {
  const raw = env.REPLAY_LENS_PUBLIC_URL || env.RAILWAY_SERVICE_REPLAY_LENS_URL || env.RAILWAY_STATIC_URL || env.RAILWAY_PUBLIC_DOMAIN || "";
  if (!raw) return "";
  return raw.startsWith("http") ? raw.replace(/\/+$/, "") : `https://${raw.replace(/\/+$/, "")}`;
}

export function automationPublicConfig(config) {
  return {
    enabled: config.enabled,
    runOnStart: config.runOnStart,
    intervalHours: config.intervalHours,
    count: config.count,
    parallelism: config.parallelism,
    candidateLimit: config.candidateLimit,
    speed: config.speed,
    minRecordingSeconds: config.minRecordingSeconds,
    minActiveSeconds: config.minActiveSeconds,
    minActivityScore: config.minActivityScore,
    maxAgeDays: config.maxAgeDays,
    maxPerUser: config.maxPerUser,
    includeOngoing: config.includeOngoing,
    filterStaleRecordings: config.filterStaleRecordings,
    dedupeSimilar: config.dedupeSimilar,
    diversifyUsers: config.diversifyUsers,
    minClipSeconds: config.minClipSeconds,
    maxClipSeconds: config.maxClipSeconds,
    urlIncludes: config.urlIncludes,
    urlExcludes: config.urlExcludes,
    userIncludes: config.userIncludes,
    geminiModel: config.geminiModel,
    hasSlackWebhook: Boolean(config.slackWebhookUrl),
    slackMention: config.slackMention,
    baseUrl: config.baseUrl
  };
}

function defaultState() {
  return {
    version: STATE_VERSION,
    updatedAt: new Date().toISOString(),
    seenRecordingIds: [],
    runs: [],
    issues: []
  };
}

export async function loadAutomationState(artifactsRoot) {
  try {
    const raw = await fs.readFile(automationStatePath(artifactsRoot), "utf8");
    const state = JSON.parse(raw);
    return {
      ...defaultState(),
      ...state,
      seenRecordingIds: Array.isArray(state.seenRecordingIds) ? state.seenRecordingIds : [],
      runs: Array.isArray(state.runs) ? state.runs : [],
      issues: Array.isArray(state.issues) ? state.issues : []
    };
  } catch (error) {
    if (error.code === "ENOENT") return defaultState();
    throw error;
  }
}

export async function saveAutomationState(artifactsRoot, state) {
  await fs.mkdir(automationDir(artifactsRoot), { recursive: true });
  state.version = STATE_VERSION;
  state.updatedAt = new Date().toISOString();
  await fs.writeFile(automationStatePath(artifactsRoot), JSON.stringify(state, null, 2));
}

export function buildAutomationJobConfig(config, state) {
  return {
    count: config.count,
    parallelism: config.parallelism,
    candidateLimit: config.candidateLimit,
    speed: config.speed,
    minRecordingSeconds: config.minRecordingSeconds,
    minActiveSeconds: config.minActiveSeconds,
    minActivityScore: config.minActivityScore,
    minClicks: config.minClicks,
    maxAgeDays: config.maxAgeDays,
    maxPerUser: config.maxPerUser,
    minClipSeconds: config.minClipSeconds,
    maxClipSeconds: config.maxClipSeconds,
    urlIncludes: config.urlIncludes,
    urlExcludes: config.urlExcludes,
    userIncludes: config.userIncludes,
    geminiModel: config.geminiModel,
    analysisFocus: config.analysisFocus,
    includeOngoing: config.includeOngoing,
    filterStaleRecordings: config.filterStaleRecordings,
    dedupeSimilar: config.dedupeSimilar,
    diversifyUsers: config.diversifyUsers,
    excludeRecordingIds: state.seenRecordingIds || []
  };
}

function jobUrl(config, jobId) {
  return config.baseUrl ? `${config.baseUrl}/?job=${encodeURIComponent(jobId)}` : "";
}

function recordingUrl(config, result) {
  if (!config.baseUrl || !result?.artifacts?.mp4) return "";
  return `${config.baseUrl}${result.artifacts.mp4}`;
}

function issueRecordingContext(result) {
  const recording = result?.recording || {};
  return {
    id: recording.id || "",
    url: recording.url || "",
    route: recording.route || "",
    user: recording.user || "user_unknown",
    startedAt: recording.start_time || "",
    duration: recording.duration || 0,
    posthogUrl: recording.posthogUrl || "",
    artifactUrl: result?.artifacts?.mp4 || ""
  };
}

function issueFromSynthesisBug(bug, job, config, index) {
  const title = bug?.title || `Bug ${index + 1}`;
  const evidence = bug?.evidence || bug?.visual_evidence || bug?.user_impact || "";
  const key = normalizeText(`${title} ${bug?.suspected_root_cause || ""} ${evidence}`);
  return {
    id: `issue_${stableHash(key || `${job.id}:${index}`)}`,
    title,
    severity: bug?.severity || "unknown",
    confidence: bug?.confidence || "",
    evidence,
    userImpact: bug?.user_impact || "",
    suspectedRootCause: bug?.suspected_root_cause || "",
    reproductionSteps: bug?.reproduction_steps || [],
    affectedRecordingIds: Array.isArray(bug?.affected_recording_ids) ? bug.affected_recording_ids.map(String) : [],
    source: "batch_synthesis",
    jobId: job.id,
    jobUrl: jobUrl(config, job.id)
  };
}

function issueFromRecordingBug(bug, result, job, config, index) {
  const title = bug?.title || `Recording bug ${index + 1}`;
  const evidence = bug?.visual_evidence || bug?.evidence || bug?.user_impact || "";
  const recordingId = result?.recording?.id || "";
  const key = normalizeText(`${title} ${result?.recording?.route || result?.recording?.url || ""} ${evidence}`);
  return {
    id: `issue_${stableHash(key || `${job.id}:${recordingId}:${index}`)}`,
    title,
    severity: bug?.severity || "unknown",
    confidence: bug?.confidence || "",
    evidence,
    userImpact: bug?.user_impact || "",
    suspectedRootCause: bug?.why_this_is_a_bug || "",
    reproductionSteps: bug?.reproduction_steps || [],
    affectedRecordingIds: recordingId ? [recordingId] : [],
    affectedRecordings: recordingId ? [issueRecordingContext(result)] : [],
    source: "recording_analysis",
    jobId: job.id,
    jobUrl: jobUrl(config, job.id),
    artifactUrl: recordingUrl(config, result)
  };
}

export function extractIssues(job, config) {
  const issues = [];
  const recordingContextById = new Map(
    (job.results || [])
      .map((result) => [result.recording?.id, issueRecordingContext(result)])
      .filter(([id]) => id)
  );
  const synthesisBugs = Array.isArray(job.synthesis?.exact_bugs_prioritized) ? job.synthesis.exact_bugs_prioritized : [];
  synthesisBugs.forEach((bug, index) => issues.push(issueFromSynthesisBug(bug, job, config, index)));

  for (const result of job.results || []) {
    const bugs = Array.isArray(result.analysis?.exact_bugs) ? result.analysis.exact_bugs : [];
    bugs.forEach((bug, index) => issues.push(issueFromRecordingBug(bug, result, job, config, index)));
  }

  const byId = new Map();
  for (const issue of issues) {
    const existing = byId.get(issue.id);
    if (!existing) {
      byId.set(issue.id, issue);
      continue;
    }
    existing.affectedRecordingIds = [...new Set([...(existing.affectedRecordingIds || []), ...(issue.affectedRecordingIds || [])])];
    existing.affectedRecordings = [...(existing.affectedRecordings || []), ...(issue.affectedRecordings || [])]
      .filter((recording, recordingIndex, all) => recording?.id && all.findIndex((item) => item.id === recording.id) === recordingIndex);
    existing.evidence = existing.evidence || issue.evidence;
  }
  return [...byId.values()].map((issue) => ({
    ...issue,
    affectedRecordings: [
      ...(issue.affectedRecordings || []),
      ...(issue.affectedRecordingIds || []).map((id) => recordingContextById.get(id)).filter(Boolean)
    ].filter((recording, index, all) => recording?.id && all.findIndex((item) => item.id === recording.id) === index)
  }));
}

function mergeIssue(existing, issue, job) {
  const now = new Date().toISOString();
  if (!existing) {
    return {
      ...issue,
      status: "open",
      firstSeenAt: now,
      lastSeenAt: now,
      occurrenceCount: 1,
      affectedRecordingIds: [...new Set(issue.affectedRecordingIds || [])],
      affectedRecordings: [...new Map((issue.affectedRecordings || []).map((recording) => [recording.id, recording])).values()],
      jobs: [{ id: job.id, startedAt: job.startedAt, finishedAt: job.finishedAt, url: issue.jobUrl }]
    };
  }
  return {
    ...existing,
    severity: issue.severity || existing.severity,
    confidence: issue.confidence || existing.confidence,
    evidence: issue.evidence || existing.evidence,
    userImpact: issue.userImpact || existing.userImpact,
    suspectedRootCause: issue.suspectedRootCause || existing.suspectedRootCause,
    reproductionSteps: issue.reproductionSteps?.length ? issue.reproductionSteps : existing.reproductionSteps,
    lastSeenAt: now,
    occurrenceCount: Number(existing.occurrenceCount || 0) + 1,
    affectedRecordingIds: [...new Set([...(existing.affectedRecordingIds || []), ...(issue.affectedRecordingIds || [])])],
    affectedRecordings: [
      ...new Map([...(existing.affectedRecordings || []), ...(issue.affectedRecordings || [])].map((recording) => [recording.id, recording])).values()
    ].slice(0, 20),
    jobs: [
      { id: job.id, startedAt: job.startedAt, finishedAt: job.finishedAt, url: issue.jobUrl },
      ...(existing.jobs || []).filter((entry) => entry.id !== job.id)
    ].slice(0, 20)
  };
}

export function updateStateFromJob(state, job, config) {
  const next = {
    ...defaultState(),
    ...state,
    seenRecordingIds: Array.isArray(state.seenRecordingIds) ? [...state.seenRecordingIds] : [],
    runs: Array.isArray(state.runs) ? [...state.runs] : [],
    issues: Array.isArray(state.issues) ? [...state.issues] : []
  };
  const seen = new Set(next.seenRecordingIds);
  for (const result of job.results || []) {
    if (result.recording?.id) seen.add(result.recording.id);
  }
  next.seenRecordingIds = [...seen];

  const newIssues = extractIssues(job, config);
  const issueMap = new Map(next.issues.map((issue) => [issue.id, issue]));
  for (const issue of newIssues) {
    issueMap.set(issue.id, mergeIssue(issueMap.get(issue.id), issue, job));
  }
  next.issues = [...issueMap.values()]
    .sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)))
    .slice(0, 500);

  next.runs = [
    {
      id: job.id,
      jobId: job.id,
      status: job.status,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      resultCount: job.results?.length || 0,
      failureCount: job.failures?.length || 0,
      issueCount: newIssues.length,
      summary: job.synthesis?.executive_summary || job.progress?.message || "",
      jobUrl: jobUrl(config, job.id),
      costs: summarizeJobCosts(job)
    },
    ...next.runs.filter((run) => run.id !== job.id)
  ].slice(0, 100);

  next.lastRunAt = job.finishedAt || new Date().toISOString();
  next.updatedAt = new Date().toISOString();
  return { state: next, newIssues };
}

function slackLink(url, label) {
  if (!url) return label;
  return `<${url}|${String(label || url).replace(/[<>|]/g, " ")}>`;
}

function issuePostHogLinks(issue) {
  return (issue.affectedRecordings || [])
    .map((recording) => recording.posthogUrl ? slackLink(recording.posthogUrl, recording.startedAt ? `${recording.user} ${recording.startedAt.slice(0, 10)}` : recording.user) : "")
    .filter(Boolean)
    .slice(0, 3);
}

function resultPostHogLinks(job) {
  return (job.results || [])
    .map((result, index) => result.recording?.posthogUrl ? slackLink(result.recording.posthogUrl, `replay ${index + 1}`) : "")
    .filter(Boolean)
    .slice(0, 10);
}

function issueLine(issue, index) {
  const severity = issue.severity && issue.severity !== "unknown" ? ` (${issue.severity})` : "";
  const recordings = issue.affectedRecordingIds?.length ? ` - ${issue.affectedRecordingIds.length} replay${issue.affectedRecordingIds.length === 1 ? "" : "s"}` : "";
  const posthogLinks = issuePostHogLinks(issue);
  const links = posthogLinks.length ? ` - PostHog: ${posthogLinks.join(", ")}` : "";
  return `${index + 1}. ${issue.title}${severity}${recordings}${links}`;
}

function insightText(item, keys) {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return "";
  for (const key of keys) {
    if (item[key]) return String(item[key]);
  }
  return item.summary || item.pattern || item.title || item.evidence || "";
}

function recordingCountSuffix(item) {
  const count = Array.isArray(item?.affected_recording_ids) ? item.affected_recording_ids.length : 0;
  return count ? ` - ${count} replay${count === 1 ? "" : "s"}` : "";
}

function insightLine(item, index, keys) {
  const text = insightText(item, keys);
  const suffix = recordingCountSuffix(item);
  const implication = item?.implication ? ` Implication: ${item.implication}` : "";
  return text ? `${index + 1}. ${text}${suffix}.${implication}` : "";
}

export function buildSlackText({ job, config, newIssues, state }) {
  const lines = [];
  const prefix = config.slackMention ? `${config.slackMention} ` : "";
  lines.push(`${prefix}Replay Lens finished ${job.status}: ${job.results?.length || 0} analyzed, ${job.failures?.length || 0} failed, ${newIssues.length} issue${newIssues.length === 1 ? "" : "s"} flagged.`);
  if (job.synthesis?.executive_summary) lines.push(`Summary: ${job.synthesis.executive_summary}`);
  if (newIssues.length) {
    lines.push("Top flagged issues:");
    newIssues.slice(0, 8).forEach((issue, index) => lines.push(issueLine(issue, index)));
  } else {
    lines.push("No exact bugs were flagged in this run.");
  }
  const keyUseCases = Array.isArray(job.synthesis?.key_use_cases) ? job.synthesis.key_use_cases : [];
  if (keyUseCases.length) {
    lines.push("Key Beakr use cases:");
    keyUseCases.slice(0, 5).forEach((item, index) => {
      const line = insightLine(item, index, ["use_case", "insight", "summary"]);
      if (line) lines.push(line);
    });
  }
  const customerInsights = Array.isArray(job.synthesis?.customer_insights) ? job.synthesis.customer_insights : [];
  if (customerInsights.length) {
    lines.push("Customer insights:");
    customerInsights.slice(0, 5).forEach((item, index) => {
      const line = insightLine(item, index, ["insight", "use_case", "summary"]);
      if (line) lines.push(line);
    });
  }
  const posthogLinks = resultPostHogLinks(job);
  if (posthogLinks.length) lines.push(`PostHog replays: ${posthogLinks.join(", ")}`);
  const reviewUrl = jobUrl(config, job.id);
  if (reviewUrl) lines.push(`Review page: ${slackLink(reviewUrl, "Replay Lens batch results")}`);
  const handoff = config.baseUrl ? `${config.baseUrl}/api/jobs/${encodeURIComponent(job.id)}/agent-handoff.md` : "";
  if (handoff) lines.push(`Agent handoff: ${slackLink(handoff, "agent Markdown")}`);
  lines.push(`Seen replay IDs tracked: ${state.seenRecordingIds?.length || 0}`);
  return lines.join("\n");
}

export async function sendSlackSummary({ job, config, newIssues, state }) {
  if (!config.slackWebhookUrl) return { sent: false, reason: "SLACK_WEBHOOK_URL is not configured." };
  const text = buildSlackText({ job, config, newIssues, state });
  const response = await fetch(config.slackWebhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Slack webhook failed: ${response.status} ${response.statusText}${detail ? ` - ${detail}` : ""}`);
  }
  return { sent: true };
}

export function automationSummary({ state, config, runtime }) {
  return {
    config: automationPublicConfig(config),
    runtime,
    state: {
      updatedAt: state.updatedAt,
      lastRunAt: state.lastRunAt || null,
      seenRecordingCount: state.seenRecordingIds?.length || 0,
      runCount: state.runs?.length || 0,
      issueCount: state.issues?.length || 0,
      runs: (state.runs || []).slice(0, 20),
      issues: (state.issues || []).slice(0, 50)
    }
  };
}
