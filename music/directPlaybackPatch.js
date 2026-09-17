"use strict";

/* DEATH direct playback: YouTube first, Piped fallback when Railway is bot-checked. */
const { spawn } = require("node:child_process");
const { PassThrough } = require("node:stream");
const { createAudioResource, StreamType } = require("@discordjs/voice");

const YTDLP = process.env.YTDLP_PATH || "/usr/local/bin/yt-dlp";
const FFMPEG = process.env.FFMPEG_PATH || "/usr/bin/ffmpeg";
const POT_PROVIDER = process.env.YTDLP_POT_PROVIDER_URL || "http://bgutil-pot.railway.internal:4416";
const STARTUP_TIMEOUT_MS = 6000;
const PIPED_TIMEOUT_MS = 9000;
const PCM_BUFFER_BYTES = 1024 * 1024;

// Public Piped API instances. We rotate them because individual instances can
// be rate-limited, offline, or temporarily unable to reach YouTube.
const PIPED_APIS = [
  "https://pipedapi.kavin.rocks",
  "https://pipedapi.adminforge.de",
  "https://pipedapi.reallyaweso.me",
  "https://pipedapi.leptons.xyz",
  "https://pipedapi.drgns.space"
];

function conciseError(text, max = 900) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(-max);
}

function isYoutubeBotBlock(text) {
  const value = String(text || "").toLowerCase();
  return value.includes("sign in to confirm") || value.includes("not a bot") || value.includes("login_required");
}

function videoIdFromUrl(url) {
  const value = String(url || "");
  try {
    const parsed = new URL(value);
    if (parsed.hostname === "youtu.be") return parsed.pathname.slice(1).split("/")[0] || null;
    if (/youtube\.com$/i.test(parsed.hostname) || /\.youtube\.com$/i.test(parsed.hostname)) {
      return parsed.searchParams.get("v") || parsed.pathname.match(/\/shorts\/([^/?]+)/i)?.[1] || parsed.pathname.match(/\/embed\/([^/?]+)/i)?.[1] || null;
    }
  } catch {}
  return null;
}

async function fetchJson(url, timeoutMs = PIPED_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "DEATH-Music-24-7/1.0" },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function pipedSearch(query) {
  const errors = [];
  for (const api of PIPED_APIS) {
    try {
      const data = await fetchJson(`${api}/search?q=${encodeURIComponent(query)}&filter=videos`, PIPED_TIMEOUT_MS);
      const items = Array.isArray(data?.items) ? data.items : [];
      const videos = items.filter(item => item?.type === "stream" && item?.url);
      if (videos.length) return videos;
    } catch (error) {
      errors.push(`${api}: ${error?.message || error}`);
    }
  }
  throw new Error(`Piped search failed: ${errors.join(" | ")}`);
}

async function pipedStream(videoId) {
  const errors = [];
  for (const api of PIPED_APIS) {
    try {
      const data = await fetchJson(`${api}/streams/${encodeURIComponent(videoId)}`, PIPED_TIMEOUT_MS);
      const streams = Array.isArray(data?.audioStreams) ? data.audioStreams : [];
      const usable = streams
        .filter(s => s?.url)
        .sort((a, b) => Number(b?.bitrate || 0) - Number(a?.bitrate || 0));
      if (usable.length) return { api, data, stream: usable[0] };
    } catch (error) {
      errors.push(`${api}: ${error?.message || error}`);
    }
  }
  throw new Error(`Piped stream lookup failed: ${errors.join(" | ")}`);
}

async function playPiped(DirectMusicManager, guildId, track, startMs = 0) {
  const state = DirectMusicManager.prototype.getState ? DirectMusicManager.prototype.getState : null;
  void state;
  const manager = this;
  const player = manager.players.get(guildId) || manager.ensurePlayer(guildId);
  const id = videoIdFromUrl(track?.url);
  if (!id) throw new Error("Piped fallback needs a YouTube video ID.");

  const result = await pipedStream(id);
  const pcm = new PassThrough({ highWaterMark: PCM_BUFFER_BYTES });
  const resource = createAudioResource(pcm, {
    inputType: StreamType.Raw,
    inlineVolume: true,
    metadata: track
  });
  resource.volume?.setVolume(Math.max(0.01, manager.getState(guildId).volume / 100));

  player.play(resource);
  manager.streams.set(guildId, { yt: null, ff: null, pcm, resource, piped: null });
  manager.getState(guildId).audioResource = resource;

  const ff = spawn(FFMPEG, [
    "-hide_banner", "-loglevel", "warning", "-nostdin", "-i", result.stream.url,
    ...(startMs > 0 ? ["-ss", String(startMs / 1000)] : []),
    "-vn", "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"
  ], { stdio: ["ignore", "pipe", "pipe"] });

  manager.streams.set(guildId, { yt: null, ff, pcm, resource, piped: result.stream.url });
  let stderr = "";
  let gotPcm = false;
  let settled = false;
  const finish = (ok, error) => {
    if (settled) return;
    settled = true;
    if (ok) return;
    try { ff.kill("SIGKILL"); } catch {}
    try { pcm.destroy(); } catch {}
    throw error;
  };

  ff.stderr.on("data", chunk => {
    stderr += chunk.toString();
    if (stderr.length > 8000) stderr = stderr.slice(-8000);
  });
  ff.stdout.on("data", chunk => {
    if (chunk?.length) {
      gotPcm = true;
      if (!manager.getState(guildId).startedAt) manager.getState(guildId).startedAt = Date.now();
      manager.getState(guildId).transitioning = false;
      Promise.resolve(manager.refreshPanel(guildId)).catch(() => {});
    }
  });
  ff.stdout.on("error", error => { if (error?.code !== "EPIPE") console.warn("⚠️ Piped FFmpeg stdout:", error?.message || error); });
  pcm.on("error", error => console.warn("⚠️ Piped PCM stream:", error?.message || error));
  ff.on("error", error => console.warn("⚠️ Piped FFmpeg:", error?.message || error));
  ff.on("close", code => {
    if (!gotPcm && !settled) {
      settled = true;
      try { pcm.destroy(); } catch {}
      console.warn(`⚠️ Piped FFmpeg ended without PCM (code ${code}): ${conciseError(stderr, 1200)}`);
      manager.handleTrackEnd(guildId, true).catch(() => {});
    }
  });
  ff.stdout.pipe(pcm);

  const timeout = setTimeout(() => {
    if (gotPcm || settled) return;
    settled = true;
    try { ff.kill("SIGKILL"); } catch {}
    try { pcm.destroy(); } catch {}
  }, STARTUP_TIMEOUT_MS);

  // Wait only for the first PCM byte; after that Discord owns the stream.
  await new Promise((resolve, reject) => {
    const check = () => {
      if (gotPcm) return resolve();
      if (settled) return reject(new Error(`Piped produced no PCM: ${conciseError(stderr, 1200)}`));
      setTimeout(check, 50);
    };
    check();
  }).finally(() => clearTimeout(timeout));

  manager.getState(guildId).transitioning = false;
  manager.getState(guildId).startedAt = manager.getState(guildId).startedAt || Date.now();
  manager.getState(guildId).audioResource = resource;
  Promise.resolve(manager.refreshPanel(guildId)).catch(() => {});
  console.log(`🚀 Piped direct playback started: ${track.title}`);
  console.log(`🌐 Piped source: ${result.api}`);
}

function installDirectPlaybackPatch(DirectMusicManager) {
  if (!DirectMusicManager || DirectMusicManager.prototype.__deathDirectPlaybackPatched) return;
  DirectMusicManager.prototype.__deathDirectPlaybackPatched = true;

  DirectMusicManager.prototype.startTrack = async function fastBufferedStartTrack(guildId, track, startMs = 0) {
    const state = this.getState(guildId);
    const player = this.players.get(guildId) || this.ensurePlayer(guildId);
    this.bindPlayerEvents(guildId, player);

    this.destroyStream(guildId);
    state.current = track;
    state.startedAt = 0;
    state.positionOffset = Math.max(0, Number(startMs || 0));
    state.paused = false;
    state.audioResource = null;
    state.transitioning = true;
    Promise.resolve(this.refreshPanel(guildId)).catch(() => {});

    const clientProfiles = ["web_embedded", "tv", "web_safari", "mweb", "android_vr", "default"];
    const failures = [];

    for (const client of clientProfiles) {
      this.destroyStream(guildId);
      let yt = null;
      let ff = null;
      let pcm = null;
      let resource = null;
      try {
        pcm = new PassThrough({ highWaterMark: PCM_BUFFER_BYTES });
        resource = createAudioResource(pcm, {
          inputType: StreamType.Raw,
          inlineVolume: true,
          metadata: track
        });
        resource.volume?.setVolume(Math.max(0.01, state.volume / 100));
        state.audioResource = resource;
        player.play(resource);
        this.streams.set(guildId, { yt: null, ff: null, pcm, resource });

        const result = await new Promise((resolve, reject) => {
          const ytArgs = [
            "--no-warnings", "--no-progress", "--no-playlist", "--force-ipv4",
            "--js-runtimes", "deno", "--remote-components", "ejs:github",
            "--extractor-args", `youtube:player_client=${client};youtubepot-bgutilhttp:base_url=${POT_PROVIDER}`,
            "--retries", "1", "--fragment-retries", "1", "--retry-sleep", "linear=1::2",
            "--format", "bestaudio/best", "--output", "-", track.url
          ];

          yt = spawn(YTDLP, ytArgs, { stdio: ["ignore", "pipe", "pipe"] });
          ff = spawn(FFMPEG, [
            "-hide_banner", "-loglevel", "warning", "-nostdin", "-i", "pipe:0",
            ...(startMs > 0 ? ["-ss", String(startMs / 1000)] : []),
            "-vn", "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"
          ], { stdio: ["pipe", "pipe", "pipe"] });

          this.streams.set(guildId, { yt, ff, pcm, resource });
          let ytStderr = "";
          let ffStderr = "";
          let settled = false;
          let gotYtBytes = false;
          let gotPcmBytes = false;
          let firstBytesTimer = null;
          const cleanup = () => {
            if (firstBytesTimer) clearTimeout(firstBytesTimer);
            try { yt?.stdout?.unpipe(ff?.stdin); } catch {}
            try { ff?.stdout?.unpipe(pcm); } catch {}
            try { yt?.kill("SIGKILL"); } catch {}
            try { ff?.kill("SIGKILL"); } catch {}
          };
          const fail = error => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
          };
          const success = () => {
            if (settled) return;
            settled = true;
            if (firstBytesTimer) clearTimeout(firstBytesTimer);
            resolve({ yt, ff, pcm, resource });
          };
          yt.stderr.on("data", chunk => { ytStderr += chunk.toString(); if (ytStderr.length > 10000) ytStderr = ytStderr.slice(-10000); });
          ff.stderr.on("data", chunk => { ffStderr += chunk.toString(); if (ffStderr.length > 10000) ffStderr = ffStderr.slice(-10000); });
          yt.stdout.on("data", chunk => { if (chunk?.length) gotYtBytes = true; });
          ff.stdout.on("data", chunk => { if (chunk?.length) { gotPcmBytes = true; if (!settled) success(); } });
          ff.stdin.on("error", error => { if (error?.code !== "EPIPE") console.warn(`⚠️ FFmpeg stdin error (${client}): ${error?.message || error}`); });
          yt.stdout.on("error", error => { if (error?.code !== "EPIPE") fail(error); });
          ff.stdout.on("error", error => { if (error?.code !== "EPIPE") fail(error); });
          pcm.on("error", error => fail(error));
          yt.on("error", error => fail(error));
          ff.on("error", error => fail(error));
          yt.stdout.pipe(ff.stdin);
          ff.stdout.pipe(pcm);
          yt.on("close", code => {
            if (code !== 0 && !gotYtBytes && !gotPcmBytes) return fail(new Error(`yt-dlp ${client} exited with code ${code}: ${conciseError(ytStderr, 1600)}`.trim()));
          });
          ff.on("close", code => { if (!gotPcmBytes) return fail(new Error(`FFmpeg ${client} exited with code ${code}: ${conciseError(ffStderr, 1200)}`.trim())); });
          firstBytesTimer = setTimeout(() => { if (!gotPcmBytes) fail(new Error(`No PCM audio received from FFmpeg client ${client} within ${STARTUP_TIMEOUT_MS / 1000}s. yt-dlp=${conciseError(ytStderr, 1000) || "none"}; ffmpeg=${conciseError(ffStderr, 500) || "none"}`)); }, STARTUP_TIMEOUT_MS);
        });

        const active = this.streams.get(guildId);
        if (active) active.yt = result.yt;
        state.transitioning = false;
        state.startedAt = Date.now();
        state.positionOffset = Math.max(0, Number(startMs || 0));
        state.audioResource = result.resource;
        Promise.resolve(this.refreshPanel(guildId)).catch(() => {});
        console.log(`▶️ Buffered direct playback started: ${track.title}`);
        console.log(`🔊 Direct audio resource status: ${player.state.status}`);
        console.log(`✅ Direct yt-dlp stream client: ${client}`);
        return;
      } catch (error) {
        const message = error?.message || String(error);
        failures.push(`${client}: ${conciseError(message, 1800)}`);
        if (isYoutubeBotBlock(message)) console.warn(`🚧 YouTube bot check on ${client}; trying next client.`);
        else console.warn(`⚠️ Direct stream client ${client} failed: ${conciseError(message, 1800)}`);
        try { player.stop(true); } catch {}
        try { pcm?.destroy(); } catch {}
        this.destroyStream(guildId);
        state.audioResource = null;
      }
    }

    // All direct YouTube clients were blocked. Try the alternate Piped path
    // before reporting a playback failure to Discord.
    try {
      await playPiped.call(this, DirectMusicManager, guildId, track, startMs);
      return;
    } catch (error) {
      failures.push(`piped: ${conciseError(error?.message || error, 1800)}`);
      console.warn(`❌ Piped fallback failed: ${conciseError(error?.message || error, 1800)}`);
    }

    state.transitioning = false;
    state.audioResource = null;
    state.current = null;
    state.startedAt = 0;
    state.positionOffset = 0;
    Promise.resolve(this.refreshPanel(guildId)).catch(() => {});
    throw new Error(`No playable music stream was produced. ${failures.join(" || ")}`);
  };

  // Search fallback: if yt-dlp search itself is blocked by YouTube, use Piped
  // to resolve the query into a normal YouTube URL so playback can continue.
  const originalSearch = DirectMusicManager.prototype.search;
  DirectMusicManager.prototype.search = async function resilientSearch(query, requester) {
    try {
      return await originalSearch.call(this, query, requester);
    } catch (error) {
      const raw = error?.message || String(error);
      if (/timed out|sign in to confirm|not a bot|login_required|unable to download|extracting url/i.test(raw)) {
        const clean = this.cleanQuery(query);
        console.warn(`🛟 YouTube search unavailable; trying Piped search for: ${clean}`);
        const videos = await pipedSearch(clean);
        const item = videos[0];
        const id = videoIdFromUrl(item?.url);
        if (!id) throw error;
        return {
          type: "track",
          tracks: [{
            identifier: id,
            id,
            url: `https://www.youtube.com/watch?v=${id}`,
            title: item?.title || "Unknown track",
            author: item?.uploaderName || item?.uploader || "Unknown artist",
            length: Number(item?.duration || 0) * 1000,
            requester: requester || this.client.user,
            thumbnail: item?.thumbnailUrl || item?.thumbnail || null,
            isAutoplay: false
          }]
        };
      }
      throw error;
    }
  };

  console.log("🛟 DEATH Piped fallback loaded: rotated Piped search/streams + YouTube/PO-token fallback.");
}

try {
  const DirectMusicManager = require("./DirectMusicManager");
  installDirectPlaybackPatch(DirectMusicManager);
} catch (error) {
  console.error("❌ Direct playback patch failed to load:", error?.message || error);
}

module.exports = { installDirectPlaybackPatch };
