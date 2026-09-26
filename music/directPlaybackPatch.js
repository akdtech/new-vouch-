"use strict";

/* DEATH Music 24/7 — stable playback core.
 * Primary: parallel Invidious proxy playback (fresh server-side stream).
 * Secondary: browser-backed yt-dlp PO-token playback.
 * Last resort: SoundCloud when the exact recording exists there.
 * Discord is only switched after real PCM bytes arrive.
 */
const { spawn } = require("node:child_process");
const { PassThrough } = require("node:stream");
const { createAudioResource, StreamType } = require("@discordjs/voice");

const YTDLP = process.env.YTDLP_PATH || "/usr/local/bin/yt-dlp";
const FFMPEG = process.env.FFMPEG_PATH || "/usr/bin/ffmpeg";
const STARTUP_MS = 20000;
const PROVIDER_MS = 5000;
const PCM_BUFFER = 1024 * 1024;

const INVIDIOUS = String(process.env.INVIDIOUS_API_URLS || [
  "https://inv.nadeko.net",
  "https://invidious.nerdvpn.de",
  "https://yt.chocolatemoo53.com",
  "https://invidious.tiekoetter.com",
  "https://invidious.f5.si",
  "https://yewtu.be",
  "https://yt.artemislena.eu",
  "https://invidious.flokinet.to"
].join(",")).split(",").map(v => v.trim().replace(/\/+$/, "")).filter(Boolean).slice(0, 8);

const clean = v => String(v || "").replace(/\s+/g, " ").trim();
const errText = (v, max = 1400) => clean(v).slice(-max);
const ytId = value => String(value || "").match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i)?.[1] || null;
function kill(child) { try { child?.kill("SIGKILL"); } catch {} }
function ignorePipeErrors(stream) { if (!stream || stream.__deathPipeGuard) return; stream.__deathPipeGuard = true; stream.on("error", error => { if (error?.code !== "EPIPE") console.warn(`⚠️ Audio pipe error: ${error?.message || error}`); }); }
function retireStream(stream) { if (!stream) return; try { stream.yt?.stdout?.unpipe?.(); } catch {} try { stream.ff?.stdin?.end?.(); } catch {} try { kill(stream.yt); } catch {} try { kill(stream.ff); } catch {} try { stream.pcm?.end?.(); } catch {} }
function timeout(promise, ms, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out.`)), ms); })]).finally(() => clearTimeout(timer));
}
function resource(state, track, pcm) {
  const r = createAudioResource(pcm, { inputType: StreamType.Raw, inlineVolume: true, metadata: track });
  r.volume?.setVolume(Math.max(0.01, Number(state.volume || 70) / 100));
  state.audioResource = r;
  return r;
}

async function invidiousMeta(base, id) {
  const r = await timeout(fetch(`${base}/api/v1/videos/${encodeURIComponent(id)}?local=true`, {
    headers: { accept: "application/json", "user-agent": "DEATH-Music-24-7/2.0" }, redirect: "follow"
  }), PROVIDER_MS, "Invidious metadata");
  if (!r.ok) throw new Error(`Invidious HTTP ${r.status}`);
  const data = await r.json();
  const formats = [...(data?.adaptiveFormats || []), ...(data?.formatStreams || [])];
  const audio = formats.filter(x => x?.itag && String(x?.type || x?.mimeType || "").toLowerCase().includes("audio"))
    .sort((a, b) => Number(b?.bitrate || 0) - Number(a?.bitrate || 0))[0];
  if (!audio?.itag) throw new Error("no Invidious audio format");
  return {
    title: clean(data?.title), author: clean(data?.author), length: Number(data?.lengthSeconds || 0) * 1000,
    thumbnail: data?.videoThumbnails?.at?.(-1)?.url || null,
    url: `${base}/latest_version?id=${encodeURIComponent(id)}&itag=${encodeURIComponent(audio.itag)}&local=true`
  };
}

async function startInvidious(manager, guildId, originalTrack, startMs, token, handoff = false) {
  const id = ytId(originalTrack?.url) || originalTrack?.id || originalTrack?.identifier;
  if (!id) throw new Error("no YouTube id");
  const state = manager.getState(guildId);
  const player = manager.players.get(guildId) || manager.ensurePlayer(guildId);
  manager.bindPlayerEvents(guildId, player);

  const candidates = INVIDIOUS.map(async base => {
    const meta = await invidiousMeta(base, id);
    const track = { ...originalTrack, title: meta.title || originalTrack.title, author: meta.author || originalTrack.author,
      length: meta.length || originalTrack.length || 0, thumbnail: originalTrack.thumbnail || meta.thumbnail || null, source: "invidious" };
    const ff = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", "-nostdin", "-reconnect", "1", "-reconnect_streamed", "1",
      "-reconnect_delay_max", "3", "-user_agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140 Safari/537.36",
      "-i", meta.url, ...(startMs > 0 ? ["-ss", String(startMs / 1000)] : []), "-vn", "-af", "aresample=48000:async=1:first_pts=0", "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"],
      { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    ff.stderr.on("data", c => { stderr += c.toString(); if (stderr.length > 4000) stderr = stderr.slice(-4000); });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { kill(ff); reject(new Error(`${base}: no audio within ${PROVIDER_MS / 1000}s`)); }, PROVIDER_MS);
      let first = null;
      const fail = e => { clearTimeout(timer); kill(ff); reject(e instanceof Error ? e : new Error(String(e))); };
      ff.stdout.once("data", chunk => { if (!chunk?.length) return fail(new Error(`${base}: empty audio`)); clearTimeout(timer); first = chunk; resolve({ base, ff, first, track }); });
      ff.on("error", fail);
      ff.on("close", code => { if (!first) fail(new Error(`${base}: FFmpeg exited ${code}: ${errText(stderr, 700)}`)); });
    });
  });

  let winner;
  try { winner = await Promise.any(candidates); } catch { throw new Error("No Invidious instance produced playable audio."); }
  candidates.forEach(p => p.catch(() => {}));
  setTimeout(() => candidates.forEach(p => p.then(x => { if (x.ff !== winner.ff) kill(x.ff); }).catch(() => {})), 0);

  if (state.playbackToken !== token) { kill(winner.ff); throw new Error("playback attempt superseded"); }
  const oldStream = manager.streams.get(guildId);
  const pcm = new PassThrough({ highWaterMark: PCM_BUFFER });
  const r = resource(state, winner.track, pcm);
  state.current = winner.track; state.transitioning = false; state.paused = false; state.startedAt = Date.now(); state.positionOffset = Math.max(0, Number(startMs || 0));
  manager.streams.set(guildId, { yt: null, ff: winner.ff, pcm, resource: r, source: "invidious" });
  pcm.write(winner.first); winner.ff.stdout.pipe(pcm); player.play(r);
  if (handoff) retireStream(oldStream);
  Promise.resolve(manager.refreshPanel?.(guildId)).catch(() => {});
  console.log(`🚀 Invidious playback started: ${winner.track.title} via ${winner.base}`);
  return true;
}

async function startYouTube(manager, guildId, track, startMs, token, handoff = false) {
  const state = manager.getState(guildId);
  const player = manager.players.get(guildId) || manager.ensurePlayer(guildId);
  manager.bindPlayerEvents(guildId, player);
  const args = [
    "--no-warnings", "--no-progress", "--no-playlist", "--force-ipv4",
    "--js-runtimes", "deno", "--remote-components", "ejs:github",
    "--extractor-args", "youtube:player_client=web_safari,mweb,web_embedded,tv;fetch_pot=always;use_ad_playback_context=false",
    "--extractor-args", "youtubepot-wpc:browser_path=/usr/bin/chromium",
    "--retries", "1", "--fragment-retries", "1", "--format", "bestaudio/best", "--output", "-", track.url
  ];
  const yt = spawn(YTDLP, args, { stdio: ["ignore", "pipe", "pipe"] });
  const ff = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", "pipe:0", ...(startMs > 0 ? ["-ss", String(startMs / 1000)] : []), "-vn", "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"], { stdio: ["pipe", "pipe", "pipe"] });
  const oldStream = manager.streams.get(guildId);
  const pcm = new PassThrough({ highWaterMark: PCM_BUFFER });
  ignorePipeErrors(ff.stdin);
  ignorePipeErrors(yt.stdout);
  let ytErr = "", ffErr = "";
  const cleanup = () => { kill(yt); kill(ff); try { pcm.destroy(); } catch {} };
  try {
    const first = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`YouTube produced no audio within ${STARTUP_MS / 1000}s. ${errText(ytErr, 900)}`)), STARTUP_MS);
      yt.stderr.on("data", c => { ytErr += c.toString(); if (ytErr.length > 8000) ytErr = ytErr.slice(-8000); });
      ff.stderr.on("data", c => { ffErr += c.toString(); if (ffErr.length > 5000) ffErr = ffErr.slice(-5000); });
      const fail = e => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))); };
      ff.stdout.once("data", c => { if (!c?.length) return fail(new Error("YouTube returned empty audio.")); clearTimeout(timer); resolve(c); });
      yt.on("error", fail); ff.on("error", fail);
      yt.on("close", code => { if (code !== 0) fail(new Error(`yt-dlp exited ${code}: ${errText(ytErr, 1000)}`)); });
      ff.on("close", code => { if (code !== 0) fail(new Error(`FFmpeg exited ${code}: ${errText(ffErr, 800)}`)); });
      yt.stdout.pipe(ff.stdin);
    });
    if (state.playbackToken !== token) { cleanup(); throw new Error("playback attempt superseded"); }
    const r = resource(state, track, pcm);
    state.current = track; state.transitioning = false; state.paused = false; state.startedAt = Date.now(); state.positionOffset = Math.max(0, Number(startMs || 0));
    manager.streams.set(guildId, { yt, ff, pcm, resource: r, source: "youtube" });
    pcm.write(first); ff.stdout.pipe(pcm); player.play(r);
    if (handoff) retireStream(oldStream);
    Promise.resolve(manager.refreshPanel?.(guildId)).catch(() => {});
    console.log(`▶️ YouTube playback started: ${track.title}`);
    return true;
  } catch (e) { cleanup(); throw e; }
}

async function soundCloudResolve(track) {
  const q = clean(`${track?.author || ""} ${track?.title || ""}`);
  const result = await new Promise((resolve, reject) => {
    const child = spawn(YTDLP, ["--no-warnings", "--no-progress", "--flat-playlist", "--playlist-end", "5", "--dump-single-json", `scsearch5:${q}`], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => { kill(child); reject(new Error("SoundCloud search timed out.")); }, 4500);
    child.stdout.on("data", c => { out += c.toString(); if (out.length > 30000) out = out.slice(-30000); });
    child.stderr.on("data", c => { err += c.toString(); if (err.length > 6000) err = err.slice(-6000); });
    child.on("error", e => { clearTimeout(timer); reject(e); });
    child.on("close", code => { clearTimeout(timer); if (code === 0) resolve(out); else reject(new Error(errText(err, 900))); });
  });
  const lines = result.trim().split("\n").filter(Boolean);
  let data = null;
  for (let i = lines.length - 1; i >= 0; i--) { try { data = JSON.parse(lines[i]); break; } catch {} }
  const item = (Array.isArray(data?.entries) ? data.entries : []).find(x => x?.webpage_url || x?.original_url || x?.url);
  if (!item) throw new Error("SoundCloud found no playable result.");
  return { url: item.webpage_url || item.original_url || item.url, title: clean(item.title) || track.title, author: clean(item.uploader || item.channel) || track.author, duration: Number(item.duration || 0) * 1000, thumbnail: item.thumbnail || track.thumbnail || null };
}

async function startSoundCloud(manager, guildId, originalTrack, startMs, token, handoff = false) {
  const found = await soundCloudResolve(originalTrack);
  const state = manager.getState(guildId), player = manager.players.get(guildId) || manager.ensurePlayer(guildId);
  const oldStream = manager.streams.get(guildId);
  const track = { ...originalTrack, ...found, url: found.url, length: found.duration || originalTrack.length || 0, source: "soundcloud" };
  const yt = spawn(YTDLP, ["--no-warnings", "--no-progress", "--no-playlist", "--force-ipv4", "--format", "bestaudio/best", "--output", "-", found.url], { stdio: ["ignore", "pipe", "pipe"] });
  const ff = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", "pipe:0", ...(startMs > 0 ? ["-ss", String(startMs / 1000)] : []), "-vn", "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"], { stdio: ["pipe", "pipe", "pipe"] });
  let err = "";
  ignorePipeErrors(ff.stdin);
  ignorePipeErrors(yt.stdout);
  try {
    const first = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("SoundCloud produced no audio within 5s.")), 5000);
      yt.stderr.on("data", c => { err += c.toString(); if (err.length > 5000) err = err.slice(-5000); });
      const fail = e => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))); };
      ff.stdout.once("data", c => { clearTimeout(timer); resolve(c); }); yt.on("error", fail); ff.on("error", fail); yt.stdout.pipe(ff.stdin);
    });
    if (state.playbackToken !== token) { kill(yt); kill(ff); throw new Error("playback attempt superseded"); }
    const pcm = new PassThrough({ highWaterMark: PCM_BUFFER }), r = resource(state, track, pcm);
    state.current = track; state.transitioning = false; state.paused = false; state.startedAt = Date.now(); state.positionOffset = Math.max(0, Number(startMs || 0));
    manager.streams.set(guildId, { yt, ff, pcm, resource: r, source: "soundcloud" });
    pcm.write(first); ff.stdout.pipe(pcm); player.play(r);
    if (handoff) retireStream(oldStream);
    Promise.resolve(manager.refreshPanel?.(guildId)).catch(() => {});
    console.log(`☁️ SoundCloud playback started: ${track.title}`);
    return true;
  } catch (e) { kill(yt); kill(ff); throw new Error(`${e?.message || e}${err ? ` ${errText(err, 700)}` : ""}`); }
}

function install(Manager) {
  if (!Manager || Manager.prototype.__deathStablePlaybackV6) return;
  Manager.prototype.__deathStablePlaybackV6 = true;
  Manager.prototype.startTrack = async function stableStartTrack(guildId, track, startMs = 0, options = {}) {
    const state = this.getState(guildId), previous = state.current;
    const handoff = options?.handoff !== false;
    const token = Number(state.playbackToken || 0) + 1;
    state.playbackToken = token;
    state.pendingTrack = track;
    state.transitioning = true;
    const failures = [];

    try { await startInvidious(this, guildId, track, startMs, token, handoff); return true; }
    catch (e) { failures.push(`Invidious: ${errText(e?.message || e, 500)}`); }
    try { await startYouTube(this, guildId, track, startMs, token, handoff); return true; }
    catch (e) { failures.push(`YouTube: ${errText(e?.message || e, 900)}`); }
    try { await startSoundCloud(this, guildId, track, startMs, token, handoff); return true; }
    catch (e) { failures.push(`SoundCloud: ${errText(e?.message || e, 600)}`); }

    if (state.playbackToken === token) {
      state.current = previous || null; state.pendingTrack = null; state.transitioning = false;
      if (!handoff) state.audioResource = null;
      Promise.resolve(this.refreshPanel?.(guildId)).catch(() => {});
    }
    throw new Error(`No playable music source was available. ${failures.join(" | ")}`);
  };
  console.log("🎵 DEATH stable playback v6 loaded: browser-backed YouTube PO tokens + proxy-first source handoff + real-PCM validation.");
}
try { install(require("./DirectMusicManager")); } catch (e) { console.error("❌ Stable playback patch failed to load:", e?.message || e); }
module.exports = { install };
