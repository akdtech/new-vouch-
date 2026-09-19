"use strict";

/* DEATH Piped playback: direct audio-stream fallback before yt-dlp. */
const MusicManager = require("./DirectMusicManager");
const { spawn } = require("node:child_process");
const { PassThrough } = require("node:stream");
const { createAudioResource, StreamType } = require("@discordjs/voice");

const FFMPEG = process.env.FFMPEG_PATH || "/usr/bin/ffmpeg";
const PIPED = String(process.env.PIPED_API_URLS || [
  "https://pipedapi.ducks.party",
  "https://api.piped.private.coffee",
  "https://api.piped.projectsegfau.lt",
  "https://pipedapi.in.projectsegfau.lt",
  "https://pipedapi.eu.projectsegfau.lt",
  "https://pipedapi.qwik.space",
  "https://yapi.vyper.me",
  "https://api.piped.minionflo.net",
  "https://nuv3d-7iaaa-aaaan-qahma-cai.ic0.app"
].join(",")).split(",").map(v => v.trim().replace(/\/+$/, "")).filter(Boolean);

const clean = v => String(v || "").replace(/\s+/g, " ").trim();
const kill = child => { try { child?.kill("SIGKILL"); } catch {} };
const ytId = value => String(value || "").match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i)?.[1] || null;

async function requestJson(url, ms = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "DEATH-Music-24-7/3.0" },
      signal: controller.signal,
      redirect: "follow"
    });
    if (!response.ok) throw new Error("HTTP " + response.status);
    return await response.json();
  } finally { clearTimeout(timer); }
}

function retire(stream) {
  if (!stream) return;
  try { stream.yt?.stdout?.unpipe?.(); } catch {}
  try { stream.ff?.stdin?.end?.(); } catch {}
  kill(stream.yt);
  kill(stream.ff);
  try { stream.pcm?.destroy?.(); } catch {}
}

async function getPipedStream(id) {
  const jobs = PIPED.map(async base => {
    const data = await requestJson(`${base}/streams/${encodeURIComponent(id)}`);
    const audio = (Array.isArray(data?.audioStreams) ? data.audioStreams : [])
      .filter(x => x?.url)
      .sort((a, b) => Number(b?.bitrate || 0) - Number(a?.bitrate || 0))[0];
    const streamUrl = audio?.url || data?.hls;
    if (!streamUrl) throw new Error("no audio/HLS stream");
    return {
      base,
      url: streamUrl,
      title: clean(data?.title),
      author: clean(data?.uploader) || clean(data?.uploaderName),
      length: Number(data?.duration || 0) * 1000,
      thumbnail: data?.thumbnailUrl || null
    };
  });
  return Promise.any(jobs);
}

async function startPiped(manager, guildId, track, startMs, token, handoff) {
  const id = ytId(track?.url) || track?.id || track?.identifier;
  if (!id) throw new Error("no YouTube id");
  const state = manager.getState(guildId);
  const player = manager.players.get(guildId) || manager.ensurePlayer(guildId);
  manager.bindPlayerEvents(guildId, player);

  const winner = await getPipedStream(id);
  if (state.playbackToken !== token) throw new Error("playback attempt superseded");

  const ff = spawn(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "3",
    "-i", winner.url,
    ...(startMs > 0 ? ["-ss", String(startMs / 1000)] : []),
    "-vn", "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"
  ], { stdio: ["ignore", "pipe", "pipe"] });

  let stderr = "";
  ff.stderr.on("data", c => { stderr += c.toString(); if (stderr.length > 3000) stderr = stderr.slice(-3000); });

  const first = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { kill(ff); reject(new Error("Piped produced no audio within 5s.")); }, 5000);
    const fail = e => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))); };
    ff.stdout.once("data", c => {
      if (!c?.length) return fail(new Error("Piped returned empty audio."));
      clearTimeout(timer);
      resolve(c);
    });
    ff.on("error", fail);
    ff.on("close", code => {
      if (!ff.stdout.readableEnded && code !== 0) fail(new Error("Piped FFmpeg exited " + code + ": " + clean(stderr).slice(-600)));
    });
  });

  if (state.playbackToken !== token) {
    kill(ff);
    throw new Error("playback attempt superseded");
  }

  const oldStream = manager.streams.get(guildId);
  const pcm = new PassThrough({ highWaterMark: 1024 * 1024 });
  const resource = createAudioResource(pcm, {
    inputType: StreamType.Raw,
    inlineVolume: true,
    metadata: {
      ...track,
      title: winner.title || track.title,
      author: winner.author || track.author,
      length: winner.length || track.length || 0,
      thumbnail: track.thumbnail || winner.thumbnail || null,
      source: "piped"
    }
  });
  resource.volume?.setVolume(Math.max(0.01, Number(state.volume || 70) / 100));

  state.current = resource.metadata;
  state.pendingTrack = null;
  state.transitioning = false;
  state.paused = false;
  state.startedAt = Date.now();
  state.positionOffset = Math.max(0, Number(startMs || 0));
  state.audioResource = resource;
  manager.streams.set(guildId, { yt: null, ff, pcm, resource, source: "piped" });

  pcm.write(first);
  ff.stdout.pipe(pcm);
  player.play(resource);
  if (handoff) retire(oldStream);

  Promise.resolve(manager.updateVoiceStatus?.(guildId, "🎵 " + manager.getTrackTitle(resource.metadata))).catch(() => {});
  Promise.resolve(manager.refreshPanel?.(guildId)).catch(() => {});
  console.log(`🚀 Piped playback started: ${resource.metadata.title} via ${winner.base}`);
  return true;
}

if (!MusicManager.prototype.__deathPipedPlaybackPatched) {
  MusicManager.prototype.__deathPipedPlaybackPatched = true;
  const originalStartTrack = MusicManager.prototype.startTrack;

  MusicManager.prototype.startTrack = async function deathPipedStartTrack(guildId, track, startMs = 0, options = {}) {
    const state = this.getState(guildId);
    const handoff = options?.handoff !== false;
    const token = Number(state.playbackToken || 0) + 1;
    state.playbackToken = token;
    const previous = state.current;
    state.pendingTrack = track;
    state.transitioning = true;

    try {
      await startPiped(this, guildId, track, startMs, token, handoff);
      return true;
    } catch (error) {
      if (state.playbackToken !== token) throw error;
      console.warn(`⚠️ Piped playback failed; using stable engine: ${error?.message || error}`);
      // The stable engine owns its own fresh playback token and preserves the
      // current resource during handoff.
      try {
        return await originalStartTrack.call(this, guildId, track, startMs, options);
      } catch (fallbackError) {
        state.current = previous || null;
        state.pendingTrack = null;
        state.transitioning = false;
        throw fallbackError;
      }
    }
  };

  console.log(`🚀 DEATH Piped playback recovery loaded: ${PIPED.length} parallel audio routes.`);
}

module.exports = { getPipedStream };
