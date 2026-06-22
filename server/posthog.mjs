import { createHash } from "node:crypto";

function throttleSeconds(status, text) {
  if (status !== 429) return null;
  const match = String(text).match(/Expected available in\s+(\d+)\s+seconds/i);
  return match ? Number(match[1]) : null;
}

export async function posthogFetch(config, urlPath, options = {}) {
  if (!config.posthogKey) throw new Error("POSTHOG_PERSONAL_API_KEY is not configured.");
  const url = new URL(urlPath, config.posthogHost);
  const headers = {
    Authorization: `Bearer ${config.posthogKey}`,
    "Content-Type": "application/json",
    ...(options.headers || {})
  };
  let response;
  let text = "";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    response = await fetch(url, { ...options, headers });
    text = await response.text();
    const waitSeconds = throttleSeconds(response.status, text);
    if (
      waitSeconds !== null &&
      waitSeconds > 0 &&
      waitSeconds <= config.maxThrottleWaitSeconds &&
      attempt < 3
    ) {
      await new Promise((resolve) => setTimeout(resolve, (waitSeconds + 2) * 1000));
      continue;
    }
    if (response.ok || ![429, 500, 502, 503, 504].includes(response.status) || attempt === 3) break;
    await new Promise((resolve) => setTimeout(resolve, 750 * 2 ** attempt));
  }

  const contentType = response.headers.get("content-type") || "";
  let body = text;
  if (contentType.includes("application/json") && !contentType.includes("jsonl") && text) {
    body = JSON.parse(text);
  }
  if (!response.ok) {
    const detail = typeof body === "string" ? body.slice(0, 800) : JSON.stringify(body);
    throw new Error(`PostHog ${response.status} ${response.statusText} for ${url.pathname}: ${detail}`);
  }
  return body;
}

export async function listAll(config, urlPath, limit = 100, options = {}) {
  const first = new URL(urlPath, config.posthogHost);
  if (!first.searchParams.has("limit")) first.searchParams.set("limit", String(limit));
  const pageLimit = Math.max(1, Number(first.searchParams.get("limit") || limit));
  const maxPages = Math.max(1, Number(options.maxPages || 20));
  const maxResults = Math.max(1, Number(options.maxResults || pageLimit * maxPages));
  let fallbackOffset = Number(first.searchParams.get("offset") || 0);
  const results = [];
  let nextUrl = first.toString();
  for (let page = 0; nextUrl && page < maxPages && results.length < maxResults; page += 1) {
    const next = new URL(nextUrl);
    const body = await posthogFetch(config, `${next.pathname}${next.search}`);
    if (Array.isArray(body.results)) {
      results.push(...body.results);
      if (body.next) {
        nextUrl = body.next;
      } else if (body.results.length >= pageLimit) {
        fallbackOffset += pageLimit;
        const fallback = new URL(first.toString());
        fallback.searchParams.set("offset", String(fallbackOffset));
        nextUrl = fallback.toString();
      } else {
        nextUrl = null;
      }
    } else if (Array.isArray(body)) {
      results.push(...body);
      nextUrl = null;
    } else {
      return body;
    }
  }
  return results.slice(0, maxResults);
}

export async function discoverProject(config) {
  if (config.posthogProjectId) {
    return { id: String(config.posthogProjectId), name: "Configured project" };
  }
  const projects = await listAll(config, "/api/projects/?limit=200", 200);
  if (config.posthogProjectToken) {
    const match = projects.find((project) => project.api_token === config.posthogProjectToken);
    if (match) return match;
  }
  if (!projects[0]) throw new Error("No PostHog projects were returned for this API key.");
  return projects[0];
}

export function recordingScore(recording) {
  const active = Number(recording.active_seconds || 0);
  const clicks = Number(recording.click_count || 0);
  const keys = Number(recording.keypress_count || 0);
  const mouse = Number(recording.mouse_activity_count || 0);
  const duration = Number(recording.recording_duration || 0);
  const url = String(recording.start_url || "");
  return (
    active * 2 +
    clicks * 20 +
    keys * 0.4 +
    mouse * 0.25 +
    Math.min(duration, 3600) * 0.05 +
    (url.includes("/ask") ? 250 : 0) +
    (url.includes("/projects") ? 150 : 0)
  );
}

export function recordingActivityScore(recording) {
  const active = Number(recording.active_seconds || 0);
  const clicks = Number(recording.click_count || 0);
  const keys = Number(recording.keypress_count || 0);
  const mouse = Number(recording.mouse_activity_count || 0);
  return active + clicks * 8 + keys * 0.2 + mouse * 0.03;
}

function hashKey(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 10);
}

export function recordingUserKey(recording) {
  const raw =
    recording.distinct_id ||
    recording.person?.id ||
    recording.person?.uuid ||
    recording.person?.distinct_ids?.[0] ||
    recording.person_id ||
    recording.user_id ||
    "";
  return raw ? `user_${hashKey(raw)}` : "user_unknown";
}

function pushSearchValue(values, value) {
  if (Array.isArray(value)) {
    for (const item of value) pushSearchValue(values, item);
    return;
  }
  if (value === undefined || value === null || typeof value === "object") return;
  const text = String(value).trim();
  if (text) values.push(text);
}

export function recordingUserSearchValues(recording) {
  const userKey = recordingUserKey(recording);
  const values = [userKey, userKey.replace(/^user_/, "")];
  pushSearchValue(values, recording.distinct_id);
  pushSearchValue(values, recording.person?.id);
  pushSearchValue(values, recording.person?.uuid);
  pushSearchValue(values, recording.person?.distinct_ids);
  pushSearchValue(values, recording.person_id);
  pushSearchValue(values, recording.user_id);

  const properties = recording.person?.properties || recording.person_properties || {};
  for (const key of ["email", "$email", "name", "$name", "username", "user_id", "id", "distinct_id"]) {
    pushSearchValue(values, properties[key]);
  }

  return [...new Set(values)];
}

function hogqlString(value) {
  return `'${String(value ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function ilikeClause(expression, term) {
  return `${expression} ilike ${hogqlString(`%${term}%`)}`;
}

export function recordingMatchesUserTerms(recording, terms) {
  const needles = terms.map((term) => String(term || "").trim().toLowerCase()).filter(Boolean);
  if (!needles.length) return true;
  const haystack = recordingUserSearchValues(recording).map((value) => value.toLowerCase());
  return needles.some((needle) => haystack.some((value) => value === needle || value.includes(needle)));
}

export function recordingRouteKey(recording) {
  const rawUrl = String(recording.start_url || recording.url || "");
  try {
    const url = new URL(rawUrl);
    return `${url.hostname}${url.pathname.replace(/\/+$/, "") || "/"}`;
  } catch {
    return rawUrl.split(/[?#]/)[0].replace(/\/+$/, "") || "unknown_route";
  }
}

export function recordingDuplicateKey(recording) {
  const startedAt = recording.start_time ? new Date(recording.start_time).getTime() : 0;
  const fiveMinuteBucket = Number.isFinite(startedAt) && startedAt > 0 ? Math.floor(startedAt / 300000) : 0;
  const durationBucket = Math.round(Number(recording.recording_duration || 0) / 30);
  const activeBucket = Math.round(Number(recording.active_seconds || 0) / 15);
  const clickBucket = Math.round(Number(recording.click_count || 0) / 2);
  return [
    recordingUserKey(recording),
    recordingRouteKey(recording),
    fiveMinuteBucket,
    durationBucket,
    activeBucket,
    clickBucket
  ].join("|");
}

export function recordingPostHogUrl(config, projectId, recordingId) {
  if (!config?.posthogHost || !projectId || !recordingId) return null;
  return new URL(`/project/${encodeURIComponent(projectId)}/replay/${encodeURIComponent(recordingId)}`, config.posthogHost).toString();
}

export async function querySessionRecordingIds(config, projectId, filters = {}) {
  const userTerms = filters.userTerms || [];
  const urlIncludes = filters.urlIncludes || [];
  const urlExcludes = filters.urlExcludes || [];
  const maxAgeDays = Number(filters.maxAgeDays || 0);
  const limit = Math.max(1, Math.min(1000, Number(filters.limit || 250)));
  const clauses = ["properties.$session_id is not null"];

  if (maxAgeDays > 0) {
    clauses.push(`timestamp >= now() - interval ${Math.round(maxAgeDays)} day`);
  }

  if (userTerms.length) {
    clauses.push(`(${userTerms.map((term) => {
      const value = hogqlString(term);
      return [
        `person.properties.email = ${value}`,
        ilikeClause("person.properties.email", term),
        ilikeClause("person.properties.name", term),
        ilikeClause("person.properties.username", term),
        ilikeClause("distinct_id", term)
      ].join(" or ");
    }).join(" or ")})`);
  }

  if (urlIncludes.length) {
    clauses.push(`(${urlIncludes.map((term) => ilikeClause("properties.$current_url", term)).join(" or ")})`);
  }

  if (urlExcludes.length) {
    for (const term of urlExcludes) clauses.push(`not ${ilikeClause("properties.$current_url", term)}`);
  }

  const query = `select properties.$session_id as session_id, max(timestamp) as last_seen
from events
where ${clauses.join("\n  and ")}
group by session_id
order by last_seen desc
limit ${limit}`;

  const body = await posthogFetch(config, `/api/projects/${encodeURIComponent(projectId)}/query/`, {
    method: "POST",
    body: JSON.stringify({
      query: { kind: "HogQLQuery", query },
      name: "replay_lens-session-filter"
    })
  });

  return [...new Set((body.results || []).map((row) => row?.[0]).filter(Boolean).map(String))];
}

export async function fetchRecordingById(config, projectId, recordingId) {
  return posthogFetch(
    config,
    `/api/projects/${encodeURIComponent(projectId)}/session_recordings/${encodeURIComponent(recordingId)}/`
  );
}

export async function fetchRecordingsByIds(config, projectId, recordingIds, concurrency = 8) {
  const recordings = [];
  for (let index = 0; index < recordingIds.length; index += concurrency) {
    const chunk = recordingIds.slice(index, index + concurrency);
    const settled = await Promise.allSettled(chunk.map((id) => fetchRecordingById(config, projectId, id)));
    for (const result of settled) {
      if (result.status === "fulfilled") recordings.push(result.value);
    }
  }
  return recordings;
}

export function compactRecording(recording, context = {}) {
  return {
    id: recording.id,
    user: recordingUserKey(recording),
    route: recordingRouteKey(recording),
    start_time: recording.start_time,
    end_time: recording.end_time,
    duration: recording.recording_duration,
    active: recording.active_seconds,
    clicks: recording.click_count,
    keys: recording.keypress_count,
    mouse: recording.mouse_activity_count,
    activityScore: Math.round(recordingActivityScore(recording)),
    url: recording.start_url,
    posthogUrl: recordingPostHogUrl(context.config, context.projectId, recording.id),
    ongoing: recording.ongoing,
    score: Math.round(recordingScore(recording))
  };
}

export async function listRecordings(config, projectId, limit = 100, options = {}) {
  const pageLimit = Math.max(1, Math.min(250, Number(limit || 100)));
  const recordings = await listAll(
    config,
    `/api/projects/${encodeURIComponent(projectId)}/session_recordings/?limit=${pageLimit}`,
    pageLimit,
    { maxResults: options.maxResults || pageLimit }
  );
  return recordings.sort((a, b) => recordingScore(b) - recordingScore(a));
}

export async function searchPersons(config, projectId, search = "", limit = 12) {
  const params = new URLSearchParams({
    limit: String(Math.max(1, Math.min(25, Number(limit || 12))))
  });
  if (String(search || "").trim()) params.set("search", String(search).trim());
  const body = await posthogFetch(config, `/api/projects/${encodeURIComponent(projectId)}/persons/?${params.toString()}`);
  return (body.results || []).map((person) => {
    const properties = person.properties || {};
    const email = properties.email || properties.$email || "";
    const name = person.name || properties.name || properties.$name || email || "";
    const filterValue = email || person.distinct_ids?.[0] || person.id;
    return {
      id: person.id,
      user: person.id ? `user_${hashKey(person.id)}` : "user_unknown",
      name,
      email,
      distinctIds: (person.distinct_ids || []).slice(0, 3),
      lastSeenAt: person.last_seen_at,
      filterValue
    };
  });
}
