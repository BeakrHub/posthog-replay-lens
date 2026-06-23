import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GEMINI_MAX_ATTEMPTS = 3;
const RETRYABLE_GEMINI_STATUS_CODES = new Set([408, 409, 429, 500, 502, 503, 504]);
const PRICING_SOURCE_URL = "https://ai.google.dev/gemini-api/docs/pricing";
const PRICING_SOURCE_DATE = "2026-06-22";

export const CURATED_GEMINI_MODELS = [
  {
    id: "gemini-3.5-flash",
    label: "Gemini 3.5 Flash",
    description: "Current stable Flash model for multimodal video analysis."
  },
  {
    id: "gemini-flash-latest",
    label: "Gemini Flash Latest",
    description: "Auto-updating Flash alias when available to your API key."
  },
  {
    id: "gemini-3.1-pro-preview",
    label: "Gemini 3.1 Pro Preview",
    description: "Documented Gemini 3.1 Pro endpoint for higher-quality review."
  },
  {
    id: "gemini-3.1-pro",
    label: "Gemini 3.1 Pro",
    description: "Stable 3.1 Pro name, if enabled for your API key."
  },
  {
    id: "gemini-3.1-pro-preview-customtools",
    label: "Gemini 3.1 Pro Preview Custom Tools",
    description: "3.1 Pro variant optimized for tool-heavy agent workflows."
  },
  {
    id: "gemini-3-flash-preview",
    label: "Gemini 3 Flash Preview",
    description: "Preview Flash endpoint listed with the Gemini 3.5 Flash family."
  },
  {
    id: "gemini-3.1-flash-lite",
    label: "Gemini 3.1 Flash-Lite",
    description: "Lower-latency Flash-Lite endpoint when available."
  },
  {
    id: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    description: "Previous Flash default."
  },
  {
    id: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    description: "Previous Pro model."
  }
];

function modelId(name) {
  return String(name || "").replace(/^models\//, "");
}

function supportsGenerateContent(model) {
  return Array.isArray(model.supportedGenerationMethods) && model.supportedGenerationMethods.includes("generateContent");
}

function sortModels(models) {
  const curatedRank = new Map(CURATED_GEMINI_MODELS.map((model, index) => [model.id, index]));
  return [...models].sort((a, b) => {
    const rankA = curatedRank.has(a.id) ? curatedRank.get(a.id) : Number.MAX_SAFE_INTEGER;
    const rankB = curatedRank.has(b.id) ? curatedRank.get(b.id) : Number.MAX_SAFE_INTEGER;
    if (rankA !== rankB) return rankA - rankB;
    return a.id.localeCompare(b.id, undefined, { numeric: true });
  });
}

function encodePath(path) {
  return String(path).split("/").map(encodeURIComponent).join("/");
}

function vertexServiceEndpoint(location) {
  const normalized = String(location || "global").trim().toLowerCase();
  return normalized === "global" ? "aiplatform.googleapis.com" : `${normalized}-aiplatform.googleapis.com`;
}

function abortError() {
  const error = new Error("Canceled by user");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(abortError());
    }, { once: true });
  });
}

function retryDelayMs(attempt) {
  const base = 900 * 2 ** Math.max(0, attempt - 1);
  const jitter = Math.floor(Math.random() * 350);
  return base + jitter;
}

function geminiHttpError(label, status, responseText) {
  const error = new Error(`${label} ${status}: ${responseText.slice(0, 1000)}`);
  error.status = status;
  error.retryable = RETRYABLE_GEMINI_STATUS_CODES.has(status);
  return error;
}

function isRetryableGeminiError(error) {
  return Boolean(error?.retryable) || RETRYABLE_GEMINI_STATUS_CODES.has(Number(error?.status));
}

function vertexModelName(config) {
  const model = String(config.geminiModel || "gemini-3.5-flash").trim();
  const project = String(config.vertexProject || "").trim();
  const location = String(config.vertexLocation || "global").trim();
  if (!project) throw new Error("VERTEX_AI_PROJECT or GOOGLE_CLOUD_PROJECT is required for Vertex AI.");
  if (model.startsWith("projects/")) return model;
  if (model.startsWith("publishers/")) return `projects/${project}/locations/${location}/${model}`;
  return `projects/${project}/locations/${location}/publishers/google/models/${model}`;
}

async function commandOutput(command, args) {
  const { stdout } = await execFileAsync(command, args, { timeout: 10000 });
  return stdout.trim();
}

async function getVertexAccessToken(config) {
  if (config.vertexAccessToken) return config.vertexAccessToken;
  try {
    return await commandOutput("gcloud", ["auth", "application-default", "print-access-token"]);
  } catch {
    try {
      return await commandOutput("gcloud", ["auth", "print-access-token"]);
    } catch {
      throw new Error("Vertex AI needs VERTEX_AI_ACCESS_TOKEN or local gcloud application-default auth.");
    }
  }
}

function parseModelId(name) {
  return String(name || "").split("/").pop() || "";
}

function extractText(body) {
  return body.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("\n").trim();
}

function numberValue(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizePricingModel(model) {
  return String(model || "").replace(/^models\//, "").split("/").pop().toLowerCase();
}

function standardPricingForModel(model, promptTokens) {
  const id = normalizePricingModel(model);
  const over200k = numberValue(promptTokens) > 200000;

  if (id === "gemini-3.5-flash" || id === "gemini-flash-latest") {
    return { matchedModel: "gemini-3.5-flash", inputPerMillionUsd: 1.5, outputPerMillionUsd: 9 };
  }
  if (id === "gemini-3.1-pro-preview" || id === "gemini-3.1-pro-preview-customtools" || id === "gemini-3.1-pro") {
    return {
      matchedModel: "gemini-3.1-pro-preview",
      inputPerMillionUsd: over200k ? 4 : 2,
      outputPerMillionUsd: over200k ? 18 : 12,
      threshold: over200k ? "prompts > 200k tokens" : "prompts <= 200k tokens"
    };
  }
  if (id === "gemini-3.1-flash-lite") {
    return { matchedModel: "gemini-3.1-flash-lite", inputPerMillionUsd: 0.25, outputPerMillionUsd: 1.5 };
  }
  if (id === "gemini-3-flash-preview") {
    return { matchedModel: "gemini-3-flash-preview", inputPerMillionUsd: 0.5, outputPerMillionUsd: 3 };
  }
  if (id === "gemini-2.5-pro") {
    return {
      matchedModel: "gemini-2.5-pro",
      inputPerMillionUsd: over200k ? 2.5 : 1.25,
      outputPerMillionUsd: over200k ? 15 : 10,
      threshold: over200k ? "prompts > 200k tokens" : "prompts <= 200k tokens"
    };
  }
  if (id === "gemini-2.5-flash") {
    return { matchedModel: "gemini-2.5-flash", inputPerMillionUsd: 0.3, outputPerMillionUsd: 2.5 };
  }
  if (id === "gemini-2.5-flash-lite" || id === "gemini-2.5-flash-lite-preview-09-2025") {
    return { matchedModel: "gemini-2.5-flash-lite", inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.4 };
  }

  return null;
}

export function estimateGeminiCost({ model, provider, usageMetadata }) {
  const usage = usageMetadata || {};
  const inputTokens = numberValue(usage.promptTokenCount);
  const candidatesTokenCount = numberValue(usage.candidatesTokenCount);
  const thoughtsTokenCount = numberValue(usage.thoughtsTokenCount);
  const outputTokens = candidatesTokenCount + thoughtsTokenCount;
  const totalTokens = numberValue(usage.totalTokenCount) || inputTokens + outputTokens;
  const pricing = standardPricingForModel(model, inputTokens);

  const base = {
    currency: "USD",
    model: model || "",
    provider: provider || "ai-studio",
    inputTokens,
    outputTokens,
    candidatesTokenCount,
    thoughtsTokenCount,
    totalTokens,
    usageMetadata: usageMetadata || null,
    source: PRICING_SOURCE_URL,
    sourceDate: PRICING_SOURCE_DATE,
    priceBasis: "Google Gemini API paid-tier standard generateContent pricing; actual bill can differ for free tier, discounts, Vertex settings, or pricing changes."
  };

  if (!pricing || (!inputTokens && !outputTokens)) {
    return {
      ...base,
      priced: false,
      estimatedUsd: null,
      inputUsd: null,
      outputUsd: null,
      reason: pricing ? "Gemini response did not include token usage metadata." : "No local price mapping for this Gemini model."
    };
  }

  const inputUsd = (inputTokens / 1_000_000) * pricing.inputPerMillionUsd;
  const outputUsd = (outputTokens / 1_000_000) * pricing.outputPerMillionUsd;
  return {
    ...base,
    ...pricing,
    priced: true,
    inputUsd,
    outputUsd,
    estimatedUsd: inputUsd + outputUsd
  };
}

function parseGeminiJsonBody(body, label) {
  const text = extractText(body);
  if (!text) throw new Error(`${label} returned no text: ${JSON.stringify(body).slice(0, 1000)}`);
  return JSON.parse(text);
}

function aiStudioBody({ prompt, base64 }) {
  return {
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          ...(base64 ? [{ inline_data: { mime_type: "video/mp4", data: base64 } }] : [])
        ]
      }
    ],
    generationConfig: { temperature: 0.2, responseMimeType: "application/json" }
  };
}

function vertexBody({ prompt, base64 }) {
  return {
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          ...(base64 ? [{ inlineData: { mimeType: "video/mp4", data: base64 } }] : [])
        ]
      }
    ],
    generationConfig: { temperature: 0.2, responseMimeType: "application/json" }
  };
}

async function requestGenerateContent({ config, prompt, base64, label, signal }) {
  throwIfAborted(signal);
  if (config.geminiProvider === "vertex-ai") {
    const token = await getVertexAccessToken(config);
    const modelName = vertexModelName(config);
    const response = await fetch(
      `https://${vertexServiceEndpoint(config.vertexLocation)}/v1/${encodePath(modelName)}:generateContent`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(vertexBody({ prompt, base64 })),
        signal
      }
    );
    const responseText = await response.text();
    if (!response.ok) throw geminiHttpError("Vertex Gemini", response.status, responseText);
    return JSON.parse(responseText);
  }

  if (!config.geminiKey) throw new Error("GOOGLE_AI_API_KEY is not configured.");
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.geminiModel)}:generateContent?key=${encodeURIComponent(config.geminiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(aiStudioBody({ prompt, base64 })),
      signal
    }
  );
  const responseText = await response.text();
  if (!response.ok) throw geminiHttpError(label, response.status, responseText);
  return JSON.parse(responseText);
}

async function generateContent({ config, prompt, base64, label, signal }) {
  let lastError = null;
  for (let attempt = 1; attempt <= GEMINI_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await requestGenerateContent({ config, prompt, base64, label, signal });
    } catch (error) {
      lastError = error;
      if (!isRetryableGeminiError(error) || attempt >= GEMINI_MAX_ATTEMPTS) break;
      await sleep(retryDelayMs(attempt), signal);
    }
  }

  if (isRetryableGeminiError(lastError)) {
    throw new Error(`${lastError.message} (failed after ${GEMINI_MAX_ATTEMPTS} attempts)`);
  }
  throw lastError;
}

async function listAiStudioModels(config) {
  if (!config.geminiKey) throw new Error("GOOGLE_AI_API_KEY is not configured.");
  const models = [];
  let pageToken = "";

  do {
    const params = new URLSearchParams({
      key: config.geminiKey,
      pageSize: "1000"
    });
    if (pageToken) params.set("pageToken", pageToken);

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?${params}`);
    const responseText = await response.text();
    if (!response.ok) throw new Error(`Gemini models ${response.status}: ${responseText.slice(0, 1000)}`);
    const body = responseText ? JSON.parse(responseText) : {};
    for (const model of body.models || []) {
      const id = modelId(model.name);
      if (!id.startsWith("gemini-") || !supportsGenerateContent(model)) continue;
      models.push({
        id,
        name: model.name,
        displayName: model.displayName || id,
        description: model.description || "",
        version: model.version || "",
        inputTokenLimit: model.inputTokenLimit,
        outputTokenLimit: model.outputTokenLimit,
        supportedGenerationMethods: model.supportedGenerationMethods || []
      });
    }
    pageToken = body.nextPageToken || "";
  } while (pageToken);

  return models;
}

async function listVertexModels(config) {
  const token = await getVertexAccessToken(config);
  const models = [];
  let pageToken = "";

  do {
    const params = new URLSearchParams({
      pageSize: "1000",
      listAllVersions: "true"
    });
    if (pageToken) params.set("pageToken", pageToken);
    const response = await fetch(`https://${vertexServiceEndpoint(config.vertexLocation)}/v1beta1/publishers/google/models?${params}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const responseText = await response.text();
    if (!response.ok) throw new Error(`Vertex models ${response.status}: ${responseText.slice(0, 1000)}`);
    const body = responseText ? JSON.parse(responseText) : {};
    for (const model of body.publisherModels || []) {
      const id = parseModelId(model.name);
      const label = model.displayName || model.name || id;
      if (!id.startsWith("gemini-") && !String(label).toLowerCase().includes("gemini")) continue;
      models.push({
        id,
        name: model.name,
        displayName: label,
        description: model.description || "",
        version: model.versionId || model.version || "",
        supportedGenerationMethods: ["generateContent"],
        provider: "vertex-ai"
      });
    }
    pageToken = body.nextPageToken || "";
  } while (pageToken);

  return models;
}

export async function listGeminiModels({ config }) {
  const models = config.geminiProvider === "vertex-ai"
    ? await listVertexModels(config)
    : await listAiStudioModels(config);

  const byId = new Map(models.map((model) => [model.id, model]));
  for (const model of CURATED_GEMINI_MODELS) {
    if (!byId.has(model.id)) {
      byId.set(model.id, {
        id: model.id,
        name: `models/${model.id}`,
        displayName: model.label,
        description: model.description,
        supportedGenerationMethods: ["generateContent"],
        unavailableFromList: true
      });
    }
  }

  return sortModels([...byId.values()]);
}

export async function analyzeReplayWithGeminiDetailed({ config, mp4Path, metadata, analysisFocus = "", signal }) {
  throwIfAborted(signal);
  const bytes = await fs.readFile(mp4Path);
  throwIfAborted(signal);
  const base64 = bytes.toString("base64");
  const prompt = [
    "You are reviewing a sped-up PostHog session replay video for product bugs, UX friction, frustration signals, and customer workflow insights.",
    "The attached video is a local reconstruction of a real PostHog session replay. It is not a hand-authored or perfectly captured video.",
    "PostHog/rrweb replays can contain artifacts: masked text, missing frames, blank periods, compressed timing, cursor jitter, delayed DOM updates, or imperfect local rendering.",
    "The replay video may be active-compressed and auto-sped-up: long inactive gaps are removed before rendering so Gemini does not spend tokens on idle periods. Treat timestamps as approximate positions in the compressed video, not original wall-clock time.",
    "Known PostHog replay capture artifacts that should NOT be reported as product bugs: gray/blank boxes or placeholders where content is masked or not captured, ph-no-capture redaction blocks, masked text/inputs/images, missing document/PDF previews, missing video/audio/canvas/iframe/third-party embeds, unloaded external assets/CSS/fonts/images, and replay-only console/resource errors.",
    "If a possible issue is only visible as a gray/blank/missing embedded viewer or missing captured media, and there is no independent evidence that the live product failed for the user, do not include it in exact_bugs, ux_friction, frustration_signals, next_actions, or the summary as a bug. At most, note under open_questions that replay capture may be incomplete.",
    "Do not report replay reconstruction artifacts as product bugs unless the video clearly shows the actual product UI behaving incorrectly for the user.",
    "Be strict: only call something an exact bug when the video provides visual evidence. If likely but not proven, put it under ux_friction or open_questions.",
    "Look for frustration signals such as repeated clicks, rage clicks, backtracking, stalled waiting, repeated typing/deleting, error messages, failed tool calls, confusing empty states, truncation, broken layout, or loops.",
    "Bugs are the primary objective. Customer insight is secondary: capture what the user is trying to accomplish, which Beakr workflows/features they use, and any observable use case or customer intent.",
    "Return concise JSON only with keys: summary, likely_user_goal, user_behavior, key_use_case, beakr_workflow, customer_insights, frustration_signals, exact_bugs, ux_friction, evidence_timeline, next_actions, open_questions, confidence.",
    "customer_insights should be 1-4 evidence-backed observations about how this user is using Beakr. Do not infer identity, private business context, or intent that is not visible.",
    "Each exact_bugs item must include: title, severity, timestamp_estimate, visual_evidence, user_impact, reproduction_steps, why_this_is_a_bug.",
    "Each frustration_signals and ux_friction item must include: timestamp_estimate, signal, evidence, severity.",
    "evidence_timeline should be 3-8 timestamped observations from the video.",
    "Do not invent information that is not visible in the video.",
    analysisFocus
      ? `Additional operator focus for this run: ${analysisFocus}`
      : "Additional operator focus for this run: prioritize exact bugs and failed outcomes first, then summarize key Beakr use cases and customer workflow insights.",
    `Recording metadata: ${JSON.stringify(metadata)}`
  ].join("\n");

  const body = await generateContent({ config, prompt, base64, label: "Gemini", signal });
  return {
    analysis: parseGeminiJsonBody(body, "Gemini"),
    usageMetadata: body.usageMetadata || null,
    cost: estimateGeminiCost({
      model: config.geminiModel,
      provider: config.geminiProvider,
      usageMetadata: body.usageMetadata
    })
  };
}

export async function analyzeReplayWithGemini(args) {
  return (await analyzeReplayWithGeminiDetailed(args)).analysis;
}

export async function synthesizeBatchDetailed({ config, analyses, analysisFocus = "", signal }) {
  throwIfAborted(signal);
  const prompt = [
    "You are synthesizing PostHog replay analyses for product bugs, frustration, user behavior, and customer workflow insights.",
    "These analyses came from local reconstructions of real PostHog session replays, so do not treat replay/rendering artifacts as product bugs unless the underlying analysis contains direct product-UI evidence.",
    "When synthesizing, suppress likely PostHog replay artifacts such as gray/blank placeholders, masked or ph-no-capture content, missing document/PDF previews, missing iframe/canvas/video/audio/third-party embeds, unloaded assets, or replay-only resource errors. Do not promote these to exact bugs unless multiple analyses contain independent evidence that the live product failed outside replay capture.",
    "Bugs are the primary objective. Put exact bugs first and do not let customer-insight sections bury or dilute bug findings.",
    "Also summarize how people are using Beakr: key use cases, common workflows, customer intent, feature adoption, and repeated successful behaviors when evidence-backed.",
    "Return JSON only with keys: executive_summary, exact_bugs_prioritized, key_use_cases, customer_insights, user_behavior_patterns, repeated_frustration_patterns, quick_wins, needs_more_evidence.",
    "Merge duplicate bugs across recordings. Each exact_bugs_prioritized item must include: title, severity, affected_recording_ids, evidence, suspected_root_cause, reproduction_steps, user_impact, confidence.",
    "Each key_use_cases item should include: use_case, affected_recording_ids, evidence, frequency, product_area, customer_value.",
    "Each customer_insights item should include: insight, affected_recording_ids, evidence, implication, confidence.",
    "Do not promote friction to an exact bug unless at least one recording analysis has direct evidence.",
    "Use exact recording IDs in every evidence-backed claim.",
    analysisFocus
      ? `Additional operator focus for this run: ${analysisFocus}`
      : "Additional operator focus for this run: prioritize exact bugs and failed outcomes first, then summarize key Beakr use cases and customer workflow insights.",
    `Input analyses: ${JSON.stringify(analyses)}`
  ].join("\n");
  const body = await generateContent({ config, prompt, label: "Gemini synthesis", signal });
  return {
    synthesis: parseGeminiJsonBody(body, "Gemini synthesis"),
    usageMetadata: body.usageMetadata || null,
    cost: estimateGeminiCost({
      model: config.geminiModel,
      provider: config.geminiProvider,
      usageMetadata: body.usageMetadata
    })
  };
}

export async function synthesizeBatch(args) {
  return (await synthesizeBatchDetailed(args)).synthesis;
}
