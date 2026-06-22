import { promises as fs } from "node:fs";
import path from "node:path";

export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash";
export const DEFAULT_GEMINI_PROVIDER = "ai-studio";
export const DEFAULT_VERTEX_LOCATION = "global";
export const MAX_POSTHOG_SNAPSHOT_CHUNK_SIZE = 20;

const runtimeEnv = {};

const CONFIG_KEYS = [
  "POSTHOG_PERSONAL_API_KEY",
  "POSTHOG_PROJECT_ID",
  "POSTHOG_PROJECT_TOKEN",
  "POSTHOG_API_HOST",
  "GEMINI_PROVIDER",
  "GOOGLE_AI_API_KEY",
  "GEMINI_REPLAY_MODEL",
  "VERTEX_AI_PROJECT",
  "VERTEX_AI_LOCATION",
  "VERTEX_AI_ACCESS_TOKEN",
  "PORT",
  "POSTHOG_SNAPSHOT_CHUNK_SIZE",
  "POSTHOG_MAX_THROTTLE_WAIT_SECONDS"
];

function envValue(key, fallback = "") {
  return runtimeEnv[key] ?? process.env[key] ?? fallback;
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  const safe = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, safe));
}

export function normalizeGeminiProvider(input) {
  const value = cleanString(input).toLowerCase();
  if (["vertex", "vertex-ai", "gcp", "google-cloud", "google-cloud-vertex"].includes(value)) return "vertex-ai";
  return DEFAULT_GEMINI_PROVIDER;
}

function formatEnvValue(value) {
  const text = String(value ?? "").replace(/\r?\n/g, " ");
  if (!text || /^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text;
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function parseEnvText(raw) {
  const values = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const equalsAt = trimmed.indexOf("=");
    const key = trimmed.slice(0, equalsAt).trim();
    let value = trimmed.slice(equalsAt + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) values[key] = value;
  }
  return values;
}

export async function loadDotEnv(cwd = process.cwd()) {
  const envPath = path.join(cwd, ".env");
  try {
    const raw = await fs.readFile(envPath, "utf8");
    for (const [key, value] of Object.entries(parseEnvText(raw))) {
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

export function asPostHogHost(input) {
  const host = (input || "https://us.posthog.com").replace(/\/+$/, "");
  if (host.includes("us.i.posthog.com")) return "https://us.posthog.com";
  if (host.includes("eu.i.posthog.com")) return "https://eu.posthog.com";
  if (host.includes("app.posthog.com")) return "https://app.posthog.com";
  return host;
}

export function applyRuntimeConfig(input = {}) {
  const updates = {};
  const provider = normalizeGeminiProvider(input.geminiProvider);

  if (cleanString(input.posthogHost)) updates.POSTHOG_API_HOST = asPostHogHost(input.posthogHost);
  if (cleanString(input.posthogKey)) updates.POSTHOG_PERSONAL_API_KEY = cleanString(input.posthogKey);
  if (input.posthogProjectId !== undefined) updates.POSTHOG_PROJECT_ID = cleanString(input.posthogProjectId);
  if (cleanString(input.posthogProjectToken)) updates.POSTHOG_PROJECT_TOKEN = cleanString(input.posthogProjectToken);

  updates.GEMINI_PROVIDER = provider;
  if (cleanString(input.geminiModel)) updates.GEMINI_REPLAY_MODEL = cleanString(input.geminiModel);
  if (cleanString(input.geminiKey)) updates.GOOGLE_AI_API_KEY = cleanString(input.geminiKey);
  if (input.vertexProject !== undefined) updates.VERTEX_AI_PROJECT = cleanString(input.vertexProject);
  if (cleanString(input.vertexLocation)) updates.VERTEX_AI_LOCATION = cleanString(input.vertexLocation);
  if (cleanString(input.vertexAccessToken)) updates.VERTEX_AI_ACCESS_TOKEN = cleanString(input.vertexAccessToken);

  for (const [key, value] of Object.entries(updates)) {
    runtimeEnv[key] = value;
    process.env[key] = value;
  }

  return getConfig();
}

export async function saveLocalEnv(cwd, config) {
  const envPath = path.join(cwd, ".env");
  let existing = {};
  try {
    existing = parseEnvText(await fs.readFile(envPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const next = {
    ...existing,
    POSTHOG_API_HOST: config.posthogHost,
    POSTHOG_PROJECT_ID: config.posthogProjectId,
    GEMINI_PROVIDER: config.geminiProvider,
    GEMINI_REPLAY_MODEL: config.geminiModel,
    VERTEX_AI_PROJECT: config.vertexProject,
    VERTEX_AI_LOCATION: config.vertexLocation
  };
  if (config.posthogKey) next.POSTHOG_PERSONAL_API_KEY = config.posthogKey;
  if (config.posthogProjectToken) next.POSTHOG_PROJECT_TOKEN = config.posthogProjectToken;
  if (config.geminiKey) next.GOOGLE_AI_API_KEY = config.geminiKey;
  if (config.vertexAccessToken) next.VERTEX_AI_ACCESS_TOKEN = config.vertexAccessToken;
  if (config.snapshotChunkSize) next.POSTHOG_SNAPSHOT_CHUNK_SIZE = String(config.snapshotChunkSize);
  if (config.maxThrottleWaitSeconds) next.POSTHOG_MAX_THROTTLE_WAIT_SECONDS = String(config.maxThrottleWaitSeconds);

  const lines = [
    "# Local Replay Lens config. This file is gitignored.",
    ...CONFIG_KEYS
      .filter((key) => next[key] !== undefined && next[key] !== "")
      .map((key) => `${key}=${formatEnvValue(next[key])}`)
  ];
  await fs.writeFile(envPath, `${lines.join("\n")}\n`);
}

export function getConfig() {
  const geminiProvider = normalizeGeminiProvider(envValue("GEMINI_PROVIDER", DEFAULT_GEMINI_PROVIDER));
  const vertexProject = envValue("VERTEX_AI_PROJECT", envValue("GOOGLE_CLOUD_PROJECT", envValue("GCLOUD_PROJECT", "")));
  const vertexLocation = envValue("VERTEX_AI_LOCATION", envValue("GOOGLE_CLOUD_LOCATION", DEFAULT_VERTEX_LOCATION));
  return {
    port: Number(envValue("PORT", 8787)),
    posthogHost: asPostHogHost(envValue("POSTHOG_API_HOST", "https://us.posthog.com")),
    posthogKey: envValue("POSTHOG_PERSONAL_API_KEY"),
    posthogProjectId: envValue("POSTHOG_PROJECT_ID"),
    posthogProjectToken: envValue("POSTHOG_PROJECT_TOKEN"),
    geminiProvider,
    geminiKey: envValue("GOOGLE_AI_API_KEY"),
    geminiModel: envValue("GEMINI_REPLAY_MODEL", DEFAULT_GEMINI_MODEL),
    vertexProject,
    vertexLocation,
    vertexAccessToken: envValue("VERTEX_AI_ACCESS_TOKEN"),
    snapshotChunkSize: clampNumber(
      envValue("POSTHOG_SNAPSHOT_CHUNK_SIZE", MAX_POSTHOG_SNAPSHOT_CHUNK_SIZE),
      MAX_POSTHOG_SNAPSHOT_CHUNK_SIZE,
      1,
      MAX_POSTHOG_SNAPSHOT_CHUNK_SIZE
    ),
    maxThrottleWaitSeconds: Number(envValue("POSTHOG_MAX_THROTTLE_WAIT_SECONDS", 0))
  };
}

export function publicConfig(config) {
  const hasVertexConfig = Boolean(config.vertexProject && config.vertexLocation);
  const hasGeminiCredential = config.geminiProvider === "vertex-ai"
    ? hasVertexConfig
    : Boolean(config.geminiKey);
  return {
    posthogHost: config.posthogHost,
    hasPostHogKey: Boolean(config.posthogKey),
    hasGeminiKey: Boolean(config.geminiKey),
    hasGeminiCredential,
    hasProjectId: Boolean(config.posthogProjectId),
    hasProjectToken: Boolean(config.posthogProjectToken),
    posthogProjectId: config.posthogProjectId,
    geminiProvider: config.geminiProvider,
    geminiModel: config.geminiModel,
    vertexProject: config.vertexProject,
    vertexLocation: config.vertexLocation,
    hasVertexAccessToken: Boolean(config.vertexAccessToken),
    hasVertexConfig,
    snapshotChunkSize: config.snapshotChunkSize,
    maxThrottleWaitSeconds: config.maxThrottleWaitSeconds
  };
}
