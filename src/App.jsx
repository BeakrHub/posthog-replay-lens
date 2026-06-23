import {
  Activity,
  AlertTriangle,
  Bell,
  Bug,
  CalendarClock,
  CheckCircle2,
  Copy,
  Clock3,
  DollarSign,
  Download,
  ExternalLink,
  FileJson,
  Filter,
  Gauge,
  GitPullRequest,
  Loader2,
  Play,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Settings2,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  Video
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const DEFAULT_FORM = {
  count: 10,
  parallelism: 1,
  candidateLimit: 100,
  speed: 12,
  geminiModel: "",
  minClipSeconds: 12,
  maxClipSeconds: 45,
  minRecordingSeconds: 60,
  minActiveSeconds: 0,
  minClicks: 0,
  minKeypresses: 0,
  filterStaleRecordings: true,
  minActivityScore: 10,
  minMp4Bytes: 15000,
  maxAgeDays: 7,
  includeOngoing: false,
  dedupeSimilar: true,
  diversifyUsers: true,
  maxPerUser: 1,
  userIncludes: "",
  urlIncludes: "",
  urlExcludes: "",
  analysisFocus: "Look for frustration, repeated failed actions, confusing empty states, broken layouts, failed tool calls, and exact bugs with visual evidence.",
  width: 1280,
  height: 720
};

const FORM_LIMITS = {
  count: { label: "Videos", min: 1, max: 30 },
  parallelism: { label: "Parallel jobs", min: 1, max: 5 },
  candidateLimit: { label: "Candidate pool", min: 10, max: 250 },
  speed: { label: "Speed", min: 1, max: 60, suffix: "x" },
  minClipSeconds: { label: "Min clip", min: 6, max: 60, suffix: "sec" },
  maxClipSeconds: { label: "Max clip", min: 10, max: 90, suffix: "sec" },
  minRecordingSeconds: { label: "Min recording", min: 0, max: 7200, suffix: "sec" },
  minActiveSeconds: { label: "Min active", min: 0, max: 7200, suffix: "sec" },
  minClicks: { label: "Min clicks", min: 0, max: 10000 },
  minKeypresses: { label: "Min keys", min: 0, max: 100000 },
  minActivityScore: { label: "Min signal", min: 0, max: 100000 },
  maxPerUser: { label: "Max/user", min: 0, max: 25 },
  maxAgeDays: { label: "Max age", min: 0, max: 365, suffix: "days" }
};

const CRON_PRESETS = [
  { label: "Hourly", value: "0 * * * *" },
  { label: "Every 6 hours", value: "0 */6 * * *" },
  { label: "Daily 9 AM", value: "0 9 * * *" },
  { label: "Weekdays 9 AM", value: "0 9 * * 1-5" }
];

const DEFAULT_CONNECTION_FORM = {
  posthogHost: "https://us.posthog.com",
  posthogKey: "",
  posthogProjectId: "",
  posthogProjectToken: "",
  geminiProvider: "ai-studio",
  geminiKey: "",
  geminiModel: "gemini-3.5-flash",
  vertexProject: "",
  vertexLocation: "global",
  vertexAccessToken: "",
  persist: true
};

const GEMINI_PROVIDER_OPTIONS = [
  { value: "ai-studio", label: "AI Studio API key" },
  { value: "vertex-ai", label: "Vertex AI / GCP" }
];

const MODEL_PRESETS = [
  { value: "gemini-3.5-flash", label: "Gemini 3.5 Flash - current stable Flash" },
  { value: "gemini-flash-latest", label: "Gemini Flash Latest - auto-updating alias" },
  { value: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro Preview" },
  { value: "gemini-3.1-pro", label: "Gemini 3.1 Pro - if enabled" },
  { value: "gemini-3.1-pro-preview-customtools", label: "Gemini 3.1 Pro Preview Custom Tools" },
  { value: "gemini-3-flash-preview", label: "Gemini 3 Flash Preview" },
  { value: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite" },
  { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro" }
];

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    const message = body?.error || body?.message || text || `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return body;
}

function cn(...parts) {
  return parts.filter(Boolean).join(" ");
}

function fmtDate(value) {
  if (!value) return "n/a";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "n/a";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function fmtDuration(seconds) {
  const value = Number(seconds || 0);
  if (!Number.isFinite(value)) return "0s";
  if (value < 60) return `${Math.round(value)}s`;
  const mins = Math.floor(value / 60);
  const secs = Math.round(value % 60);
  return secs ? `${mins}m ${secs}s` : `${mins}m`;
}

function fmtBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function fmtCost(cost) {
  if (!cost || cost.estimatedUsd === null || cost.estimatedUsd === undefined) return "cost n/a";
  if (
    cost.processCount === 0 &&
    cost.pricedProcessCount === 0 &&
    cost.unpricedProcessCount === 0
  ) {
    return "cost n/a";
  }
  const value = Number(cost.estimatedUsd || 0);
  if (value > 0 && value < 0.01) return `$${value.toFixed(4)} est.`;
  return `$${value.toFixed(2)} est.`;
}

function fmtTokenCount(count) {
  const value = Number(count || 0);
  if (!Number.isFinite(value) || value <= 0) return "0 tokens";
  if (value >= 1000000) return `${(value / 1000000).toFixed(2)}M tokens`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K tokens`;
  return `${Math.round(value)} tokens`;
}

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function isActiveStatus(status) {
  return status === "running" || status === "queued" || status === "canceling";
}

function splitUiTerms(value) {
  return String(value || "")
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function mergeUiTerm(current, nextValue) {
  const next = String(nextValue || "").trim();
  if (!next) return current || "";
  const terms = splitUiTerms(current);
  const seen = new Set(terms.map((term) => term.toLowerCase()));
  if (!seen.has(next.toLowerCase())) terms.push(next);
  return terms.join(", ");
}

function userLabel(user) {
  return user.email || user.name || user.distinctIds?.[0] || user.user || "Unknown user";
}

function recordingUserLabel(recording) {
  return recording?.user || "user_unknown";
}

function appendParam(params, key, value) {
  if (value === undefined || value === null || value === "") return;
  params.set(key, String(value));
}

function limitHint(key) {
  const limit = FORM_LIMITS[key];
  if (!limit) return "";
  return `${limit.min}-${limit.max}`;
}

function validateForm(form) {
  const errors = [];
  const checkNumber = (key) => {
    const limit = FORM_LIMITS[key];
    const value = Number(form[key]);
    if (!limit || !Number.isFinite(value)) {
      errors.push({ keys: [key], message: `${limit?.label || key} must be a number.` });
      return;
    }
    if (value < limit.min || value > limit.max) {
      errors.push({
        keys: [key],
        message: `${limit.label} must be between ${limit.min} and ${limit.max}${limit.suffix || ""}.`
      });
    }
  };

  for (const key of Object.keys(FORM_LIMITS)) checkNumber(key);

  if (Number(form.minClipSeconds) > Number(form.maxClipSeconds)) {
    errors.push({ keys: ["minClipSeconds", "maxClipSeconds"], message: "Min clip must be less than or equal to Max clip." });
  }
  if (Number(form.count) > Number(form.candidateLimit)) {
    errors.push({ keys: ["count", "candidateLimit"], message: "Candidate pool must be at least as large as Videos." });
  }

  return errors;
}

function buildCandidateQuery(form) {
  const params = new URLSearchParams();
  appendParam(params, "limit", form.candidateLimit);
  appendParam(params, "minRecordingSeconds", form.minRecordingSeconds);
  appendParam(params, "minActiveSeconds", form.minActiveSeconds);
  appendParam(params, "minClicks", form.minClicks);
  appendParam(params, "minKeypresses", form.minKeypresses);
  appendParam(params, "minActivityScore", form.minActivityScore);
  appendParam(params, "maxAgeDays", form.maxAgeDays);
  appendParam(params, "maxPerUser", form.maxPerUser);
  appendParam(params, "userIncludes", form.userIncludes);
  appendParam(params, "urlIncludes", form.urlIncludes);
  appendParam(params, "urlExcludes", form.urlExcludes);
  if (form.includeOngoing) params.set("includeOngoing", "true");
  if (!form.filterStaleRecordings) params.set("filterStaleRecordings", "false");
  if (!form.dedupeSimilar) params.set("dedupeSimilar", "false");
  if (!form.diversifyUsers) params.set("diversifyUsers", "false");
  return params.toString();
}

function shellQuote(value) {
  const text = String(value || "");
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function buildAnalyzeArgs(form) {
  const args = [
    ["count", form.count],
    ["parallelism", form.parallelism],
    ["candidate-limit", form.candidateLimit],
    ["speed", form.speed],
    ["min-recording-seconds", form.minRecordingSeconds],
    ["min-active-seconds", form.minActiveSeconds],
    ["min-clicks", form.minClicks],
    ["min-keypresses", form.minKeypresses],
    ["min-activity-score", form.minActivityScore],
    ["max-per-user", form.maxPerUser],
    ["max-age-days", form.maxAgeDays],
    ["min-clip-seconds", form.minClipSeconds],
    ["max-clip-seconds", form.maxClipSeconds]
  ];
  if (form.includeOngoing) args.push(["include-ongoing", true]);
  if (!form.filterStaleRecordings) args.push(["filter-stale-recordings", "false"]);
  if (!form.dedupeSimilar) args.push(["dedupe-similar", "false"]);
  if (!form.diversifyUsers) args.push(["diversify-users", "false"]);
  if (form.geminiModel) args.push(["gemini-model", form.geminiModel]);
  if (form.userIncludes) args.push(["user-includes", form.userIncludes]);
  if (form.urlIncludes) args.push(["url-includes", form.urlIncludes]);
  if (form.urlExcludes) args.push(["url-excludes", form.urlExcludes]);
  if (form.analysisFocus) args.push(["analysis-focus", form.analysisFocus]);
  return args
    .map(([key, value]) => {
      if (value === true) return `--${key}`;
      if (typeof value === "string") return `--${key} ${shellQuote(value)}`;
      return `--${key} ${value}`;
    })
    .join(" ");
}

function mergeModelOptions(models) {
  const byValue = new Map();
  for (const option of MODEL_PRESETS) byValue.set(option.value, option);
  for (const model of models || []) {
    byValue.set(model.id, {
      value: model.id,
      label: model.unavailableFromList
        ? `${model.displayName || model.id} - curated`
        : `${model.displayName || model.id} - available`
    });
  }
  return [...byValue.values()];
}

function curatedModelList() {
  return MODEL_PRESETS.map((model) => ({
    id: model.value,
    displayName: model.label.split(" - ")[0],
    supportedGenerationMethods: ["generateContent"],
    unavailableFromList: true
  }));
}

function cleanModelError(message) {
  const text = String(message || "");
  if (text.includes("<!DOCTYPE html") || text.includes("Cannot GET /api/gemini/models")) {
    return "Live model discovery is unavailable from the local API. Restart npm run dev if this persists";
  }
  return text;
}

function providerLabel(provider) {
  return provider === "vertex-ai" ? "Vertex AI" : "AI Studio";
}

function StatusPill({ status }) {
  const label = status || "idle";
  return <span className={cn("pill", `status-${label}`)}>{label}</span>;
}

function Metric({ icon: Icon, label, value, tone }) {
  return (
    <div className={cn("metric", tone && `metric-${tone}`)}>
      <Icon size={18} aria-hidden="true" />
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

function WorkflowStrip({ candidatesLoaded, activeJob }) {
  const analyzed = Number(activeJob?.results?.length || 0);
  const activeStatus = activeJob?.status && activeJob.status !== "completed" ? activeJob.status : null;
  const steps = [
    {
      icon: Settings2,
      label: "Choose Recordings",
      detail: "Set user, URL, age, duration, and activity filters."
    },
    {
      icon: Search,
      label: "Load Candidates",
      detail: candidatesLoaded ? `${candidatesLoaded} PostHog recordings ready to review.` : "Preview eligible recordings before spending Gemini time."
    },
    {
      icon: Play,
      label: "Start Batch",
      detail: activeStatus ? `Current batch is ${activeStatus}.` : "Render replay MP4s and send them to Gemini."
    },
    {
      icon: FileJson,
      label: "Review Results",
      detail: analyzed ? `${analyzed} analyzed replay${analyzed === 1 ? "" : "s"} with video evidence.` : "Watch clips, inspect bugs, and export handoffs."
    },
    {
      icon: Terminal,
      label: "Schedule Cron",
      detail: "Run the same settings unattended from crontab."
    }
  ];

  return (
    <section className="flow-strip" aria-label="Replay analysis workflow">
      {steps.map(({ icon: Icon, label, detail }, index) => (
        <div className="flow-step" key={label}>
          <span className="flow-index">{index + 1}</span>
          <Icon size={18} aria-hidden="true" />
          <div>
            <strong>{label}</strong>
            <small>{detail}</small>
          </div>
        </div>
      ))}
    </section>
  );
}

function FlowGuide() {
  return (
    <section className="flow-guide">
      <article>
        <strong>1. Candidate filters</strong>
        <span>User, URL, age, recording length, activity, stale, duplicate, and candidate pool settings affect Load Candidate Set.</span>
      </article>
      <article>
        <strong>2. Loaded set</strong>
        <span>The candidate table is the batch source. Select rows to force exact recordings, or analyze the loaded set.</span>
      </article>
      <article>
        <strong>3. Analysis settings</strong>
        <span>Videos, parallel jobs, speed, min/max clip, Gemini model, and focus affect rendering and Gemini only.</span>
      </article>
    </section>
  );
}

function Field({ label, value, onChange, min, max, step = 1, suffix, hint, invalid }) {
  return (
    <label className={cn("field", invalid && "field-invalid")}>
      <span>
        <strong>{label}</strong>
        {hint ? <small>{hint}</small> : null}
      </span>
      <div className="field-row">
        <input
          type="number"
          value={value ?? ""}
          min={min}
          max={max}
          step={step}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        {suffix ? <em>{suffix}</em> : null}
      </div>
    </label>
  );
}

function TextField({ label, value, onChange, placeholder, options, type = "text", className }) {
  const listId = options?.length ? `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-options` : undefined;
  return (
    <label className={cn("field text-field", className)}>
      <span>{label}</span>
      <input
        type={type}
        value={value ?? ""}
        placeholder={placeholder}
        list={listId}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
      />
      {listId ? (
        <datalist id={listId}>
          {options.map((option) => {
            const value = typeof option === "string" ? option : option.value;
            const optionLabel = typeof option === "string" ? undefined : option.label;
            return <option key={value} value={value} label={optionLabel} />;
          })}
        </datalist>
      ) : null}
    </label>
  );
}

function SecretField({ label, value, onChange, placeholder, className }) {
  return <TextField label={label} value={value} placeholder={placeholder} type="password" className={className} onChange={onChange} />;
}

function ModelField({ value, onChange, placeholder, options, models, loading, error, disabled, onRefresh }) {
  const availableCount = models.filter((model) => !model.unavailableFromList).length;
  return (
    <div className="model-picker">
      <TextField
        label="Gemini model"
        value={value}
        placeholder={placeholder}
        options={options}
        onChange={onChange}
      />
      <div className="model-tools">
        <button className="mini-button" disabled={disabled || loading} onClick={onRefresh} type="button">
          {loading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
          Refresh models
        </button>
        <span>
          {availableCount
            ? `${availableCount} accessible Gemini generateContent models loaded.`
            : "Default is current stable Flash; 3.1 Pro Preview is included."}
        </span>
      </div>
      {error ? <span className="model-error">{error}</span> : null}
      {models.length ? (
        <details className="model-list">
          <summary>Show all model options</summary>
          <div>
            {models.map((model) => (
              <button
                className={cn("model-chip", value === model.id && "selected", model.unavailableFromList && "model-chip-muted")}
                key={model.id}
                onClick={() => onChange(model.id)}
                type="button"
              >
                <strong>{model.id}</strong>
                <small>
                  {model.unavailableFromList ? "Curated suggestion" : "Available to this API key"}
                  {model.inputTokenLimit ? ` · ${Number(model.inputTokenLimit).toLocaleString()} input tokens` : ""}
                </small>
              </button>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function ConnectionSetup({ form, health, modelOptions, saving, message, onChange, onSave }) {
  const config = health?.config || {};
  const isVertex = form.geminiProvider === "vertex-ai";
  return (
    <section className="panel connection-panel">
      <div className="section-head">
        <div>
          <span>Setup</span>
          <h2>Connections And Credentials</h2>
        </div>
        <div className="setup-status">
          <span className={cn("setup-pill", config.hasPostHogKey && "setup-pill-good")}>
            PostHog {config.hasPostHogKey ? "configured" : "missing"}
          </span>
          <span className={cn("setup-pill", config.hasGeminiCredential && "setup-pill-good")}>
            {providerLabel(form.geminiProvider)} {config.hasGeminiCredential ? "configured" : "missing"}
          </span>
        </div>
      </div>
      <div className="connection-grid">
        <TextField
          label="PostHog host"
          value={form.posthogHost}
          placeholder="https://us.posthog.com"
          className="wide-field"
          onChange={(value) => onChange("posthogHost", value)}
        />
        <SecretField
          label="PostHog personal API key"
          value={form.posthogKey}
          placeholder={config.hasPostHogKey ? "Configured; leave blank to keep current key" : "phx_..."}
          className="wide-field"
          onChange={(value) => onChange("posthogKey", value)}
        />
        <TextField
          label="PostHog project ID"
          value={form.posthogProjectId}
          placeholder={config.hasProjectId ? config.posthogProjectId : "Optional"}
          onChange={(value) => onChange("posthogProjectId", value)}
        />
        <SecretField
          label="Project token"
          value={form.posthogProjectToken}
          placeholder={config.hasProjectToken ? "Configured; leave blank to keep" : "Optional"}
          onChange={(value) => onChange("posthogProjectToken", value)}
        />
        <SelectField
          label="Gemini provider"
          value={form.geminiProvider}
          options={GEMINI_PROVIDER_OPTIONS}
          onChange={(value) => onChange("geminiProvider", value)}
        />
        <TextField
          label="Default model"
          value={form.geminiModel}
          placeholder="gemini-3.5-flash"
          options={modelOptions}
          onChange={(value) => onChange("geminiModel", value)}
        />
        {isVertex ? (
          <>
            <TextField
              label="GCP project"
              value={form.vertexProject}
              placeholder={config.vertexProject || "my-gcp-project"}
              onChange={(value) => onChange("vertexProject", value)}
            />
            <TextField
              label="Vertex location"
              value={form.vertexLocation}
              placeholder="global or us-central1"
              onChange={(value) => onChange("vertexLocation", value)}
            />
            <SecretField
              label="Vertex access token"
              value={form.vertexAccessToken}
              placeholder={config.hasVertexAccessToken ? "Configured; leave blank to keep" : "Optional if local gcloud auth works"}
              className="wide-field"
              onChange={(value) => onChange("vertexAccessToken", value)}
            />
          </>
        ) : (
          <SecretField
            label="Google AI API key"
            value={form.geminiKey}
            placeholder={config.hasGeminiKey ? "Configured; leave blank to keep current key" : "AIza..."}
            className="wide-field"
            onChange={(value) => onChange("geminiKey", value)}
          />
        )}
      </div>
      <div className="connection-actions">
        <SwitchField
          label="Save to local .env so cron uses these settings"
          checked={form.persist}
          onChange={(checked) => onChange("persist", checked)}
        />
        <button className="primary setup-save" disabled={saving} onClick={onSave} type="button">
          {saving ? <Loader2 className="spin" size={17} /> : <CheckCircle2 size={17} />}
          Save Connections
        </button>
      </div>
      <div className="fineprint">
        <span>Secrets are submitted only to this local server; the browser receives configured/missing status, not key values.</span>
        <span>Vertex AI uses GCP project, location, and either the pasted bearer token or local `gcloud auth application-default` credentials.</span>
        {message ? <span className="setup-message">{message}</span> : null}
      </div>
    </section>
  );
}

function TextAreaField({ label, value, onChange, placeholder }) {
  return (
    <label className="field text-area-field">
      <span>{label}</span>
      <textarea value={value ?? ""} placeholder={placeholder} rows={4} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function SelectField({ label, value, onChange, options }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function SwitchField({ label, checked, onChange }) {
  return (
    <label className="switch-field">
      <input type="checkbox" checked={Boolean(checked)} onChange={(event) => onChange(event.target.checked)} />
      <span aria-hidden="true" />
      <strong>{label}</strong>
    </label>
  );
}

function EmptyState({ icon: Icon, title, body }) {
  return (
    <div className="empty">
      <Icon size={22} aria-hidden="true" />
      <strong>{title}</strong>
      <span>{body}</span>
    </div>
  );
}

function RecordingRow({ recording, selected, onToggle }) {
  const handleKeyDown = (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onToggle();
    }
  };

  return (
    <div className={cn("recording-row", selected && "selected")} role="button" tabIndex={0} onClick={onToggle} onKeyDown={handleKeyDown}>
      <span className="check">{selected ? <CheckCircle2 size={16} /> : null}</span>
      <span className="recording-main">
        <strong>{recording.url || "Unknown URL"}</strong>
        <small>{recording.user || "user_unknown"} · {recording.route || recording.id}</small>
      </span>
      <span>{fmtDate(recording.start_time)}</span>
      <span>{fmtDuration(recording.duration)}</span>
      <span>{Number(recording.clicks || 0).toLocaleString()} clicks</span>
      <span className="score">{Number(recording.score || 0).toLocaleString()}</span>
      <span>
        {recording.posthogUrl ? (
          <a className="recording-open" href={recording.posthogUrl} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>
            <ExternalLink size={14} /> Open
          </a>
        ) : (
          <span className="muted">n/a</span>
        )}
      </span>
    </div>
  );
}

function BugList({ bugs }) {
  const items = asList(bugs);
  if (!items.length) return <span className="muted">No exact bugs reported.</span>;
  return (
    <div className="bug-list">
      {items.map((bug, index) => (
        <article className="bug-card" key={`${bug.title || "bug"}-${index}`}>
          <div className="bug-head">
            <strong>{bug.title || "Untitled bug"}</strong>
            <span className={cn("severity", `severity-${String(bug.severity || "").toLowerCase()}`)}>
              {bug.severity || "unknown"}
            </span>
          </div>
          <p>{bug.visual_evidence || bug.evidence || bug.user_impact || "No evidence text returned."}</p>
          {bug.reproduction_steps ? <small>{bug.reproduction_steps}</small> : null}
        </article>
      ))}
    </div>
  );
}

function shortText(value, fallback = "No details returned.") {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object") {
    return value.summary || value.pattern || value.action || value.evidence || value.title || fallback;
  }
  return fallback;
}

function BatchStat({ label, value, tone }) {
  return (
    <div className={cn("batch-stat", tone && `batch-stat-${tone}`)}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function AutomationPanel({ automation, loading, running, onRefresh, onRunNow }) {
  const config = automation?.config || {};
  const runtime = automation?.runtime || {};
  const state = automation?.state || {};
  const issues = asList(state.issues);
  const runs = asList(state.runs);
  const slackReady = Boolean(config.hasSlackWebhook);

  return (
    <section className="panel automation-panel">
      <div className="section-head">
        <div>
          <span>Automated Loop</span>
          <h2>Scheduled Replay Watch</h2>
        </div>
        <div className="section-actions">
          <Bell size={20} aria-hidden="true" />
          <span className={cn("setup-pill", config.enabled && "setup-pill-good")}>
            {runtime.running ? "running now" : config.enabled ? "scheduled" : "manual only"}
          </span>
          <button className="icon-button" disabled={loading} onClick={onRefresh} type="button" title="Refresh automation status">
            {loading ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
          </button>
        </div>
      </div>
      <div className="automation-summary">
        <BatchStat label="Cadence" value={config.enabled ? `Every ${config.intervalHours}h` : "Off"} />
        <BatchStat label="Next run" value={config.enabled ? fmtDate(runtime.nextRunAt) : "not scheduled"} />
        <BatchStat label="Seen replays" value={Number(state.seenRecordingCount || 0).toLocaleString()} />
        <BatchStat label="Open flags" value={Number(state.issueCount || 0).toLocaleString()} tone={state.issueCount ? "warn" : "good"} />
        <BatchStat label="Slack" value={slackReady ? "configured" : "missing"} tone={slackReady ? "good" : "warn"} />
      </div>
      <div className="automation-actions">
        <button className="primary compact-action" disabled={running || runtime.running} onClick={onRunNow} type="button">
          {running || runtime.running ? <Loader2 className="spin" size={17} /> : <Play size={17} />}
          Run Automation Now
        </button>
        <div className="fineprint automation-fineprint">
          <span>
            Scheduled runs use the environment automation settings, skip recording IDs already seen in `artifacts/automation/state.json`, then merge exact bugs into this dashboard.
          </span>
          <span>
            Slack sends the run summary and agent handoff link when `SLACK_WEBHOOK_URL` is configured. Linear ticket and PR creation should be added as a separate token-gated agent step.
          </span>
          {runtime.lastSlack ? <span>Last Slack: {runtime.lastSlack.sent ? "sent" : runtime.lastSlack.reason}</span> : null}
          {runtime.lastError ? <span className="automation-error">Last error: {runtime.lastError}</span> : null}
        </div>
      </div>
      <div className="automation-grid">
        <section>
          <h3>Flagged Issues</h3>
          <div className="automation-issue-list">
            {issues.length ? (
              issues.map((issue) => (
                <article className="automation-issue" key={issue.id}>
                  <div className="bug-head">
                    <strong>{issue.title || "Untitled issue"}</strong>
                    <span className={cn("severity", `severity-${String(issue.severity || "").toLowerCase()}`)}>
                      {issue.severity || "unknown"}
                    </span>
                  </div>
                  <p>{issue.evidence || issue.userImpact || "No evidence text stored."}</p>
                  <div className="issue-meta">
                    <span>{Number(issue.occurrenceCount || 1)} occurrence{Number(issue.occurrenceCount || 1) === 1 ? "" : "s"}</span>
                    <span>Last seen {fmtDate(issue.lastSeenAt)}</span>
                    <span>{asList(issue.affectedRecordingIds).length} replay{asList(issue.affectedRecordingIds).length === 1 ? "" : "s"}</span>
                    {issue.jobs?.[0]?.id ? (
                      <a href={`/api/jobs/${encodeURIComponent(issue.jobs[0].id)}/agent-handoff.md`} download>
                        <Download size={13} /> Agent brief
                      </a>
                    ) : null}
                  </div>
                  {asList(issue.affectedRecordings).length ? (
                    <div className="issue-recordings">
                      {issue.affectedRecordings.slice(0, 3).map((recording) => (
                        <div key={recording.id}>
                          <span>{recording.user || "user_unknown"}</span>
                          <span>{fmtDate(recording.startedAt)}</span>
                          <span>{recording.route || recording.url || recording.id}</span>
                          {recording.posthogUrl ? (
                            <a href={recording.posthogUrl} target="_blank" rel="noreferrer">
                              <ExternalLink size={13} /> PostHog
                            </a>
                          ) : null}
                          {recording.artifactUrl ? (
                            <a href={recording.artifactUrl} target="_blank" rel="noreferrer">
                              <Video size={13} /> Clip
                            </a>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </article>
              ))
            ) : (
              <EmptyState icon={Bug} title="No automated flags yet" body="Run automation or wait for the scheduler to finish a batch." />
            )}
          </div>
        </section>
        <section>
          <h3>Recent Runs</h3>
          <div className="automation-run-list">
            {runs.length ? (
              runs.slice(0, 8).map((run) => (
                <article key={run.id}>
                  <div>
                    <strong>{run.jobId}</strong>
                    <StatusPill status={run.status} />
                  </div>
                  <span>{fmtDate(run.startedAt)} · {run.resultCount} analyzed · {run.issueCount} issue{run.issueCount === 1 ? "" : "s"} · {fmtCost(run.costs)}</span>
                  {run.summary ? <p>{run.summary}</p> : null}
                  <a href={`/api/jobs/${encodeURIComponent(run.jobId)}/agent-handoff.md`} download>
                    <GitPullRequest size={14} /> Agent handoff
                  </a>
                </article>
              ))
            ) : (
              <EmptyState icon={CalendarClock} title="No scheduled runs yet" body="When the five-hour loop runs, its history appears here." />
            )}
          </div>
        </section>
      </div>
    </section>
  );
}

function recordingStatus(job, recording) {
  const id = recording?.id;
  if (!id) return "pending";
  if (asList(job.results).some((result) => result.recording?.id === id)) return "analyzed";
  if (asList(job.failures).some((failure) => failure.recording?.id === id)) return "failed";
  if (asList(job.progress?.activeRecordingIds).includes(id) || job.progress?.currentRecordingId === id) return "processing";
  return "pending";
}

function recordingStage(job, recordingId) {
  return asList(job.progress?.activeRecordings).find((item) => item.id === recordingId)?.stage || "";
}

function LiveBatchPanel({ job, target, completed }) {
  const selected = asList(job.selectedRecordings);
  const failures = asList(job.failures);
  const latestResult = asList(job.results).at(-1);
  const queue = selected.slice(0, Math.max(target, 8));
  const failed = failures.length;
  const selectedTarget = selected.length ? Math.min(selected.length, target) : target;

  return (
    <div className="live-batch">
      <div className="batch-stats">
        <BatchStat label="Selected" value={selected.length || "pending"} />
        <BatchStat label="Analyzed" value={`${completed}/${target}`} tone="good" />
        <BatchStat label="Est. Cost" value={fmtCost(job.costs)} />
        <BatchStat label="Failed" value={failed} tone={failed ? "warn" : undefined} />
        <BatchStat label="Remaining" value={Math.max(0, selectedTarget - completed)} />
      </div>
      <div className="live-grid">
        <div>
          <h3>Processing Queue</h3>
          {queue.length ? (
            <div className="queue-list">
              {queue.map((recording, index) => {
                const status = recordingStatus(job, recording);
                return (
                  <div className={cn("queue-row", `queue-${status}`)} key={recording.id || index}>
                    <span>{index + 1}</span>
                    <div>
                      <strong>{recording.url || recording.route || recording.id}</strong>
                      <small>{recording.id} · {fmtDuration(recording.duration)}</small>
                    </div>
                    <em>{recordingStage(job, recording.id) || status}</em>
                  </div>
                );
              })}
            </div>
          ) : (
            <span className="muted">Recordings appear here as soon as PostHog candidates are selected for this batch.</span>
          )}
        </div>
        <div>
          <h3>Latest Finding</h3>
          {latestResult ? (
            <article className="latest-finding">
              <strong>{latestResult.recording?.url || latestResult.recording?.id}</strong>
              <p>{latestResult.analysis?.summary || "Analysis completed without a summary."}</p>
              <small>
                {asList(latestResult.analysis?.exact_bugs).length} exact bugs · {asList(latestResult.analysis?.frustration_signals).length} frustration signals
              </small>
            </article>
          ) : (
            <span className="muted">The first Gemini result appears here as soon as one replay finishes analysis.</span>
          )}
        </div>
      </div>
    </div>
  );
}

function ResultCard({ result }) {
  const analysis = result.analysis || {};
  const cost = result.cost || result.metadata?.geminiCost;
  const recording = result.recording || {};
  return (
    <article className="result-card">
      <div className="result-top">
        <div>
          <strong>{recording.url || recording.id}</strong>
          <div className="result-meta" aria-label="Recording context">
            <span>{recordingUserLabel(recording)}</span>
            <span title={recording.start_time || ""}>{fmtDate(recording.start_time)}</span>
            <span>{recording.route || "unknown route"}</span>
          </div>
          <span>{analysis.summary || "No summary returned."}</span>
        </div>
        <div className="artifact-links">
          {recording.posthogUrl ? (
            <a href={recording.posthogUrl} target="_blank" rel="noreferrer">
              <ExternalLink size={15} /> PostHog
            </a>
          ) : null}
          {result.artifacts?.mp4 ? (
            <a href={result.artifacts.mp4} target="_blank" rel="noreferrer" download>
              <Video size={15} /> MP4
            </a>
          ) : null}
          {result.artifacts?.analysis ? (
            <a href={result.artifacts.analysis} target="_blank" rel="noreferrer" download>
              <FileJson size={15} /> JSON
            </a>
          ) : null}
        </div>
      </div>
      <div className="result-body">
        {result.artifacts?.mp4 ? (
          <div className="video-shell">
            <video controls preload="metadata" src={result.artifacts.mp4} />
          </div>
        ) : null}
        <div className="finding-shell">
          <BugList bugs={analysis.exact_bugs} />
          {asList(analysis.frustration_signals).length ? (
            <div className="signals">
              {analysis.frustration_signals.slice(0, 3).map((signal, index) => (
                <span key={`${signal.signal || "signal"}-${index}`}>
                  {signal.timestamp_estimate ? `${signal.timestamp_estimate}: ` : ""}
                  {signal.signal || signal.evidence}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      <div className="result-foot">
        <span>{result.recording?.id}</span>
        <span>{fmtBytes(result.metadata?.mp4Bytes)}</span>
        <span>
          {result.metadata?.speed || DEFAULT_FORM.speed}x
          {result.metadata?.autoSpeedAdjusted ? ` auto from ${result.metadata.requestedSpeed}x` : ""}
        </span>
        {result.metadata?.timelineCompression?.enabled ? (
          <span>{fmtDuration(result.metadata.timelineCompression.removedInactiveSeconds)} idle removed</span>
        ) : null}
        <span title={cost ? `${fmtTokenCount(cost.inputTokens)} input, ${fmtTokenCount(cost.outputTokens)} output` : ""}>
          {fmtCost(cost)}
        </span>
      </div>
    </article>
  );
}

function AggregateList({ items, empty }) {
  const values = asList(items);
  if (!values.length) return <span className="muted">{empty}</span>;
  return (
    <div className="aggregate-list">
      {values.slice(0, 6).map((item, index) => (
        <article key={`${shortText(item)}-${index}`}>
          <strong>{shortText(item, `Item ${index + 1}`)}</strong>
          {item && typeof item === "object" && item.evidence ? <small>{item.evidence}</small> : null}
        </article>
      ))}
    </div>
  );
}

function SynthesisPanel({ synthesis }) {
  if (!synthesis) {
    return <section className="panel synthesis"><EmptyState icon={Sparkles} title="Aggregate report pending" body="A cross-recording report appears here after the batch synthesizes completed replay analyses." /></section>;
  }
  const bugs = asList(synthesis.exact_bugs_prioritized);
  const friction = asList(synthesis.repeated_frustration_patterns);
  const quickWins = asList(synthesis.quick_wins);
  const evidenceGaps = asList(synthesis.needs_more_evidence);
  const criticalOrHigh = bugs.filter((bug) => /critical|high/i.test(String(bug.severity || ""))).length;

  return (
    <section className="panel synthesis">
      <div className="section-head">
        <div>
          <span>Aggregate</span>
          <h2>Prioritized Bugs And Patterns</h2>
        </div>
        <Sparkles size={20} aria-hidden="true" />
      </div>
      <p className="lead">{synthesis.executive_summary || "No executive summary returned."}</p>
      <div className="aggregate-stats">
        <BatchStat label="Exact bugs" value={bugs.length} tone={bugs.length ? "warn" : "good"} />
        <BatchStat label="High/Critical" value={criticalOrHigh} tone={criticalOrHigh ? "warn" : undefined} />
        <BatchStat label="Patterns" value={friction.length} />
        <BatchStat label="Quick wins" value={quickWins.length} />
      </div>
      <div className="aggregate-grid">
        <section className="aggregate-section priority">
          <h3>Prioritized Exact Bugs</h3>
          <BugList bugs={bugs} />
        </section>
        <section className="aggregate-section">
          <h3>Frustration Patterns</h3>
          <AggregateList items={friction} empty="None reported." />
        </section>
        <section className="aggregate-section">
          <h3>Quick Wins</h3>
          <AggregateList items={quickWins} empty="None reported." />
        </section>
        <section className="aggregate-section">
          <h3>Needs More Evidence</h3>
          <AggregateList items={evidenceGaps} empty="No major evidence gaps reported." />
        </section>
      </div>
    </section>
  );
}

export default function App() {
  const initialJobId = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("job") || "" : "";
  const [health, setHealth] = useState(null);
  const [recordings, setRecordings] = useState([]);
  const [candidateDiagnostics, setCandidateDiagnostics] = useState(null);
  const [candidateQueryKey, setCandidateQueryKey] = useState("");
  const [candidateLoadedAt, setCandidateLoadedAt] = useState("");
  const [project, setProject] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [automation, setAutomation] = useState(null);
  const [activeJobId, setActiveJobId] = useState(initialJobId);
  const [form, setForm] = useState(DEFAULT_FORM);
  const [connectionForm, setConnectionForm] = useState(DEFAULT_CONNECTION_FORM);
  const [cronSchedule, setCronSchedule] = useState(CRON_PRESETS[2].value);
  const [copiedCron, setCopiedCron] = useState(false);
  const [geminiModels, setGeminiModels] = useState([]);
  const [loadingGeminiModels, setLoadingGeminiModels] = useState(false);
  const [modelError, setModelError] = useState("");
  const [savingConfig, setSavingConfig] = useState(false);
  const [configMessage, setConfigMessage] = useState("");
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [userSearch, setUserSearch] = useState("");
  const [userSuggestions, setUserSuggestions] = useState([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [loadingRecordings, setLoadingRecordings] = useState(false);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [loadingAutomation, setLoadingAutomation] = useState(false);
  const [runningAutomation, setRunningAutomation] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const candidatesRef = useRef(null);

  const activeJob = useMemo(
    () => jobs.find((job) => job.id === activeJobId) || jobs[0] || null,
    [activeJobId, jobs]
  );
  const modelOptions = useMemo(() => mergeModelOptions(geminiModels), [geminiModels]);
  const validationErrors = useMemo(() => validateForm(form), [form]);
  const invalidFields = useMemo(
    () => new Set(validationErrors.flatMap((item) => item.keys || [])),
    [validationErrors]
  );
  const currentCandidateQueryKey = useMemo(() => buildCandidateQuery(form), [form]);
  const candidateSetLoaded = recordings.length > 0 && Boolean(candidateQueryKey);
  const candidateSetStale = candidateSetLoaded && candidateQueryKey !== currentCandidateQueryKey;
  const hasExactSelection = selectedIds.size > 0;
  const loadedCandidateIds = useMemo(() => recordings.map((recording) => recording.id).filter(Boolean), [recordings]);
  const startRecordingIds = useMemo(() => {
    if (hasExactSelection) return [...selectedIds];
    if (candidateSetLoaded && !candidateSetStale) return loadedCandidateIds;
    return [];
  }, [candidateSetLoaded, candidateSetStale, hasExactSelection, loadedCandidateIds, selectedIds]);
  const blocksStartForStaleCandidates = candidateSetStale && !hasExactSelection;
  const usable = Boolean(health?.config?.hasPostHogKey && health?.config?.hasGeminiCredential);
  const canStartBatch = usable && !validationErrors.length && !blocksStartForStaleCandidates;
  const completed = Number(activeJob?.progress?.completed || activeJob?.results?.length || 0);
  const target = Number(activeJob?.config?.count || form.count);
  const progressPct = activeJob ? Math.min(100, Math.round((completed / Math.max(1, target)) * 100)) : 0;
  const startButtonText = hasExactSelection
    ? `Analyze ${selectedIds.size} Selected`
    : candidateSetLoaded && !candidateSetStale
      ? "Analyze Loaded Candidates"
      : "Start Analysis Batch";
  const candidatePlanTitle = hasExactSelection
    ? "Exact selection"
    : candidateSetStale
      ? "Candidate set is stale"
      : candidateSetLoaded
        ? "Loaded candidate set"
        : "No candidate set loaded";
  const candidatePlanBody = hasExactSelection
    ? `Start will analyze the ${selectedIds.size} row${selectedIds.size === 1 ? "" : "s"} you selected, regardless of current filters.`
    : candidateSetStale
      ? `Filters changed after candidates loaded${candidateLoadedAt ? ` at ${fmtDate(candidateLoadedAt)}` : ""}. Reload candidates before starting, or select exact rows.`
      : candidateSetLoaded
        ? `Start will analyze up to ${form.count} replay${Number(form.count) === 1 ? "" : "s"} from these ${recordings.length} loaded candidates.`
        : "Start will fetch candidates from PostHog using the current filters at run time.";
  const cronLine = useMemo(() => {
    return `${cronSchedule} cd /path/to/replay_lens && npm run analyze -- ${buildAnalyzeArgs(form)} >> artifacts/cron.log 2>&1`;
  }, [cronSchedule, form]);

  const updateForm = useCallback((key, value) => {
    setForm((current) => ({ ...current, [key]: value }));
  }, []);

  const updateConnectionForm = useCallback((key, value) => {
    setConnectionForm((current) => ({ ...current, [key]: value }));
  }, []);

  const loadHealth = useCallback(async () => {
    const body = await fetchJson("/api/health");
    setHealth(body);
    setForm((current) => current.geminiModel ? current : { ...current, geminiModel: body.config?.geminiModel || "" });
    setConnectionForm((current) => ({
      ...current,
      posthogHost: current.posthogHost || body.config?.posthogHost || DEFAULT_CONNECTION_FORM.posthogHost,
      posthogProjectId: current.posthogProjectId || body.config?.posthogProjectId || "",
      geminiProvider: body.config?.geminiProvider || current.geminiProvider || DEFAULT_CONNECTION_FORM.geminiProvider,
      geminiModel: current.geminiModel || body.config?.geminiModel || DEFAULT_CONNECTION_FORM.geminiModel,
      vertexProject: current.vertexProject || body.config?.vertexProject || "",
      vertexLocation: current.vertexLocation || body.config?.vertexLocation || DEFAULT_CONNECTION_FORM.vertexLocation
    }));
  }, []);

  const loadJobs = useCallback(async () => {
    setLoadingJobs(true);
    try {
      const body = await fetchJson("/api/jobs");
      setJobs(body || []);
      if (!activeJobId && body?.[0]) setActiveJobId(body[0].id);
    } finally {
      setLoadingJobs(false);
    }
  }, [activeJobId]);

  const loadAutomation = useCallback(async () => {
    setLoadingAutomation(true);
    try {
      const body = await fetchJson("/api/automation");
      setAutomation(body);
    } finally {
      setLoadingAutomation(false);
    }
  }, []);

  const loadGeminiModels = useCallback(async () => {
    setLoadingGeminiModels(true);
    setModelError("");
    try {
      const body = await fetchJson("/api/gemini/models");
      setGeminiModels(body.models || []);
    } catch (err) {
      setGeminiModels(curatedModelList());
      setModelError(`${cleanModelError(err.message)}. Showing curated Gemini model options.`);
    } finally {
      setLoadingGeminiModels(false);
    }
  }, []);

  const saveConnectionConfig = useCallback(async () => {
    setSavingConfig(true);
    setConfigMessage("");
    setError("");
    try {
      const body = await fetchJson("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(connectionForm)
      });
      setHealth({ ok: true, config: body.config });
      setForm((current) => ({ ...current, geminiModel: body.config?.geminiModel || current.geminiModel }));
      setConnectionForm((current) => ({
        ...current,
        posthogKey: "",
        posthogProjectToken: "",
        geminiKey: "",
        vertexAccessToken: "",
        geminiProvider: body.config?.geminiProvider || current.geminiProvider,
        geminiModel: body.config?.geminiModel || current.geminiModel,
        posthogHost: body.config?.posthogHost || current.posthogHost,
        posthogProjectId: body.config?.posthogProjectId || current.posthogProjectId,
        vertexProject: body.config?.vertexProject || current.vertexProject,
        vertexLocation: body.config?.vertexLocation || current.vertexLocation
      }));
      setConfigMessage(body.persisted ? "Saved for this server and wrote local .env for cron." : "Saved for this server session.");
      if (body.config?.hasGeminiCredential) loadGeminiModels();
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingConfig(false);
    }
  }, [connectionForm, loadGeminiModels]);

  const refreshAppState = useCallback(async () => {
    setError("");
    try {
      await Promise.all([loadHealth(), loadJobs(), loadAutomation()]);
    } catch (err) {
      setError(err.message);
    }
  }, [loadAutomation, loadHealth, loadJobs]);

  const loadRecordings = useCallback(async () => {
    setLoadingRecordings(true);
    setError("");
    try {
      const query = buildCandidateQuery(form);
      const body = await fetchJson(`/api/recordings?${query}`);
      setProject(body.project);
      setRecordings(body.recordings || []);
      setCandidateDiagnostics(body.diagnostics || null);
      setCandidateQueryKey(query);
      setCandidateLoadedAt(new Date().toISOString());
      setSelectedIds(new Set());
      window.requestAnimationFrame(() => candidatesRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingRecordings(false);
    }
  }, [form]);

  const loadUserSuggestions = useCallback(async () => {
    setLoadingUsers(true);
    setError("");
    try {
      const params = new URLSearchParams({ limit: "12" });
      if (userSearch.trim()) params.set("search", userSearch.trim());
      const body = await fetchJson(`/api/users?${params.toString()}`);
      setProject(body.project);
      setUserSuggestions(body.users || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingUsers(false);
    }
  }, [userSearch]);

  const addUserFilter = useCallback((value) => {
    setForm((current) => ({ ...current, userIncludes: mergeUiTerm(current.userIncludes, value) }));
  }, []);

  const startJob = useCallback(async () => {
    if (validationErrors.length) {
      setError(validationErrors.map((item) => item.message).join(" "));
      return;
    }
    if (blocksStartForStaleCandidates) {
      setError("Filters changed after loading candidates. Reload the candidate set, or select exact rows to analyze.");
      return;
    }
    setStarting(true);
    setError("");
    try {
      const body = await fetchJson("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, recordingIds: startRecordingIds })
      });
      setJobs((current) => [body, ...current.filter((job) => job.id !== body.id)]);
      setActiveJobId(body.id);
    } catch (err) {
      setError(err.message);
    } finally {
      setStarting(false);
    }
  }, [blocksStartForStaleCandidates, form, startRecordingIds, validationErrors]);

  const runAutomationNow = useCallback(async () => {
    setRunningAutomation(true);
    setError("");
    try {
      const body = await fetchJson("/api/automation/run", { method: "POST" });
      if (body?.job) {
        setJobs((current) => [body.job, ...current.filter((job) => job.id !== body.job.id)]);
        setActiveJobId(body.job.id);
      }
      await loadAutomation();
    } catch (err) {
      setError(err.message);
    } finally {
      setRunningAutomation(false);
    }
  }, [loadAutomation]);

  const deleteJob = useCallback(async (jobId, active = false) => {
    if (!jobId) return;
    const prompt = active
      ? "Stop this running batch and delete its local artifacts? Completed results from this batch will be removed."
      : "Delete this batch and its local artifacts?";
    if (!window.confirm(prompt)) return;
    setError("");
    try {
      await fetchJson(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" });
      const body = await fetchJson("/api/jobs");
      setJobs(body || []);
      setActiveJobId(body?.[0]?.id || "");
    } catch (err) {
      setError(err.message);
    }
  }, []);

  const cancelJob = useCallback(async (jobId) => {
    if (!jobId) return;
    if (!window.confirm("Stop this batch now? Completed results and artifacts will be kept.")) return;
    setError("");
    try {
      const body = await fetchJson(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" });
      setJobs((current) => [body, ...current.filter((job) => job.id !== body.id)]);
      setActiveJobId(body.id);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  const clearHistory = useCallback(async () => {
    if (!window.confirm("Delete all finished batch artifacts? Running jobs are kept.")) return;
    setError("");
    try {
      await fetchJson("/api/jobs", { method: "DELETE" });
      const body = await fetchJson("/api/jobs");
      setJobs(body || []);
      setActiveJobId(body?.[0]?.id || "");
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    loadHealth().catch((err) => setError(err.message));
    loadJobs().catch((err) => setError(err.message));
    loadAutomation().catch((err) => setError(err.message));
  }, [loadAutomation, loadHealth, loadJobs]);

  useEffect(() => {
    if (health?.config?.hasGeminiCredential) loadGeminiModels();
  }, [health?.config?.hasGeminiCredential, health?.config?.geminiProvider, loadGeminiModels]);

  useEffect(() => {
    const id = window.setInterval(() => {
      loadJobs().catch((err) => setError(err.message));
      loadAutomation().catch((err) => setError(err.message));
    }, isActiveStatus(activeJob?.status) ? 2500 : 6000);
    return () => window.clearInterval(id);
  }, [activeJob?.status, loadAutomation, loadJobs]);

  const toggleSelected = (id) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const copyCron = async () => {
    try {
      await navigator.clipboard.writeText(cronLine);
      setCopiedCron(true);
      window.setTimeout(() => setCopiedCron(false), 1400);
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <main>
      <header className="app-header">
        <div>
          <span className="eyebrow">Local Replay Intelligence</span>
          <h1>Replay Lens</h1>
        </div>
        <div className="header-actions">
          <button className="ghost" onClick={refreshAppState} title="Reload API status and batch history" type="button">
            <RefreshCw size={16} /> Refresh Status
          </button>
          <a className="ghost" href="https://posthog.com/docs/session-replay" target="_blank" rel="noreferrer">
            <ExternalLink size={16} /> PostHog
          </a>
        </div>
      </header>

      {error ? (
        <div className="error-banner">
          <AlertTriangle size={18} />
          <span>{error}</span>
        </div>
      ) : null}

      <section className="metrics">
        <Metric
          icon={CheckCircle2}
          label="PostHog"
          value={health?.config?.hasPostHogKey ? health.config.posthogHost : "Missing key"}
          tone={health?.config?.hasPostHogKey ? "good" : "warn"}
        />
        <Metric
          icon={Sparkles}
          label="Gemini"
          value={health?.config?.hasGeminiCredential ? `${providerLabel(health.config.geminiProvider)} · ${form.geminiModel || health.config.geminiModel}` : "Missing setup"}
          tone={health?.config?.hasGeminiCredential ? "good" : "warn"}
        />
        <Metric icon={Gauge} label="Replay Speed" value={`${form.speed}x`} />
        <Metric icon={Video} label="Batch Target" value={`${form.count} videos · ${form.parallelism} parallel`} />
      </section>

      <ConnectionSetup
        form={connectionForm}
        health={health}
        modelOptions={modelOptions}
        saving={savingConfig}
        message={configMessage}
        onChange={updateConnectionForm}
        onSave={saveConnectionConfig}
      />

      <AutomationPanel
        automation={automation}
        loading={loadingAutomation}
        running={runningAutomation}
        onRefresh={loadAutomation}
        onRunNow={runAutomationNow}
      />

      <WorkflowStrip candidatesLoaded={recordings.length} activeJob={activeJob} />
      <FlowGuide />

      <section className="workspace">
        <aside className="panel controls">
          <div className="section-head">
            <div>
              <span>Analyze</span>
              <h2>Render And Gemini Settings</h2>
            </div>
            <Settings2 size={20} aria-hidden="true" />
          </div>
          <div className="field-grid">
            <Field
              label="Videos to analyze"
              value={form.count}
              min={1}
              max={30}
              hint={limitHint("count")}
              invalid={invalidFields.has("count")}
              onChange={(value) => updateForm("count", value)}
            />
            <Field
              label="Parallel jobs"
              value={form.parallelism}
              min={1}
              max={5}
              hint={`${limitHint("parallelism")} · rate-limit risk`}
              invalid={invalidFields.has("parallelism")}
              onChange={(value) => updateForm("parallelism", value)}
            />
            <Field
              label="Speed"
              value={form.speed}
              min={1}
              max={60}
              suffix="x"
              hint={`${limitHint("speed")} · 8-16x typical`}
              invalid={invalidFields.has("speed")}
              onChange={(value) => updateForm("speed", value)}
            />
            <ModelField
              value={form.geminiModel}
              placeholder={health?.config?.geminiModel || "gemini-3.5-flash"}
              options={modelOptions}
              models={geminiModels}
              loading={loadingGeminiModels}
              error={modelError}
              disabled={!health?.config?.hasGeminiCredential}
              onRefresh={loadGeminiModels}
              onChange={(value) => updateForm("geminiModel", value)}
            />
            <Field
              label="Min video clip"
              value={form.minClipSeconds}
              min={6}
              max={60}
              suffix="sec"
              hint={limitHint("minClipSeconds")}
              invalid={invalidFields.has("minClipSeconds")}
              onChange={(value) => updateForm("minClipSeconds", value)}
            />
            <Field
              label="Max video clip"
              value={form.maxClipSeconds}
              min={10}
              max={90}
              suffix="sec"
              hint={limitHint("maxClipSeconds")}
              invalid={invalidFields.has("maxClipSeconds")}
              onChange={(value) => updateForm("maxClipSeconds", value)}
            />
          </div>
          <TextAreaField
            label="Gemini focus"
            value={form.analysisFocus}
            onChange={(value) => updateForm("analysisFocus", value)}
            placeholder="Tell Gemini exactly what frustration, bug classes, flows, or products to prioritize."
          />
          {validationErrors.length ? (
            <div className="validation-list">
              {validationErrors.map((item) => (
                <span key={item.message}>{item.message}</span>
              ))}
            </div>
          ) : (
            <div className="constraint-note">
              Clip length, speed, parallelism, and model affect rendering/Gemini analysis only. They do not change which recordings Load Candidate Set returns.
            </div>
          )}
          <button className="primary" disabled={!canStartBatch || starting} onClick={startJob} type="button">
            {starting ? <Loader2 className="spin" size={17} /> : <Play size={17} />}
            {startButtonText}
          </button>
          <div className="fineprint">
            <span>
              {selectedIds.size
                ? `Start Analysis Batch will process the ${selectedIds.size} selected recording${selectedIds.size === 1 ? "" : "s"}.`
                : candidateSetLoaded && !candidateSetStale
                  ? "Start Analysis Batch uses the loaded candidate IDs shown below, not a hidden different batch."
                  : form.userIncludes
                    ? "Without loaded candidates, Start Analysis Batch fetches matching users at run time; user diversity caps are skipped for specific-user filters."
                    : "Without loaded candidates, Start Analysis Batch fetches using the current filters at run time."}
            </span>
            <span>{project ? `${project.name} (${project.id})` : "Project auto-discovered when candidates load or analysis starts."}</span>
          </div>
        </aside>

        <section className="panel job-panel">
          <div className="section-head">
            <div>
              <span>Active Batch</span>
              <h2>{activeJob?.id || "No jobs yet"}</h2>
            </div>
            <StatusPill status={activeJob?.status || "idle"} />
          </div>
          {activeJob ? (
            <>
              <div className="progress-wrap">
                <div className="progress-label">
                  <span>{activeJob.progress?.message || "Waiting"}</span>
                  <strong>
                    {completed}/{target}
                  </strong>
                </div>
                <div className="progress-bar" aria-label="Job progress">
                  <span style={{ width: `${progressPct}%` }} />
                </div>
              </div>
              <div className="job-meta">
                <span>
                  <Clock3 size={15} /> {fmtDate(activeJob.startedAt)}
                </span>
                <span>
                  <Gauge size={15} /> {activeJob.config?.speed}x
                </span>
                <span title={`${fmtTokenCount(activeJob.costs?.inputTokens)} input, ${fmtTokenCount(activeJob.costs?.outputTokens)} output`}>
                  <DollarSign size={15} /> {fmtCost(activeJob.costs)}
                </span>
                <span>
                  <Activity size={15} /> {asList(activeJob.progress?.activeRecordingIds).length ? `${asList(activeJob.progress.activeRecordingIds).length} active` : activeJob.progress?.currentRecordingId || "n/a"}
                </span>
              </div>
              <LiveBatchPanel job={activeJob} target={target} completed={completed} />
              {asList(activeJob.failures).length ? (
                <div className="failure-list">
                  {activeJob.failures.slice(0, 3).map((failure) => (
                    <span key={failure.recording?.id || failure.error}>
                      {failure.recording?.id}: {failure.error}
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="download-actions">
                <a className="download-link" href={activeJob.downloads?.markdown || `/api/jobs/${activeJob.id}/agent-handoff.md`} download>
                  <Download size={16} /> Agent Markdown
                </a>
                <a className="download-link" href={activeJob.downloads?.json || `/api/jobs/${activeJob.id}/export.json`} download>
                  <FileJson size={16} /> Results JSON
                </a>
                {isActiveStatus(activeJob.status) ? (
                  <button
                    className="download-link stop-link"
                    disabled={activeJob.status === "canceling"}
                    onClick={() => cancelJob(activeJob.id)}
                    type="button"
                  >
                    <Square size={16} /> {activeJob.status === "canceling" ? "Stopping" : "Stop Batch"}
                  </button>
                ) : null}
                <button
                  className="download-link danger-link"
                  disabled={activeJob.status === "canceling"}
                  onClick={() => deleteJob(activeJob.id, isActiveStatus(activeJob.status))}
                  type="button"
                >
                  <Trash2 size={16} /> {isActiveStatus(activeJob.status) ? "Stop And Delete" : "Delete Batch"}
                </button>
              </div>
            </>
          ) : (
            <EmptyState icon={Play} title="Ready to run" body="Start an analysis batch to create replay videos and Gemini findings." />
          )}
        </section>
      </section>

      <section className="control-grid">
        <section className="panel filters-panel">
          <div className="section-head">
            <div>
              <span>Choose Recordings</span>
              <h2>Candidate Filters</h2>
            </div>
            <Filter size={20} aria-hidden="true" />
          </div>
          <div className="field-grid wide filter-fields">
            <TextField
              label="URL includes"
              value={form.urlIncludes}
              placeholder="/ask, /projects"
              onChange={(value) => updateForm("urlIncludes", value)}
            />
            <TextField
              label="URL excludes"
              value={form.urlExcludes}
              placeholder="/admin, /settings"
              onChange={(value) => updateForm("urlExcludes", value)}
            />
            <TextField
              label="Specific users"
              value={form.userIncludes}
              placeholder="email, distinct_id, or user_ab12cd34ef"
              onChange={(value) => updateForm("userIncludes", value)}
            />
            <div className="user-finder">
              <label className="field">
                <span>Find users</span>
                <input value={userSearch} placeholder="Search email or name" onChange={(event) => setUserSearch(event.target.value)} />
              </label>
              <button className="secondary compact-action" disabled={!health?.config?.hasPostHogKey || loadingUsers} onClick={loadUserSuggestions} type="button">
                {loadingUsers ? <Loader2 className="spin" size={16} /> : <Search size={16} />}
                Search Users
              </button>
              {userSuggestions.length ? (
                <div className="user-chip-list">
                  {userSuggestions.map((user) => (
                    <button className="user-chip" key={user.id || user.filterValue} onClick={() => addUserFilter(user.filterValue)} type="button">
                      <strong>{userLabel(user)}</strong>
                      <small>{user.name && user.email && user.name !== user.email ? user.name : user.distinctIds?.[0] || user.user}</small>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <Field
              label="Candidate pool size"
              value={form.candidateLimit}
              min={10}
              max={250}
              hint={limitHint("candidateLimit")}
              invalid={invalidFields.has("candidateLimit")}
              onChange={(value) => updateForm("candidateLimit", value)}
            />
            <Field
              label="Min recording length"
              value={form.minRecordingSeconds}
              min={0}
              max={7200}
              suffix="sec"
              hint={limitHint("minRecordingSeconds")}
              invalid={invalidFields.has("minRecordingSeconds")}
              onChange={(value) => updateForm("minRecordingSeconds", value)}
            />
            <Field
              label="Min active"
              value={form.minActiveSeconds}
              min={0}
              max={7200}
              suffix="sec"
              hint={limitHint("minActiveSeconds")}
              invalid={invalidFields.has("minActiveSeconds")}
              onChange={(value) => updateForm("minActiveSeconds", value)}
            />
            <Field
              label="Min clicks"
              value={form.minClicks}
              min={0}
              max={10000}
              hint={limitHint("minClicks")}
              invalid={invalidFields.has("minClicks")}
              onChange={(value) => updateForm("minClicks", value)}
            />
            <Field
              label="Min keys"
              value={form.minKeypresses}
              min={0}
              max={100000}
              hint={limitHint("minKeypresses")}
              invalid={invalidFields.has("minKeypresses")}
              onChange={(value) => updateForm("minKeypresses", value)}
            />
            <Field
              label="Min signal"
              value={form.minActivityScore}
              min={0}
              max={100000}
              hint={limitHint("minActivityScore")}
              invalid={invalidFields.has("minActivityScore")}
              onChange={(value) => updateForm("minActivityScore", value)}
            />
            <Field
              label="Max/user"
              value={form.maxPerUser}
              min={0}
              max={25}
              hint={`${limitHint("maxPerUser")} · 0 unlimited`}
              invalid={invalidFields.has("maxPerUser")}
              onChange={(value) => updateForm("maxPerUser", value)}
            />
            <Field
              label="Max recording age"
              value={form.maxAgeDays}
              min={0}
              max={365}
              suffix="days"
              hint={limitHint("maxAgeDays")}
              invalid={invalidFields.has("maxAgeDays")}
              onChange={(value) => updateForm("maxAgeDays", value)}
            />
          </div>
          <div className="switch-grid">
            <SwitchField
              label="Include ongoing recordings"
              checked={form.includeOngoing}
              onChange={(checked) => updateForm("includeOngoing", checked)}
            />
            <SwitchField
              label="Filter stale low-activity recordings"
              checked={form.filterStaleRecordings}
              onChange={(checked) => updateForm("filterStaleRecordings", checked)}
            />
            <SwitchField
              label="Skip similar duplicate traces"
              checked={form.dedupeSimilar}
              onChange={(checked) => updateForm("dedupeSimilar", checked)}
            />
            <SwitchField
              label="Diversify across users"
              checked={form.diversifyUsers}
              onChange={(checked) => updateForm("diversifyUsers", checked)}
            />
          </div>
          <div className={cn("candidate-plan", candidateSetStale && !hasExactSelection && "candidate-plan-warn")}>
            <strong>{candidatePlanTitle}</strong>
            <span>{candidatePlanBody}</span>
          </div>
          <button className="primary" disabled={!health?.config?.hasPostHogKey || loadingRecordings} onClick={loadRecordings} type="button">
            {loadingRecordings ? <Loader2 className="spin" size={17} /> : <Search size={17} />}
            {candidateSetLoaded ? "Reload Candidate Set" : "Load Candidate Set"}
          </button>
          <div className="fineprint">
            <span>Load Candidate Set uses only these recording filters. It does not render videos or call Gemini.</span>
            {candidateDiagnostics ? (
              <span>
                Scanned {Number(candidateDiagnostics.scanned || 0).toLocaleString()} PostHog recordings; {Number(candidateDiagnostics.matchedFilters || 0).toLocaleString()} matched the active filters.
              </span>
            ) : null}
          </div>
        </section>

        <section className="panel schedule-panel">
          <div className="section-head">
            <div>
              <span>Schedule</span>
              <h2>Scheduled Batch Command</h2>
            </div>
            <Terminal size={20} aria-hidden="true" />
          </div>
          <SelectField label="Schedule" value={cronSchedule} onChange={setCronSchedule} options={CRON_PRESETS} />
          <div className="cron-box">
            <code>{cronLine}</code>
          </div>
          <button className="secondary compact-action" onClick={copyCron} type="button">
            <Copy size={16} /> {copiedCron ? "Copied" : "Copy Crontab Line"}
          </button>
          <div className="fineprint">
            <span>Cron is not installed by this UI; copy this line into crontab to schedule unattended batches.</span>
            <span>It runs `npm run analyze` with the current settings, writes new batches under `artifacts/jobs`, and logs to `artifacts/cron.log`.</span>
            <span>Replace `/path/to/replay_lens` with this repository path after copying.</span>
          </div>
        </section>
      </section>

      <section className="content-grid">
        <section className="panel recordings" ref={candidatesRef}>
          <div className="section-head">
            <div>
              <span>Candidates</span>
              <h2>Candidate Recordings</h2>
            </div>
            <div className="section-actions">
              <button className="mini-button" disabled={!canStartBatch || starting} onClick={startJob} type="button" title={candidatePlanBody}>
                {starting ? <Loader2 className="spin" size={15} /> : <Play size={15} />}
                {startButtonText}
              </button>
              <button className="icon-button" disabled={loadingRecordings} onClick={loadRecordings} type="button" title="Reload candidate recordings from PostHog">
                {loadingRecordings ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
              </button>
            </div>
          </div>
          <div className="recording-head">
            <span />
            <span>Recording</span>
            <span>Started</span>
            <span>Length</span>
            <span>Input</span>
            <span>Score</span>
            <span>PostHog</span>
          </div>
          {candidateDiagnostics ? (
            <div className={cn("candidate-summary", candidateSetStale && !hasExactSelection && "candidate-summary-warn")}>
              <SlidersHorizontal size={15} />
              <span>
                {candidateSetStale && !hasExactSelection
                  ? "Filters changed after this candidate set loaded. Reload before analyzing so the table and batch match. "
                  : ""}
                Showing {Number(candidateDiagnostics.selected || recordings.length).toLocaleString()} candidates from {Number(candidateDiagnostics.scanned || 0).toLocaleString()} scanned recordings.
                {candidateDiagnostics.source === "hogql" ? " PostHog query filtering ran before local replay filters." : ""}
                {candidateDiagnostics.queryError ? " Query filtering fell back to list scanning." : ""}
              </span>
            </div>
          ) : null}
          <div className="recording-list">
            {recordings.length ? (
              recordings.map((recording) => (
                <RecordingRow
                  key={recording.id}
                  recording={recording}
                  selected={selectedIds.has(recording.id)}
                  onToggle={() => toggleSelected(recording.id)}
                />
              ))
            ) : (
              <EmptyState icon={Search} title="No recordings loaded" body="Load candidates from PostHog to inspect and optionally select sessions." />
            )}
          </div>
        </section>

        <section className="panel jobs">
          <div className="section-head">
            <div>
              <span>History</span>
              <h2>Batch History</h2>
            </div>
            <div className="section-actions">
              <button className="icon-button" disabled={loadingJobs} onClick={loadJobs} type="button" title="Refresh batch history">
                {loadingJobs ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
              </button>
              <button className="icon-button danger-icon" disabled={!jobs.length} onClick={clearHistory} type="button" title="Delete finished batches">
                <Trash2 size={18} />
              </button>
            </div>
          </div>
          <div className="job-list">
            {jobs.length ? (
              jobs.map((job) => (
                <button
                  className={cn("job-row", job.id === activeJob?.id && "selected")}
                  key={job.id}
                  onClick={() => setActiveJobId(job.id)}
                  type="button"
                >
                  <span>{job.id}</span>
                  <StatusPill status={job.status} />
                  <small>
                    {Number(job.results?.length || 0)}/{job.config?.count || 0} results
                  </small>
                  <small title={`${fmtTokenCount(job.costs?.inputTokens)} input, ${fmtTokenCount(job.costs?.outputTokens)} output`}>
                    {fmtCost(job.costs)}
                  </small>
                </button>
              ))
            ) : (
              <EmptyState icon={Clock3} title="No job history" body="Completed analysis jobs remain available from local artifacts." />
            )}
          </div>
        </section>
      </section>

      <SynthesisPanel synthesis={activeJob?.synthesis} />

      <section className="panel results">
        <div className="section-head">
          <div>
            <span>Evidence</span>
            <h2>Per-Recording Findings</h2>
          </div>
          <Bug size={20} aria-hidden="true" />
        </div>
        <div className="result-list">
          {asList(activeJob?.results).length ? (
            activeJob.results.map((result) => <ResultCard result={result} key={result.recording?.id} />)
          ) : (
            <EmptyState icon={Bug} title="No findings yet" body="Gemini outputs exact bugs, friction, behavior, and timestamped evidence here." />
          )}
        </div>
      </section>
    </main>
  );
}
