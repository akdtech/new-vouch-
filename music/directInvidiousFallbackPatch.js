"use strict";

/* DEATH Music 24/7 — Invidious fallback for YouTube datacenter blocks.
 *
 * Important fix:
 * Do NOT take the adaptiveFormats.url returned by /api/v1/videos and hand
 * that already-signed URL to FFmpeg. Those URLs can be IP-bound and expire.
 * Instead, ask the same Invidious instance for /latest_version with the
 * selected audio itag and local=true. Invidious then creates a fresh playback
 * URL and proxies it through that instance.
 */
const { spawn } = require("node:child_process");
const { PassThrough } = require("node:stream");
const { createAudioResource, StreamType } = require("@discordjs/voice");

const INSTANCES = String(process.env.INVIDIOUS_API_URLS || [
  "https://inv.nadeko.net",
  "https://invidious.nerdvpn.de",
  "https://yt.chocolatemoo53.com",
  "https://invidious.tiekoetter.com",
  "https://invidious.f5.si"
].join(","))
  .split(",")
  .map(v => v.trim().replace(/\/$/, ""))
  .filter(Boolean);

const TIMEOUT = Math.max(4000, Number(process.env.INVIDIOUS_TIMEOUT_MS || 10000));
const STARTUP = Math.max(5000, Number(process.env.INVIDIOUS_STARTUP_TIMEOUT_MS || 10000));
const FFMPEG = process.env.FFMPEG_PATH || "/usr/bin/ffmpeg";
const clean = v => String(v || "").replace(/\s+/g, " ").trim();

function ytId(value) {
  const text = String(value || "").trim();
  return text.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/i)?.[1] || null;
}

function durationMs(v) {
  const n = Number(v || 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : 0;
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Invidious request timed out.")), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

async function json(url) {
  const response = await withTimeout(fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "DEATH-Music-24-7/1.0"
    },
    redirect: "follow"
  }), TIMEOUT);
  if (!response.ok) throw new Error(`Invidious HTTP ${response.status}`);
  return response.json();
}

async function first(path) {
  const errors = [];
  for (const base of INSTANCES) {
    try {
      return { data: await json(`${base}${path}`), base };
    } catch (error) {
      errors.push(`${base}: ${error?.message || error}`);
    }
  }
  throw new Error(`All Invidious instances failed. ${errors.join(" | ")}`);
}

function trackFrom(item, requester) {
  const id = item?.videoId || item?.id;
  if (!id) return null;
  const thumbs = Array.isArray(item?.videoThumbnails) ? item.videoThumbnails : [];
  return {
    identifier: id,
    id,
    url: `https://www.youtube.com/watch?v=${id}`,
    title: clean(item?.title) || "Unknown track",
    author: clean(item?.author || item?.uploader) || "Unknown artist",
    length: durationMs(item?.lengthSeconds ?? item?.duration),
    requester,
    thumbnail: thumbs.find(x => x?.quality === "maxres")?.url || thumbs.at(-1)?.url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    isAutoplay: false,
    source: "invidious"
  };
}

async function searchInvidious(query, requester) {
  const { data, base } = await first(`/api/v1/search?q=${encodeURIComponent(clean(query))}&type=video&sort=relevance`);
  const tracks = (Array.isArray(data) ? data : [])
    .filter(x => x?.type === "video")
    .map(x => trackFrom(x, requester))
    .filter(Boolean)
    .slice(0, 5);
  if (!tracks.length) throw new Error(`Invidious returned no video results for "${clean(query)}".`);
  console.log(`🔎 Invidious search success via ${base}: ${tracks[0].title}`);
  return { type: "track", tracks };
}

async function metadataOnInstance(base, id, requester) {
  const data = await json(`${base}/api/v1/videos/${id}?local=true`);
  const track = trackFrom({
    videoId: id,
    title: data?.title,
    author: data?.author,
    lengthSeconds: data?.lengthSeconds,
    videoThumbnails: data?.videoThumbnails
  }, requester);
  if (!track) throw new Error("Invidious returned invalid video metadata.");

  const formats = [
    ...(Array.isArray(data?.adaptiveFormats) ? data.adaptiveFormats : []),
    ...(Array.isArray(data?.formatStreams) ? data.formatStreams : [])
  ];

  const audio = formats
    .filter(x => x?.itag && (String(x?.type || "").toLowerCase().includes("audio") || String(x?.mimeType || "").toLowerCase().includes("audio")))
    .sort((a, b) => Number(b?.bitrate || 0) - Number(a?.bitrate || 0))[0];

  if (!audio?.itag) throw new Error("Invidious returned no usable audio itag.");

  return {
    base,
    track,
    itag: String(audio.itag)
  };
}

function proxiedLatestVersion(base, id, itag) {
  return `${base}/latest_version?id=${encodeURIComponent(id)}&itag=${encodeURIComponent(itag)}&local=true`;
}

async function startInvidious(manager, guildId, track, startMs = 0) {
  const id = ytId(track?.url) || track?.id || track?.identifier;
  if (!id) return false;

  const requester = track.requester || manager.client.user;
  let lastError = null;

  /* Try EVERY healthy Invidious instance for actual playback.
   * A search/metadata request succeeding does not mean its YouTube playback
   * proxy is healthy, so playback must be tested independently per instance.
   */
  for (const base of INSTANCES) {
    let meta;
    try {
      meta = await metadataOnInstance(base, id, requester);
      console.log(`🎼 Invidious audio route ready via ${base}: ${meta.track.title} (itag ${meta.itag})`);
    } catch (error) {
      lastError = error;
      console.warn(`⚠️ Invidious metadata failed on ${base}: ${error?.message || error}`);
      continue;
    }

    const state = manager.getState(guildId);
    const player = manager.players.get(guildId) || manager.ensurePlayer(guildId);
    manager.bindPlayerEvents(guildId, player);
    manager.destroyStream(guildId);

    const merged = {
      ...track,
      ...meta.track,
      id,
      identifier: id,
      url: `https://www.youtube.com/watch?v=${id}`,
      isAutoplay: Boolean(track.isAutoplay),
      autoplayGroup: track.autoplayGroup,
      requester: track.requester || meta.track.requester,
      source: "invidious"
    };

    state.current = merged;
    state.startedAt = 0;
    state.positionOffset = Math.max(0, Number(startMs || 0));
    state.paused = false;
    state.transitioning = true;

    const pcm = new PassThrough({ highWaterMark: 1024 * 1024 });
    const resource = createAudioResource(pcm, {
      inputType: StreamType.Raw,
      inlineVolume: true,
      metadata: merged
    });
    resource.volume?.setVolume(Math.max(0.01, Number(state.volume || 70) / 100));
    state.audioResource = resource;
    player.play(resource);

    const playbackUrl = proxiedLatestVersion(base, id, meta.itag);
    const headers = [
      `Referer: ${base}/\\r\\n`,
      `Origin: ${base}\\r\\n`,
      "Accept: */*\\r\\n"
    ].join("");

    const ff = spawn(FFMPEG, [
      "-hide_banner",
      "-loglevel", "warning",
      "-nostdin",
      "-reconnect", "1",
      "-reconnect_streamed", "1",
      "-reconnect_delay_max", "5",
      "-http_persistent", "0",
      "-user_agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140 Safari/537.36",
      "-headers", headers,
      "-i", playbackUrl,
      ...(startMs > 0 ? ["-ss", String(startMs / 1000)] : []),
      "-vn",
      "-f", "s16le",
      "-ar", "48000",
      "-ac", "2",
      "pipe:1"
    ], { stdio: ["ignore", "pipe", "pipe"] });

    manager.streams.set(guildId, { yt: null, ff, pcm, resource, source: "invidious" });

    const result = await new Promise(resolve => {
      let settled = false;
      let got = false;
      let stderr = "";
      let timer;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        try { ff.stdout.unpipe(pcm); } catch {}
        try { ff.kill("SIGKILL"); } catch {}
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
        lastError = new Error(String(reason));
        console.warn(`⚠️ Invidious playback failed on ${base}; trying next instance: ${reason}`);
        resolve(false);
      };

      const success = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        state.transitioning = false;
        state.startedAt = Date.now();
        state.audioResource = resource;
        Promise.resolve(manager.refreshPanel?.(guildId)).catch(() => {});
        console.log(`🚀 Invidious direct playback started: ${merged.title}`);
        console.log(`🌐 Invidious proxy source: ${base} (fresh latest_version/${meta.itag})`);
        resolve(true);
      };

      ff.stderr.on("data", chunk => {
        stderr += chunk.toString();
        if (stderr.length > 6000) stderr = stderr.slice(-6000);
      });
      ff.stdout.on("data", chunk => {
        if (chunk?.length) {
          got = true;
          success();
        }
      });
      ff.stdout.on("error", error => fail(error?.message || error));
      ff.on("error", error => fail(error?.message || error));
      ff.on("close", code => {
        if (!got) fail(`FFmpeg exited ${code}: ${clean(stderr) || "no audio bytes"}`);
      });

      ff.stdout.pipe(pcm);
      timer = setTimeout(() => {
        if (!got) fail(`no PCM audio within ${STARTUP / 1000}s`);
      }, STARTUP);
    });

    if (result) return true;
  }

  console.warn(`⚠️ All Invidious playback routes failed: ${lastError?.message || "unknown error"}`);
  return false;
}

function install(Manager) {
  if (!Manager || Manager.prototype.__deathInvidiousFallbackPatched) return;
  Manager.prototype.__deathInvidiousFallbackPatched = true;

  const originalSearch = Manager.prototype.search;
  Manager.prototype.search = async function(query, requester) {
    const value = typeof query === "string"
      ? query
      : (query?.query || query?.search || query?.name || "");
    const q = this.cleanQuery(value);
    if (!q) return originalSearch.call(this, query, requester);

    try {
      if (this.isYouTubeUrl(q)) {
        const id = ytId(q);
        if (id) {
          const { track } = await metadataOnInstance(INSTANCES[0], id, requester || this.client.user);
          return { type: "track", tracks: [track] };
        }
      } else {
        return await searchInvidious(q, requester || this.client.user);
      }
    } catch (error) {
      console.warn(`⚠️ Invidious search unavailable; continuing to yt-dlp: ${error?.message || error}`);
    }

    return originalSearch.call(this, q, requester);
  };

  const originalStart = Manager.prototype.startTrack;
  Manager.prototype.startTrack = async function(guildId, track, startMs = 0) {
    try {
      if (/youtube\.com|youtu\.be/i.test(track?.url || "")) {
        if (await startInvidious(this, guildId, track, startMs)) return;
      }
    } catch (error) {
      console.warn(`⚠️ Invidious playback exception; continuing to yt-dlp/Piped: ${error?.message || error}`);
    }
    return originalStart.call(this, guildId, track, startMs);
  };

  console.log(`🛟 DEATH Invidious fallback loaded: ${INSTANCES.length} public proxy instances with rotating fresh playback URLs.`);
}

try {
  install(require("./DirectMusicManager"));
} catch (error) {
  console.error("❌ Invidious fallback patch failed to load:", error?.message || error);
}

module.exports = { install };
