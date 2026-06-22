import { chromium } from "playwright";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { posthogFetch } from "./posthog.mjs";

const execFileAsync = promisify(execFile);
const MAX_POSTHOG_BLOB_KEYS_PER_REQUEST = 20;
const MAX_REPLAY_IDLE_GAP_SECONDS = 2.5;

function abortError() {
  const error = new Error("Canceled by user");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function abortPromise(signal) {
  return new Promise((_, reject) => {
    if (!signal) return;
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    signal.addEventListener("abort", () => reject(abortError()), { once: true });
  });
}

function unzipJson(compressedString) {
  return JSON.parse(gunzipSync(Buffer.from(compressedString, "latin1")).toString("utf8"));
}

function decompressPostHogEvent(event, recordingId) {
  if (!event || typeof event !== "object" || !("cv" in event)) return event;
  if (event.cv !== "2024-10") return event;
  try {
    if (event.type === 2 && typeof event.data === "string") {
      const { cv: _cv, ...rest } = event;
      return { ...rest, data: unzipJson(event.data) };
    }
    if (event.type === 3 && event.data && typeof event.data === "object") {
      const data = { ...event.data };
      for (const key of ["adds", "removes", "texts", "attributes"]) {
        if (typeof data[key] === "string") data[key] = unzipJson(data[key]);
      }
      const { cv: _cv, ...rest } = event;
      return { ...rest, data };
    }
  } catch (error) {
    throw new Error(`Could not decompress replay event for ${recordingId}: ${error.message}`);
  }
  const { cv: _cv, ...rest } = event;
  return rest;
}

export async function fetchSnapshotEvents(config, projectId, recordingId) {
  const sourcesResponse = await posthogFetch(
    config,
    `/api/projects/${encodeURIComponent(projectId)}/session_recordings/${encodeURIComponent(recordingId)}/snapshots?blob_v2=true`
  );
  const sources = sourcesResponse.sources || [];
  if (!sources.length) throw new Error(`No snapshot sources found for ${recordingId}.`);

  const blobKeys = sources
    .filter((source) => source.source === "blob_v2" && source.blob_key !== undefined)
    .map((source) => String(source.blob_key))
    .sort((a, b) => Number(a) - Number(b));

  const snapshotChunkSize = Math.max(
    1,
    Math.min(MAX_POSTHOG_BLOB_KEYS_PER_REQUEST, Number(config.snapshotChunkSize || MAX_POSTHOG_BLOB_KEYS_PER_REQUEST))
  );

  const events = [];
  for (let index = 0; index < blobKeys.length; index += snapshotChunkSize) {
    const chunk = blobKeys.slice(index, index + snapshotChunkSize);
    const startBlobKey = chunk[0];
    const endBlobKey = chunk[chunk.length - 1];
    const jsonl = await posthogFetch(
      config,
      `/api/projects/${encodeURIComponent(projectId)}/session_recordings/${encodeURIComponent(recordingId)}/snapshots?source=blob_v2&start_blob_key=${encodeURIComponent(startBlobKey)}&end_blob_key=${encodeURIComponent(endBlobKey)}&decompress=true`,
      { headers: { Accept: "application/jsonl,application/json,text/plain" } }
    );
    for (const line of String(jsonl).split(/\r?\n/)) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line);
      const windowId = Array.isArray(parsed) ? parsed[0] : parsed.window_id || parsed.windowId;
      const rawEvent = Array.isArray(parsed) ? parsed[1] : parsed;
      const event = decompressPostHogEvent(
        windowId && rawEvent && !rawEvent.windowId ? { windowId, ...rawEvent } : rawEvent,
        recordingId
      );
      if (event && typeof event.timestamp === "number" && typeof event.type === "number") {
        events.push(event);
      }
    }
  }

  events.sort((a, b) => a.timestamp - b.timestamp);
  const rawEventCount = events.length;
  const firstFullSnapshotIndex = events.findIndex((event) => event.type === 2);
  if (firstFullSnapshotIndex === -1) {
    throw new Error(`Fetched ${events.length} events for ${recordingId}, but no full snapshot exists.`);
  }

  let renderStartIndex = firstFullSnapshotIndex;
  for (let index = firstFullSnapshotIndex; index >= 0; index -= 1) {
    if (events[index].type === 4) {
      renderStartIndex = index;
      break;
    }
  }
  const renderEvents = events.slice(renderStartIndex);
  const typeCounts = {};
  for (const event of renderEvents) typeCounts[event.type] = (typeCounts[event.type] || 0) + 1;

  const firstTimestamp = renderEvents[0]?.timestamp;
  const lastTimestamp = renderEvents[renderEvents.length - 1]?.timestamp;
  return {
    sources,
    events: renderEvents,
    snapshotInfo: {
      sourceCount: sources.length,
      blobKeyCount: blobKeys.length,
      snapshotChunkSize,
      rawEventCount,
      skippedBeforeFirstFullSnapshot: renderStartIndex,
      eventCount: renderEvents.length,
      typeCounts,
      firstTimestamp,
      lastTimestamp,
      renderableOriginalSeconds:
        typeof firstTimestamp === "number" && typeof lastTimestamp === "number"
          ? Math.max(0, (lastTimestamp - firstTimestamp) / 1000)
          : null
    }
  };
}

export function autoCaptureSeconds(snapshotInfo, speed, minSeconds, maxSeconds) {
  const renderable = Number(
    snapshotInfo?.activeCompressedSeconds ||
    snapshotInfo?.renderableOriginalSeconds ||
    minSeconds
  );
  const spedUp = renderable / Math.max(1, Number(speed || 1));
  return Math.max(minSeconds, Math.min(maxSeconds, Math.ceil(spedUp + 2)));
}

export function autoPlaybackSpeed(snapshotInfo, requestedSpeed, maxSeconds) {
  const requested = Math.max(1, Number(requestedSpeed || 1));
  const renderable = Number(
    snapshotInfo?.activeCompressedSeconds ||
    snapshotInfo?.renderableOriginalSeconds ||
    0
  );
  if (!Number.isFinite(renderable) || renderable <= 0) return requested;
  const availableSeconds = Math.max(1, Number(maxSeconds || 1) - 2);
  const needed = Math.ceil(renderable / availableSeconds);
  return Math.max(requested, Math.min(60, needed));
}

export function compressInactiveTimeline(events, maxGapSeconds = MAX_REPLAY_IDLE_GAP_SECONDS) {
  if (!Array.isArray(events) || events.length < 2) {
    return {
      events: Array.isArray(events) ? events : [],
      compression: {
        enabled: false,
        maxGapSeconds,
        originalSeconds: 0,
        activeCompressedSeconds: 0,
        removedInactiveSeconds: 0,
        compressedGapCount: 0,
        largestRemovedGaps: []
      }
    };
  }

  const maxGapMs = Math.max(250, Number(maxGapSeconds || MAX_REPLAY_IDLE_GAP_SECONDS) * 1000);
  const firstTimestamp = Number(events[0].timestamp);
  let previousOriginal = firstTimestamp;
  let previousCompressed = firstTimestamp;
  let removedInactiveMs = 0;
  let compressedGapCount = 0;
  const largestRemovedGaps = [];

  const compressedEvents = events.map((event, index) => {
    if (index === 0) return { ...event };

    const originalTimestamp = Number(event.timestamp);
    const originalGap = Math.max(0, originalTimestamp - previousOriginal);
    const compressedGap = Math.min(originalGap, maxGapMs);
    const compressedTimestamp = previousCompressed + compressedGap;
    const removedGap = Math.max(0, originalGap - compressedGap);

    if (removedGap > 0) {
      compressedGapCount += 1;
      removedInactiveMs += removedGap;
      largestRemovedGaps.push({
        afterOriginalSecond: Math.round((previousOriginal - firstTimestamp) / 1000),
        beforeOriginalSecond: Math.round((originalTimestamp - firstTimestamp) / 1000),
        originalGapSeconds: Math.round(originalGap / 1000),
        compressedToSeconds: Math.round(compressedGap / 1000),
        removedSeconds: Math.round(removedGap / 1000)
      });
    }

    previousOriginal = originalTimestamp;
    previousCompressed = compressedTimestamp;
    return { ...event, timestamp: compressedTimestamp };
  });

  largestRemovedGaps.sort((a, b) => b.removedSeconds - a.removedSeconds);
  const originalSeconds = Math.max(0, (Number(events.at(-1)?.timestamp || firstTimestamp) - firstTimestamp) / 1000);
  const activeCompressedSeconds = Math.max(0, (Number(compressedEvents.at(-1)?.timestamp || firstTimestamp) - firstTimestamp) / 1000);

  return {
    events: compressedEvents,
    compression: {
      enabled: compressedGapCount > 0,
      maxGapSeconds,
      originalSeconds,
      activeCompressedSeconds,
      removedInactiveSeconds: removedInactiveMs / 1000,
      compressedGapCount,
      largestRemovedGaps: largestRemovedGaps.slice(0, 12)
    }
  };
}

export async function writeReplayHtml({ events, htmlPath, width, height, speed, timelineCompression }) {
  const rrwebScript = pathToFileURL(path.resolve("node_modules/rrweb/umd/rrweb.js")).href;
  const rrwebStyle = pathToFileURL(path.resolve("node_modules/rrweb/dist/style.css")).href;
  const eventJson = JSON.stringify(events).replace(/</g, "\\u003c");
  const statusText = timelineCompression?.enabled
    ? `active-compressed ${events.length} events at ${Number(speed)}x`
    : `playing ${events.length} events at ${Number(speed)}x`;
  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="${rrwebStyle}">
  <style>
    html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #0f172a; }
    #player { position: relative; width: ${width}px; height: ${height}px; background: #0f172a; overflow: hidden; }
    #status { display: none; }
    #player .replayer-wrapper { position: absolute !important; margin: 0 !important; transform-origin: top left !important; }
    iframe { border: 0 !important; transform-origin: top left; }
  </style>
</head>
<body>
  <div id="player"></div>
  <div id="status">loading...</div>
  <script src="${rrwebScript}"></script>
  <script>
    const events = ${eventJson};
    const status = document.getElementById("status");
    const player = document.getElementById("player");
    const outputWidth = ${Number(width)};
    const outputHeight = ${Number(height)};
    const metaEvent = events.find((event) => event && event.type === 4 && event.data && event.data.width && event.data.height);
    const initialReplayWidth = Number(metaEvent?.data?.width || outputWidth);
    const initialReplayHeight = Number(metaEvent?.data?.height || outputHeight);
    let lastFitKey = "";

    function fitReplayToFrame() {
      const wrapper = player.querySelector(".replayer-wrapper");
      const iframe = wrapper?.querySelector("iframe");
      if (!wrapper || !iframe) return false;

      const replayWidth = Math.max(1, Number(iframe.getAttribute("width") || initialReplayWidth || iframe.offsetWidth || outputWidth));
      const replayHeight = Math.max(1, Number(iframe.getAttribute("height") || initialReplayHeight || iframe.offsetHeight || outputHeight));
      const scale = Math.min(outputWidth / replayWidth, outputHeight / replayHeight);
      const fittedWidth = replayWidth * scale;
      const fittedHeight = replayHeight * scale;
      const offsetX = Math.max(0, (outputWidth - fittedWidth) / 2);
      const offsetY = Math.max(0, (outputHeight - fittedHeight) / 2);
      const fitKey = [replayWidth, replayHeight, scale.toFixed(6), offsetX.toFixed(2), offsetY.toFixed(2)].join(":");
      if (fitKey === lastFitKey) return true;

      lastFitKey = fitKey;
      wrapper.style.width = replayWidth + "px";
      wrapper.style.height = replayHeight + "px";
      wrapper.style.left = "0";
      wrapper.style.top = "0";
      wrapper.style.transform = "translate(" + offsetX + "px, " + offsetY + "px) scale(" + scale + ")";
      iframe.style.width = replayWidth + "px";
      iframe.style.height = replayHeight + "px";
      return true;
    }

    function waitUntilFitted() {
      if (fitReplayToFrame()) {
        window.__replayReady = true;
        return;
      }
      window.setTimeout(waitUntilFitted, 50);
    }

    if (!window.rrweb || !window.rrweb.Replayer) throw new Error("rrweb Replayer was not loaded");
    const replayer = new window.rrweb.Replayer(events, {
      root: document.getElementById("player"),
      speed: ${Number(speed)},
      skipInactive: false,
      showWarning: false,
      showDebug: false,
      mouseTail: false
    });
    window.__rrwebReplayer = replayer;
    status.textContent = ${JSON.stringify(statusText)};
    replayer.play();
    waitUntilFitted();
    window.setInterval(fitReplayToFrame, 1000);
  </script>
</body>
</html>`;
  await fs.writeFile(htmlPath, html);
}

async function newestFile(dir, extension) {
  const names = await fs.readdir(dir);
  const entries = await Promise.all(
    names
      .filter((name) => name.endsWith(extension))
      .map(async (name) => {
        const filePath = path.join(dir, name);
        const stats = await fs.stat(filePath);
        return { filePath, mtimeMs: stats.mtimeMs };
      })
  );
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries[0]?.filePath;
}

export async function recordReplayPage({ pageUrl, outputPrefix, seconds, width, height, signal }) {
  throwIfAborted(signal);
  const videoDir = `${outputPrefix}-video`;
  await fs.mkdir(videoDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const startedAt = Date.now();
  let context = null;
  let readyAt = Date.now();
  const consoleLines = [];
  try {
    context = await browser.newContext({
      viewport: { width, height },
      recordVideo: { dir: videoDir, size: { width, height } }
    });
    const page = await context.newPage();
    page.on("console", (message) => {
      const text = message.text();
      if (/error|warn|failed/i.test(text)) consoleLines.push(`${message.type()}: ${text.slice(0, 300)}`);
    });
    throwIfAborted(signal);
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction(() => window.__replayReady === true, { timeout: 30000 }).catch(() => {});
    readyAt = Date.now();
    throwIfAborted(signal);
    await Promise.race([page.waitForTimeout(seconds * 1000), abortPromise(signal)]);
    await context.close();
    await browser.close();
  } catch (error) {
    if (context) await context.close().catch(() => {});
    await browser.close().catch(() => {});
    throw error;
  }

  const webmPath = await newestFile(videoDir, ".webm");
  if (!webmPath) throw new Error("Playwright did not produce a WebM recording.");
  const outputWebm = `${outputPrefix}.webm`;
  await fs.rename(webmPath, outputWebm);
  return {
    outputWebm,
    consoleLines,
    preRollSeconds: Math.max(0, (readyAt - startedAt) / 1000)
  };
}

export async function convertForGemini(inputWebm, outputMp4, { trimStartSeconds, durationSeconds, signal }) {
  throwIfAborted(signal);
  const args = ["-y"];
  if (trimStartSeconds > 0) args.push("-ss", trimStartSeconds.toFixed(3));
  args.push(
    "-i",
    inputWebm,
    "-vf",
    "scale='min(960,iw)':-2,fps=8",
    "-t",
    String(Math.ceil(durationSeconds)),
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "30",
    "-movflags",
    "+faststart",
    outputMp4
  );
  await execFileAsync("ffmpeg", args, { maxBuffer: 1024 * 1024 * 8, signal });
  return outputMp4;
}

export async function renderReplayClip({ config, projectId, recording, outputDir, speed, minSeconds, maxSeconds, width, height, signal }) {
  throwIfAborted(signal);
  await fs.mkdir(outputDir, { recursive: true });
  const { events, snapshotInfo } = await fetchSnapshotEvents(config, projectId, recording.id);
  throwIfAborted(signal);
  const { events: compressedEvents, compression: timelineCompression } = compressInactiveTimeline(events);
  const compressedSnapshotInfo = {
    ...snapshotInfo,
    activeCompressedSeconds: timelineCompression.activeCompressedSeconds,
    removedInactiveSeconds: timelineCompression.removedInactiveSeconds,
    timelineCompression
  };
  const renderSpeed = autoPlaybackSpeed(compressedSnapshotInfo, speed, maxSeconds);
  const seconds = autoCaptureSeconds(compressedSnapshotInfo, renderSpeed, minSeconds, maxSeconds);
  const outputPrefix = path.join(outputDir, recording.id);
  const eventsPath = `${outputPrefix}-events.json`;
  const htmlPath = `${outputPrefix}.html`;
  const webmPath = `${outputPrefix}.webm`;
  const mp4Path = `${outputPrefix}.mp4`;
  await fs.writeFile(eventsPath, JSON.stringify(compressedEvents));
  await writeReplayHtml({ events: compressedEvents, htmlPath, width, height, speed: renderSpeed, timelineCompression });
  throwIfAborted(signal);
  const { outputWebm, consoleLines, preRollSeconds } = await recordReplayPage({
    pageUrl: pathToFileURL(htmlPath).href,
    outputPrefix,
    seconds,
    width,
    height,
    signal
  });
  if (outputWebm !== webmPath) await fs.rename(outputWebm, webmPath);
  const trimStartSeconds = Math.min(Math.max(0, preRollSeconds - 0.2), 10);
  await convertForGemini(webmPath, mp4Path, { trimStartSeconds, durationSeconds: seconds, signal });
  const mp4Bytes = (await fs.stat(mp4Path)).size;
  const metadata = {
    recording,
    speed: renderSpeed,
    requestedSpeed: speed,
    autoSpeedAdjusted: renderSpeed !== Number(speed),
    seconds,
    minSeconds,
    maxSeconds,
    width,
    height,
    snapshotInfo: compressedSnapshotInfo,
    timelineCompression,
    preRollSeconds,
    trimStartSeconds,
    mp4Bytes,
    consoleLines
  };
  await fs.writeFile(`${outputPrefix}-metadata.json`, JSON.stringify(metadata, null, 2));
  return { eventsPath, htmlPath, webmPath, mp4Path, metadata };
}
