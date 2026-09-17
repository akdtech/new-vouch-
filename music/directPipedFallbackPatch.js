"use strict";

/*
 * DEATH Music 24/7 — Piped fallback for YouTube datacenter bot-checks.
 *
 * Railway/other datacenter IPs can be blocked by YouTube even when yt-dlp,
 * Deno and a valid PO-token provider are installed. This patch keeps the
 * normal yt-dlp path, but adds a rotating Piped API/proxy path before it.
 * If Piped is unavailable, the original yt-dlp engine remains the fallback.
 */
const { spawn } = require("node:child_process");
const { createAudioResource, StreamType } = require("@discordjs/voice");
const { PassThrough } = require("node:stream");

const DEFAULT_PIPED_INSTANCES = [
  "https://pipedapi.adminforge.de",
  "https://api.piped.yt",
  "https://pipedapi.reallyaweso.me",
  "https://pipedapi.owo.si",
  "https://pipedapi.ducks.party",
  "https://piped-api.codespace.cz",
  "https://api.piped.private.coffee",
  "https://pipedapi.darkness.services"
];

const PIPED_INSTANCES = String(process.env.PIPED_API_URLS || DEFAULT_PIPED_INSTANCES.join(","))
  .split(",")
  .map(value => value.trim().replace(/\/$/, ""))
  .filter(Boolean);

const PIPED_TIMEOUT_MS = Math.max(2500, Number(process.env.PIPED_TIMEOUT_MS || 8000));
const PIPED_STARTUP_TIMEOUT_MS = Math.max(4000, Number(process.env.PIPED_STARTUP_TIMEOUT_MS || 9000));
const FFMPEG = process.env.FFMPEG_PATH || "/usr/bin/ffmpeg";

function youtubeId(value) {
  const text = String(value || "").trim();
  const match = text.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/i);
  return match?.[1] || null;
}

function clean(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function withTimeout(promise, ms, message = "Piped request timed out.") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function requestJson(url) {
  const response = await withTimeout(fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "DEATH-Music-24-7/1.0"
    },
    redirect: "follow"
  }), PIPED_TIMEOUT_MS, "Piped API timed out.");

  if (!response.ok) throw new Error(`Piped API HTTP ${response.status}`);
  return response.json();
}

async function firstPipedRequest(path) {
  const errors = [];
  for (const base of PIPED_INSTANCES) {
    try {
      const data = await requestJson(`${base}${path}`);
      return { data, base };
    } catch (error) {
      errors.push(`${base}: ${error?.message || error}`);
    }
  }
  throw new Error(`All Piped instances failed. ${errors.join(" | ")}`);
}

function durationMs(seconds) {
  const value = Number(seconds || 0);
  return Number.isFinite(value) && value > 0 ? Math.round(value * 1000) : 0;
}

function normalizePipedItem(item, requester) {
  const rawUrl = item?.url || item?.link || "";
  const id = youtubeId(rawUrl) || item?.id || item?.videoId || null;
  if (!id) return null;

  return {
    identifier: id,
    id,
    url: `https://www.youtube.com/watch?v=${id}`,
    title: clean(item?.title) || "Unknown track",
    author: clean(item?.uploaderName || item?.uploader || item?.author) || "Unknown artist",
    length: durationMs(item?.duration),
    requester,
    thumbnail: item?.thumbnail || item?.thumbnailUrl || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    isAutoplay: false,
    source: "piped"
  };
}

async function pipedSearch(query, requester) {
  const encoded = encodeURIComponent(clean(query));
  const { data, base } = await firstPipedRequest(`/search?q=${encoded}&filter=videos`);
  const items = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
  const tracks = items.map(item => normalizePipedItem(item, requester)).filter(Boolean).slice(0, 5);
  if (!tracks.length) throw new Error(`Piped returned no video results for "${clean(query)}".`);
  console.log(`🔎 Piped search success via ${base}: ${tracks[0].title}`);
  return { type: "track", tracks };
}

async function pipedInfo(videoId, requester) {
  const { data, base } = await firstPipedRequest(`/streams/${videoId}`);
  if (!data || !Array.isArray(data.audioStreams) || !data.audioStreams.length) {
    throw new Error("Piped returned no audio streams.");
  }
  const track = normalizePipedItem({
    id: videoId,
    title: data.title,
    uploaderName: data.uploader,
    duration: data.duration,
    thumbnail: data.thumbnailUrl
  }, requester);
  if (!track) throw new Error("Piped returned invalid track metadata.");
  console.log(`🎼 Piped stream metadata via ${base}: ${track.title}`);
  return { data, base, track };
}

function chooseAudioStream(streams) {
  return [...streams]
    .filter(stream => stream?.url && !stream.videoOnly)
    .sort((a, b) => {
      const aMp4 = /audio\/mp4|mp4a/i.test(String(a?.mimeType || "")) ? 1 : 0;
      const bMp4 = /audio\/mp4|mp4a/i.test(String(b?.mimeType || "")) ? 1 : 0;
      if (aMp4 !== bMp4) return bMp4 - aMp4;
      return Number(b?.bitrate || 0) - Number(a?.bitrate || 0);
    })[0] || null;
}

async function startPipedTrack(manager, guildId, track, startMs = 0) {
  const videoId = youtubeId(track?.url) || track?.id || track?.identifier;
  if (!videoId) return false;

  const state = manager.getState(guildId);
  const player = manager.players.get(guildId) || manager.ensurePlayer(guildId);
  manager.bindPlayerEvents(guildId, player);

  let metadata;
  try {
    metadata = await pipedInfo(videoId, track.requester || manager.client.user);
  } catch (error) {
    console.warn(`⚠️ Piped metadata failed; keeping yt-dlp fallback: ${error?.message || error}`);
    return false;
  }

  const mergedTrack = {
    ...track,
    ...metadata.track,
    identifier: videoId,
    id: videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    isAutoplay: Boolean(track.isAutoplay),
    autoplayGroup: track.autoplayGroup,
    requester: track.requester || metadata.track.requester
  };

  const stream = chooseAudioStream(metadata.data.audioStreams);
  if (!stream?.url) {
    console.warn("⚠️ Piped had metadata but no usable audio stream; keeping yt-dlp fallback.");
    return false;
  }

  manager.destroyStream(guildId);
  state.current = mergedTrack;
  state.startedAt = 0;
  state.positionOffset = Math.max(0, Number(startMs || 0));
  state.paused = false;
  state.audioResource = null;
  state.transitioning = true;
  Promise.resolve(manager.refreshPanel?.(guildId)).catch(() => {});

  const pcm = new PassThrough({ highWaterMark: 1024 * 1024 });
  const resource = createAudioResource(pcm, {
    inputType: StreamType.Raw,
    inlineVolume: true,
    metadata: mergedTrack
  });
  resource.volume?.setVolume(Math.max(0.01, Number(state.volume || 70) / 100));
  state.audioResource = resource;
  player.play(resource);

  const ff = spawn(FFMPEG, [
    "-hide_banner", "-loglevel", "warning", "-nostdin",
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "5",
    "-user_agent", "Mozilla/5.0",
    "-i", stream.url,
    ...(startMs > 0 ? ["-ss", String(startMs / 1000)] : []),
    "-vn", "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"
  ], { stdio: ["ignore", "pipe", "pipe"] });

  manager.streams.set(guildId, { yt: null, ff, pcm, resource, source: "piped" });

  return await new Promise(resolve => {
    let settled = false;
    let gotPcm = false;
    let stderr = "";
    let timer = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      try { ff.stdout.unpipe(pcm); } catch {}
      try { ff.kill("SIGKILL"); } catch {}
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      state.transitioning = false;
      state.startedAt = Date.now();
      state.audioResource = resource;
      Promise.resolve(manager.refreshPanel?.(guildId)).catch(() => {});
      console.log(`🚀 Piped direct playback started: ${mergedTrack.title}`);
      resolve(true);
    };
    const fail = reason => {
      if (settled) return;
      settled = true;
      cleanup();
      try { player.stop(true); } catch {}
      try { pcm.destroy(); } catch {}
      manager.destroyStream(guildId);
      state.audioResource = null;
      state.transitioning = false;
      console.warn(`⚠️ Piped playback failed; falling back to yt-dlp: ${reason}`);
      resolve(false);
    };

    ff.stderr.on("data", chunk => {
      stderr += chunk.toString();
      if (stderr.length > 5000) stderr = stderr.slice(-5000);
    });
    ff.stdout.on("data", chunk => {
      if (chunk?.length) {
        gotPcm = true;
        succeed();
      }
    });
    ff.stdout.on("error", error => fail(error?.message || error));
    ff.on("error", error => fail(error?.message || error));
    ff.on("close", code => {
      if (!gotPcm) fail(`FFmpeg exited with code ${code}: ${clean(stderr) || "no audio bytes"}`);
    });

    ff.stdout.pipe(pcm);
    timer = setTimeout(() => {
      if (!gotPcm) fail(`no PCM audio within ${PIPED_STARTUP_TIMEOUT_MS / 1000}s`);
    }, PIPED_STARTUP_TIMEOUT_MS);
  });
}

function installPipedFallbackPatch(DirectMusicManager) {
  if (!DirectMusicManager || DirectMusicManager.prototype.__deathPipedFallbackPatched) return;
  DirectMusicManager.prototype.__deathPipedFallbackPatched = true;

  const originalSearch = DirectMusicManager.prototype.search;
  DirectMusicManager.prototype.search = async function deathPipedSearch(query, requester) {
    const cleanQuery = this.cleanQuery(query);
    const isYoutube = this.isYouTubeUrl(cleanQuery);

    try {
      if (isYoutube) {
        const id = youtubeId(cleanQuery);
        if (id) {
          const info = await pipedInfo(id, requester || this.client.user);
          return { type: "track", tracks: [info.track] };
        }
      } else {
        return await pipedSearch(cleanQuery, requester || this.client.user);
      }
    } catch (error) {
      console.warn(`⚠️ Piped search fallback unavailable; using yt-dlp: ${error?.message || error}`);
    }

    return originalSearch.call(this, query, requester);
  };

  const originalStartTrack = DirectMusicManager.prototype.startTrack;
  DirectMusicManager.prototype.startTrack = async function deathPipedStartTrack(guildId, track, startMs = 0) {
    const url = track?.url || "";
    if (/youtube\.com|youtu\.be/i.test(url)) {
      try {
        const pipedStarted = await startPipedTrack(this, guildId, track, startMs);
        if (pipedStarted) return;
      } catch (error) {
        console.warn(`⚠️ Piped playback exception; using yt-dlp: ${error?.message || error}`);
      }
    }

    return originalStartTrack.call(this, guildId, track, startMs);
  };

  console.log(`🛟 DEATH Piped fallback loaded: ${PIPED_INSTANCES.length} rotating public instances before yt-dlp.`);
}

try {
  const DirectMusicManager = require("./DirectMusicManager");
  installPipedFallbackPatch(DirectMusicManager);
} catch (error) {
  console.error("❌ Piped fallback patch failed to load:", error?.message || error);
}

module.exports = { installPipedFallbackPatch };
