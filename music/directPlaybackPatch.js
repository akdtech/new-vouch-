"use strict";

/* DEATH Music 24/7 — production direct playback engine.
 * Fast path: YouTube/yt-dlp with current client fallback + BgUtils PO tokens.
 * Recovery path: Piped stream proxies, then SoundCloud.
 * Search/autoplay/panel logic remains owned by the existing music manager.
 */
const { spawn } = require("node:child_process");
const { PassThrough } = require("node:stream");
const { createAudioResource, StreamType } = require("@discordjs/voice");

const YTDLP = process.env.YTDLP_PATH || "/usr/local/bin/yt-dlp";
const FFMPEG = process.env.FFMPEG_PATH || "/usr/bin/ffmpeg";
const POT_PROVIDER = process.env.YTDLP_POT_PROVIDER_URL || "http://bgutil-pot.railway.internal:4416";

const STARTUP_TIMEOUT_MS = 6000;
const FALLBACK_TIMEOUT_MS = 5000;
const PCM_BUFFER_BYTES = 1024 * 1024;
const PIPED_TIMEOUT_MS = 4500;

const PIPED_INSTANCES = String(process.env.PIPED_API_URLS || [
  "https://pipedapi.ducks.party",
  "https://api.piped.private.coffee"
].join(",")).split(",").map(v => v.trim().replace(/\/+$/, "")).filter(Boolean);

const clean = v => String(v || "").replace(/\s+/g, " ").trim();
const errText = (v, max = 1600) => clean(v).slice(-max);

function kill(child) {
  try { child?.kill("SIGKILL"); } catch {}
}

function destroyResource(player, pcm) {
  try { player?.stop(true); } catch {}
  try { pcm?.destroy(); } catch {}
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out.`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function ytId(value) {
  return String(value || "").match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i)?.[1] || null;
}

function makeResource(state, track, pcm) {
  const resource = createAudioResource(pcm, {
    inputType: StreamType.Raw,
    inlineVolume: true,
    metadata: track
  });
  resource.volume?.setVolume(Math.max(0.01, Number(state.volume || 70) / 100));
  state.audioResource = resource;
  return resource;
}

async function startYouTube(manager, guildId, track, startMs = 0) {
  const state = manager.getState(guildId);
  const player = manager.players.get(guildId) || manager.ensurePlayer(guildId);
  manager.bindPlayerEvents(guildId, player);
  manager.destroyStream(guildId);

  const pcm = new PassThrough({ highWaterMark: PCM_BUFFER_BYTES });
  const resource = makeResource(state, track, pcm);
  player.play(resource);

  // One yt-dlp process instead of seven serial client attempts. Current
  // yt-dlp supports multiple player clients and provider-driven PO tokens.
  const extractor = [
    "youtube:player_client=android_vr,web_safari,mweb,web_embedded,tv",
    "fetch_pot=always",
    "use_ad_playback_context=false"
  ].join(";");

  const ytArgs = [
    "--no-warnings", "--no-progress", "--no-playlist", "--force-ipv4",
    "--js-runtimes", "deno",
    "--remote-components", "ejs:github",
    "--extractor-args", extractor,
    "--extractor-args", `youtubepot-bgutilhttp:base_url=${POT_PROVIDER}`,
    "--retries", "1", "--fragment-retries", "1",
    "--retry-sleep", "linear=1::2",
    "--format", "bestaudio/best",
    "--output", "-", track.url
  ];

  const yt = spawn(YTDLP, ytArgs, { stdio: ["ignore", "pipe", "pipe"] });
  const ff = spawn(FFMPEG, [
    "-hide_banner", "-loglevel", "warning", "-nostdin",
    "-i", "pipe:0",
    ...(startMs > 0 ? ["-ss", String(startMs / 1000)] : []),
    "-vn", "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"
  ], { stdio: ["pipe", "pipe", "pipe"] });

  manager.streams.set(guildId, { yt, ff, pcm, resource, source: "youtube" });

  let ytErr = "", ffErr = "", got = false;
  try {
    await new Promise((resolve, reject) => {
      let done = false;
      let timer;
      const fail = error => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(error);
      };
      const success = value => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
      };
      timer = setTimeout(() => fail(new Error(
        `YouTube produced no audio within ${STARTUP_TIMEOUT_MS / 1000}s. ${errText(ytErr, 900)}`
      )), STARTUP_TIMEOUT_MS);

      yt.stderr.on("data", c => {
        ytErr += c.toString();
        if (ytErr.length > 10000) ytErr = ytErr.slice(-10000);
      });
      ff.stderr.on("data", c => {
        ffErr += c.toString();
        if (ffErr.length > 10000) ffErr = ffErr.slice(-10000);
      });
      ff.stdout.on("data", chunk => {
        if (chunk?.length) {
          got = true;
          success(true);
        }
      });

      yt.stdout.on("error", e => { if (e?.code !== "EPIPE") fail(e); });
      ff.stdin.on("error", e => { if (e?.code !== "EPIPE") fail(e); });
      ff.stdout.on("error", e => { if (e?.code !== "EPIPE") fail(e); });
      yt.on("error", fail);
      ff.on("error", fail);
      yt.on("close", code => {
        if (!got && code !== 0) fail(new Error(`yt-dlp exited ${code}: ${errText(ytErr, 1400)}`));
      });
      ff.on("close", code => {
        if (!got && code !== 0) fail(new Error(`FFmpeg exited ${code}: ${errText(ffErr, 1200)}`));
      });

      yt.stdout.pipe(ff.stdin);
      ff.stdout.pipe(pcm);
    });

    state.transitioning = false;
    state.paused = false;
    state.startedAt = Date.now();
    state.positionOffset = Math.max(0, Number(startMs || 0));
    state.audioResource = resource;
    Promise.resolve(manager.refreshPanel?.(guildId)).catch(() => {});
    console.log(`▶️ Direct YouTube playback started: ${track.title}`);
    console.log("✅ YouTube clients: android_vr, web_safari, mweb, web_embedded, tv");
    return true;
  } catch (error) {
    kill(yt);
    kill(ff);
    destroyResource(player, pcm);
    manager.destroyStream(guildId);
    state.audioResource = null;
    state.transitioning = false;
    throw error;
  }
}

async function pipedJson(url) {
  const response = await withTimeout(fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "DEATH-Music-24-7/1.0"
    },
    redirect: "follow"
  }), PIPED_TIMEOUT_MS, "Piped request");

  if (!response.ok) throw new Error(`Piped HTTP ${response.status}`);
  return response.json();
}

function choosePipedAudio(data) {
  const audio = Array.isArray(data?.audioStreams) ? data.audioStreams
    .filter(x => x?.url && !x?.videoOnly)
    .sort((a, b) => Number(b?.bitrate || 0) - Number(a?.bitrate || 0))[0] : null;
  if (audio?.url) return audio.url;

  const mixed = Array.isArray(data?.videoStreams) ? data.videoStreams
    .filter(x => x?.url && !x?.videoOnly && String(x?.mimeType || "").toLowerCase().includes("audio"))
    .sort((a, b) => Number(b?.bitrate || 0) - Number(a?.bitrate || 0))[0] : null;
  return mixed?.url || null;
}

async function startPiped(manager, guildId, originalTrack, startMs = 0) {
  const id = ytId(originalTrack?.url) || originalTrack?.id || originalTrack?.identifier;
  if (!id) throw new Error("Piped fallback requires a YouTube video ID.");

  const state = manager.getState(guildId);
  const player = manager.players.get(guildId) || manager.ensurePlayer(guildId);
  manager.bindPlayerEvents(guildId, player);

  const attempts = PIPED_INSTANCES.map(async base => {
    const data = await pipedJson(`${base}/streams/${encodeURIComponent(id)}`);
    const streamUrl = choosePipedAudio(data);
    if (!streamUrl) throw new Error(`${base} returned no audio stream.`);
    return { base, streamUrl, data };
  });

  let picked;
  try {
    picked = await Promise.any(attempts);
  } catch {
    throw new Error("Piped fallback returned no playable audio stream.");
  }

  manager.destroyStream(guildId);
  const duration = Number(picked.data?.duration || 0);
  const track = {
    ...originalTrack,
    title: clean(picked.data?.title) || originalTrack.title,
    author: clean(picked.data?.uploader) || originalTrack.author,
    length: duration > 0 ? duration * 1000 : (originalTrack.length || 0),
    thumbnail: originalTrack.thumbnail || picked.data?.thumbnailUrl || null,
    source: "piped"
  };

  state.current = track;
  state.transitioning = true;
  const pcm = new PassThrough({ highWaterMark: PCM_BUFFER_BYTES });
  const resource = makeResource(state, track, pcm);
  player.play(resource);

  const ff = spawn(FFMPEG, [
    "-hide_banner", "-loglevel", "warning", "-nostdin",
    "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5",
    "-user_agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140 Safari/537.36",
    "-i", picked.streamUrl,
    ...(startMs > 0 ? ["-ss", String(startMs / 1000)] : []),
    "-vn", "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"
  ], { stdio: ["ignore", "pipe", "pipe"] });

  manager.streams.set(guildId, { yt: null, ff, pcm, resource, source: "piped" });

  let got = false, stderr = "";
  try {
    await new Promise((resolve, reject) => {
      let done = false;
      let timer = setTimeout(() => {
        if (done) return;
        done = true;
        reject(new Error(`Piped produced no audio within ${PIPED_TIMEOUT_MS / 1000}s.`));
      }, PIPED_TIMEOUT_MS);
      const fail = error => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(error);
      };
      const success = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };

      ff.stderr.on("data", c => {
        stderr += c.toString();
        if (stderr.length > 6000) stderr = stderr.slice(-6000);
      });
      ff.stdout.on("data", c => {
        if (c?.length) {
          got = true;
          success();
        }
      });
      ff.stdout.on("error", e => { if (e?.code !== "EPIPE") fail(e); });
      ff.on("error", fail);
      ff.on("close", code => {
        if (!got && code !== 0) fail(new Error(`Piped FFmpeg exited ${code}: ${errText(stderr, 1000)}`));
      });
      ff.stdout.pipe(pcm);
    });

    state.transitioning = false;
    state.paused = false;
    state.startedAt = Date.now();
    state.positionOffset = Math.max(0, Number(startMs || 0));
    Promise.resolve(manager.refreshPanel?.(guildId)).catch(() => {});
    console.log(`🚀 Piped direct playback started: ${track.title} via ${picked.base}`);
    return true;
  } catch (error) {
    kill(ff);
    destroyResource(player, pcm);
    manager.destroyStream(guildId);
    state.audioResource = null;
    state.transitioning = false;
    throw error;
  }
}

async function soundCloudResolve(track) {
  const q = clean(`${track?.author || ""} ${track?.title || ""}`);
  if (!q) throw new Error("SoundCloud fallback has no search text.");

  const result = await new Promise((resolve, reject) => {
    const child = spawn(YTDLP, [
      "--no-warnings", "--no-progress", "--flat-playlist",
      "--playlist-end", "5", "--dump-single-json", `scsearch5:${q}`
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "", stderr = "";
    const timer = setTimeout(() => { kill(child); reject(new Error("SoundCloud search timed out.")); }, FALLBACK_TIMEOUT_MS);
    child.stdout.on("data", c => { stdout += c.toString(); if (stdout.length > 20000) stdout = stdout.slice(-20000); });
    child.stderr.on("data", c => { stderr += c.toString(); if (stderr.length > 8000) stderr = stderr.slice(-8000); });
    child.on("error", e => { clearTimeout(timer); reject(e); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`SoundCloud search failed: ${errText(stderr, 1200)}`));
    });
  });

  const lines = result.stdout.trim().split("\n").filter(Boolean);
  let data = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    try { data = JSON.parse(lines[i]); break; } catch {}
  }
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  const item = entries.find(x => x?.webpage_url || x?.original_url || x?.url);
  if (!item) throw new Error(`SoundCloud found no playable result for ${q}.`);

  return {
    url: item.webpage_url || item.original_url || item.url,
    title: clean(item.title) || track.title,
    author: clean(item.uploader || item.channel) || track.author,
    duration: Number(item.duration || 0) * 1000,
    thumbnail: item.thumbnail || track.thumbnail || null
  };
}

async function startSoundCloud(manager, guildId, originalTrack, startMs = 0) {
  const found = await soundCloudResolve(originalTrack);
  const state = manager.getState(guildId);
  const player = manager.players.get(guildId) || manager.ensurePlayer(guildId);
  manager.bindPlayerEvents(guildId, player);
  manager.destroyStream(guildId);

  const track = {
    ...originalTrack,
    title: found.title,
    author: found.author,
    url: found.url,
    length: found.duration || originalTrack.length || 0,
    thumbnail: found.thumbnail || originalTrack.thumbnail || null,
    source: "soundcloud"
  };

  state.current = track;
  state.transitioning = true;
  const pcm = new PassThrough({ highWaterMark: PCM_BUFFER_BYTES });
  const resource = makeResource(state, track, pcm);
  player.play(resource);

  const yt = spawn(YTDLP, [
    "--no-warnings", "--no-progress", "--no-playlist", "--force-ipv4",
    "--format", "bestaudio/best", "--output", "-", found.url
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const ff = spawn(FFMPEG, [
    "-hide_banner", "-loglevel", "warning", "-nostdin", "-i", "pipe:0",
    ...(startMs > 0 ? ["-ss", String(startMs / 1000)] : []),
    "-vn", "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"
  ], { stdio: ["pipe", "pipe", "pipe"] });

  manager.streams.set(guildId, { yt, ff, pcm, resource, source: "soundcloud" });

  let got = false, ys = "", fs = "";
  try {
    await new Promise((resolve, reject) => {
      let done = false;
      let timer = setTimeout(() => reject(new Error(`SoundCloud produced no audio within ${FALLBACK_TIMEOUT_MS / 1000}s. ${errText(ys, 900)}`)), FALLBACK_TIMEOUT_MS);
      const fail = error => { if (done) return; done = true; clearTimeout(timer); reject(error); };
      const success = () => { if (done) return; done = true; clearTimeout(timer); resolve(); };

      yt.stderr.on("data", c => { ys += c.toString(); if (ys.length > 7000) ys = ys.slice(-7000); });
      ff.stderr.on("data", c => { fs += c.toString(); if (fs.length > 7000) fs = fs.slice(-7000); });
      ff.stdout.on("data", c => { if (c?.length) { got = true; success(); } });
      yt.stdout.on("error", e => { if (e?.code !== "EPIPE") fail(e); });
      ff.stdin.on("error", e => { if (e?.code !== "EPIPE") fail(e); });
      ff.stdout.on("error", e => { if (e?.code !== "EPIPE") fail(e); });
      yt.on("error", fail); ff.on("error", fail);
      yt.on("close", code => { if (!got && code !== 0) fail(new Error(`SoundCloud yt-dlp exited ${code}: ${errText(ys, 1200)}`)); });
      ff.on("close", code => { if (!got && code !== 0) fail(new Error(`SoundCloud FFmpeg exited ${code}: ${errText(fs, 1000)}`)); });
      yt.stdout.pipe(ff.stdin); ff.stdout.pipe(pcm);
    });

    state.transitioning = false;
    state.paused = false;
    state.startedAt = Date.now();
    state.audioResource = resource;
    Promise.resolve(manager.refreshPanel?.(guildId)).catch(() => {});
    console.log(`☁️ SoundCloud fallback playback started: ${track.title}`);
    return true;
  } catch (error) {
    kill(yt); kill(ff);
    destroyResource(player, pcm);
    manager.destroyStream(guildId);
    state.audioResource = null;
    state.transitioning = false;
    throw error;
  }
}

function install(Manager) {
  if (!Manager) return;
  if (Manager.prototype.__deathDirectPlaybackPatched) return;
  Manager.prototype.__deathDirectPlaybackPatched = true;

  const startTrack = async function deathStartTrack(guildId, track, startMs = 0) {
    const state = this.getState(guildId);
    state.current = track;
    state.transitioning = true;
    const failures = [];

    if (/youtube\.com|youtu\.be/i.test(track?.url || "")) {
      try {
        await startYouTube(this, guildId, track, startMs);
        return;
      } catch (error) {
        failures.push(`YouTube: ${errText(error?.message || error, 1000)}`);
        console.warn(`⚠️ YouTube direct path failed: ${errText(error?.message || error, 1000)}`);
      }

      try {
        await startPiped(this, guildId, track, startMs);
        return;
      } catch (error) {
        failures.push(`Piped: ${errText(error?.message || error, 700)}`);
        console.warn(`⚠️ Piped fallback failed: ${errText(error?.message || error, 700)}`);
      }

      try {
        await startSoundCloud(this, guildId, track, startMs);
        return;
      } catch (error) {
        failures.push(`SoundCloud: ${errText(error?.message || error, 700)}`);
        console.warn(`⚠️ SoundCloud fallback failed: ${errText(error?.message || error, 700)}`);
      }
    } else {
      try {
        await startSoundCloud(this, guildId, track, startMs);
        return;
      } catch (error) {
        failures.push(`SoundCloud: ${errText(error?.message || error, 700)}`);
      }
    }

    state.transitioning = false;
    state.audioResource = null;
    throw new Error(`No playable music source was available. ${failures.join(" | ")}`);
  };

  Manager.prototype.startTrack = startTrack;

  // directInvidiousFallbackPatch is preloaded after this file. Re-assert our
  // fast engine after all preload modules initialize so the old 5-instance
  // Invidious playback wrapper cannot add a 30–50s delay. Invidious search
  // remains available through that patch.
  setImmediate(() => {
    Manager.prototype.startTrack = startTrack;
  });

  console.log("🎵 DEATH direct playback v5 loaded: fast multi-client YouTube + Piped + SoundCloud recovery.");
}

try { install(require("./DirectMusicManager")); }
catch (e) { console.error("❌ Direct playback patch failed to load:", e?.message || e); }
module.exports = { install };
