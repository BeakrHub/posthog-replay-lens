#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig, loadDotEnv } from "../server/config.mjs";
import { makeJob, runJob, sanitizeJob, saveJob } from "../server/job-runner.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const artifactsRoot = path.join(repoRoot, "artifacts");

const FLAG_MAP = {
  "analysis-focus": "analysisFocus",
  "candidate-limit": "candidateLimit",
  "dedupe-similar": "dedupeSimilar",
  "diversify-users": "diversifyUsers",
  "filter-stale-recordings": "filterStaleRecordings",
  "gemini-model": "geminiModel",
  "include-ongoing": "includeOngoing",
  "max-age-days": "maxAgeDays",
  "max-clip-seconds": "maxClipSeconds",
  "max-per-user": "maxPerUser",
  "min-active-seconds": "minActiveSeconds",
  "min-activity-score": "minActivityScore",
  "min-clicks": "minClicks",
  "min-clip-seconds": "minClipSeconds",
  "min-keypresses": "minKeypresses",
  "min-mp4-bytes": "minMp4Bytes",
  "min-recording-seconds": "minRecordingSeconds",
  "recording-ids": "recordingIds",
  "url-excludes": "urlExcludes",
  "url-includes": "urlIncludes",
  "user-includes": "userIncludes"
};

function camelFlag(input) {
  return FLAG_MAP[input] || input.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function parseArgs(argv) {
  const config = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const raw = arg.slice(2);
    const [key, inlineValue] = raw.split(/=(.*)/s);
    const next = argv[index + 1];
    const hasInline = inlineValue !== undefined;
    const value = hasInline ? inlineValue : next && !next.startsWith("--") ? next : true;
    if (!hasInline && value !== true) index += 1;
    const target = camelFlag(key);
    config[target] = target === "recordingIds" && typeof value === "string"
      ? value.split(",").map((item) => item.trim()).filter(Boolean)
      : value;
  }
  return config;
}

function printHelp() {
  console.log(`Replay Lens one-off runner

Usage:
  npm run analyze -- --count 10 --speed 12 --url-includes /ask,/projects

Useful flags:
  --count 10
  --parallelism 2
  --candidate-limit 100
  --speed 12
  --gemini-model gemini-3.1-pro-preview
  --min-recording-seconds 60
  --min-active-seconds 20
  --min-activity-score 10
  --min-clicks 2
  --min-keypresses 0
  --max-per-user 1
  --max-age-days 7
  --user-includes user_abc123,email@example.com
  --url-includes /ask,/projects
  --url-excludes /admin,/settings
  --analysis-focus "Find frustration, broken workflows, and exact UI bugs"
  --include-ongoing
  --dedupe-similar false
  --diversify-users false
  --filter-stale-recordings false
`);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  printHelp();
  process.exit(0);
}

await loadDotEnv(repoRoot);
const runtimeConfig = getConfig();
const job = makeJob({ artifactsRoot, config: parseArgs(process.argv.slice(2)) });

console.log(`Starting replay analysis job ${job.id}`);
console.log(`Artifacts: ${path.relative(repoRoot, job.outputDir)}`);
await saveJob(job);

let lastMessage = "";
await runJob({
  job,
  config: runtimeConfig,
  save: async (updatedJob) => {
    await saveJob(updatedJob);
    const message = `${updatedJob.status}: ${updatedJob.progress?.message || ""} (${updatedJob.results.length}/${updatedJob.config.count})`;
    if (message !== lastMessage) {
      console.log(message);
      lastMessage = message;
    }
  }
});

const safe = sanitizeJob(job);
console.log(JSON.stringify({
  id: safe.id,
  status: safe.status,
  results: safe.results.length,
  failures: safe.failures.length,
  artifactBase: safe.artifactBase,
  downloads: safe.downloads
}, null, 2));

process.exit(job.status === "failed" ? 1 : 0);
