"use strict";

/* DEATH Music 24/7 — direct playback engine.
 * YouTube is attempted with current yt-dlp clients + BgUtils POT.
 * If Railway's YouTube egress is blocked, SoundCloud is used as the
 * emergency audio source so /play and autoplay do not become dead ends.
 */
const { spawn } = require("node:child_process");
const { PassThrough } = require("node:stream");
const { createAudioResource, StreamType } = require("@discordjs/voice");

const YTDLP = process.env.YTDLP_PATH || "/usr/local/bin/yt-dlp";
const FFMPEG = process.env.FFMPEG_PATH || "/usr/bin/ffmpeg";
const POT_PROVIDER = process.env.YTDLP_POT_PROVIDER_URL || "http://bgutil-pot.railway.internal:4416";
const STARTUP_TIMEOUT_MS = 7000;
const PCM_BUFFER_BYTES = 1024 * 1024;

function clean(v) { return String(v || "").replace(/\s+/g, " ").trim(); }
function errText(v, max = 1800) { return clean(v).slice(-max); }
function isBotBlock(v) {
  const s = String(v || "").toLowerCase();
  return s.includes("sign in to confirm") || s.includes("not a bot") || s.includes("login_required");
}

function spawnYt(args, timeoutMs = STARTUP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error(`yt-dlp timed out. ${errText(stderr, 1200)}`));
    }, timeoutMs);
    child.stdout.on("data", c => { stdout += c.toString(); if (stdout.length > 20000) stdout = stdout.slice(-20000); });
    child.stderr.on("data", c => { stderr += c.toString(); if (stderr.length > 12000) stderr = stderr.slice(-12000); });
    child.on("error", e => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
    child.on("close", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ child, stdout, stderr });
      else reject(new Error(`yt-dlp exited ${code}: ${errText(stderr, 1600)}`));
    });
  });
}

async function soundCloudResolve(track) {
  const q = clean(`${track?.author || ""} ${track?.title || ""}`);
  if (!q) throw new Error("SoundCloud fallback has no search text.");
  const result = await spawnYt([
    "--no-warnings", "--no-progress", "--flat-playlist", "--playlist-end", "5",
    "--dump-single-json", `scsearch5:${q}`
  ], 12000);
  let data;
  try { data = JSON.parse(result.stdout.trim().split("\n").filter(Boolean).at(-1)); }
  catch { throw new Error("SoundCloud search returned invalid JSON."); }
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  const item = entries.find(x => x?.webpage_url || x?.url || x?.original_url);
  if (!item) throw new Error(`SoundCloud found no playable result for ${q}.`);
  return {
    url: item.webpage_url || item.original_url || item.url,
    title: clean(item.title) || track.title,
    author: clean(item.uploader || item.channel) || track.author,
    duration: Number(item.duration || 0) * 1000,
    thumbnail: item.thumbnail || track.thumbnail || null
  };
}

async function startYtStream(manager, guildId, track, startMs) {
  const state = manager.getState(guildId);
  const player = manager.players.get(guildId) || manager.ensurePlayer(guildId);
  manager.bindPlayerEvents(guildId, player);
  const profiles = ["mweb", "web_music", "web_embedded", "android_vr", "web_safari", "tv", "default"];
  const failures = [];

  for (const client of profiles) {
    manager.destroyStream(guildId);
    let yt = null, ff = null, pcm = null, resource = null;
    try {
      pcm = new PassThrough({ highWaterMark: PCM_BUFFER_BYTES });
      resource = createAudioResource(pcm, { inputType: StreamType.Raw, inlineVolume: true, metadata: track });
      resource.volume?.setVolume(Math.max(0.01, Number(state.volume || 70) / 100));
      state.audioResource = resource;
      player.play(resource);

      const ytArgs = [
        "--no-warnings", "--no-progress", "--no-playlist", "--force-ipv4",
        "--js-runtimes", "deno", "--remote-components", "ejs:github",
        "--extractor-args", `youtube:player_client=${client};youtubepot-bgutilhttp:base_url=${POT_PROVIDER};disable_innertube=1`,
        "--retries", "1", "--fragment-retries", "1", "--retry-sleep", "linear=1::2",
        "--format", "bestaudio/best", "--output", "-", track.url
      ];

      yt = spawn(YTDLP, ytArgs, { stdio: ["ignore", "pipe", "pipe"] });
      ff = spawn(FFMPEG, [
        "-hide_banner", "-loglevel", "warning", "-nostdin", "-i", "pipe:0",
        ...(startMs > 0 ? ["-ss", String(startMs / 1000)] : []),
        "-vn", "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"
      ], { stdio: ["pipe", "pipe", "pipe"] });

      manager.streams.set(guildId, { yt, ff, pcm, resource });
      let ys = "", fs = "", got = false;
      const ok = await new Promise((resolve, reject) => {
        let done = false;
        const timer = setTimeout(() => fail(new Error(`No PCM from YouTube client ${client} within ${STARTUP_TIMEOUT_MS / 1000}s. ${errText(ys, 900)}`)), STARTUP_TIMEOUT_MS);
        const fail = e => { if (done) return; done = true; clearTimeout(timer); try { yt.kill("SIGKILL"); } catch {} try { ff.kill("SIGKILL"); } catch {} reject(e); };
        const success = () => { if (done) return; done = true; clearTimeout(timer); resolve(true); };
        yt.stderr.on("data", c => { ys += c.toString(); if (ys.length > 10000) ys = ys.slice(-10000); });
        ff.stderr.on("data", c => { fs += c.toString(); if (fs.length > 10000) fs = fs.slice(-10000); });
        ff.stdout.on("data", c => { if (c?.length) { got = true; success(); } });
        yt.stdout.on("error", e => { if (e?.code !== "EPIPE") fail(e); });
        ff.stdout.on("error", e => { if (e?.code !== "EPIPE") fail(e); });
        ff.stdin.on("error", e => { if (e?.code !== "EPIPE") fail(e); });
        yt.on("error", fail); ff.on("error", fail);
        yt.on("close", code => { if (!got && code !== 0) fail(new Error(`yt-dlp ${client} exited ${code}: ${errText(ys, 1600)}`)); });
        ff.on("close", code => { if (!got) fail(new Error(`FFmpeg ${client} exited ${code}: ${errText(fs, 1200)}`)); });
        yt.stdout.pipe(ff.stdin);
        ff.stdout.pipe(pcm);
      });

      if (!ok) throw new Error("YouTube produced no PCM.");
      state.transitioning = false;
      state.startedAt = Date.now();
      state.audioResource = resource;
      Promise.resolve(manager.refreshPanel?.(guildId)).catch(() => {});
      console.log(`▶️ Direct YouTube playback started: ${track.title}`);
      console.log(`✅ YouTube client: ${client}`);
      return true;
    } catch (e) {
      const msg = e?.message || String(e);
      failures.push(`${client}: ${errText(msg)}`);
      if (isBotBlock(msg)) console.warn(`🚧 YouTube bot check on ${client}; trying next client.`);
      else console.warn(`⚠️ YouTube client ${client} failed: ${errText(msg, 1200)}`);
      try { player.stop(true); } catch {}
      try { pcm?.destroy(); } catch {}
      manager.destroyStream(guildId);
      state.audioResource = null;
    }
  }
  throw new Error(`YouTube playback failed. ${failures.join(" || ")}`);
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
    source: "soundcloud",
    sourceUrl: found.url
  };
  state.current = track;
  state.transitioning = true;
  const pcm = new PassThrough({ highWaterMark: PCM_BUFFER_BYTES });
  const resource = createAudioResource(pcm, { inputType: StreamType.Raw, inlineVolume: true, metadata: track });
  resource.volume?.setVolume(Math.max(0.01, Number(state.volume || 70) / 100));
  state.audioResource = resource;
  player.play(resource);

  const yt = spawn(YTDLP, [
    "--no-warnings", "--no-progress", "--no-playlist", "--force-ipv4",
    "--format", "bestaudio/best", "--output", "-", found.url
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const ff = spawn(FFMPEG, ["-hide_banner", "-loglevel", "warning", "-nostdin", "-i", "pipe:0", ...(startMs > 0 ? ["-ss", String(startMs / 1000)] : []), "-vn", "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"], { stdio: ["pipe", "pipe", "pipe"] });
  manager.streams.set(guildId, { yt, ff, pcm, resource, source: "soundcloud" });

  let ys = "", fs = "", got = false;
  await new Promise((resolve, reject) => {
    let done = false;
    const fail = e => { if (done) return; done = true; try { yt.kill("SIGKILL"); } catch {} try { ff.kill("SIGKILL"); } catch {} reject(e); };
    const success = () => { if (done) return; done = true; resolve(); };
    const timer = setTimeout(() => fail(new Error(`SoundCloud produced no PCM within ${STARTUP_TIMEOUT_MS / 1000}s. ${errText(ys, 1200)}`)), STARTUP_TIMEOUT_MS);
    yt.stderr.on("data", c => { ys += c.toString(); if (ys.length > 10000) ys = ys.slice(-10000); });
    ff.stderr.on("data", c => { fs += c.toString(); if (fs.length > 10000) fs = fs.slice(-10000); });
    ff.stdout.on("data", c => { if (c?.length) { got = true; clearTimeout(timer); success(); } });
    yt.on("error", fail); ff.on("error", fail);
    yt.stdout.on("error", e => { if (e?.code !== "EPIPE") fail(e); });
    ff.stdout.on("error", e => { if (e?.code !== "EPIPE") fail(e); });
    yt.on("close", code => { if (!got && code !== 0) fail(new Error(`SoundCloud yt-dlp exited ${code}: ${errText(ys, 1400)}`)); });
    ff.on("close", code => { if (!got) fail(new Error(`SoundCloud FFmpeg exited ${code}: ${errText(fs, 1200)}`)); });
    yt.stdout.pipe(ff.stdin); ff.stdout.pipe(pcm);
  });

  state.transitioning = false;
  state.startedAt = Date.now();
  state.audioResource = resource;
  Promise.resolve(manager.refreshPanel?.(guildId)).catch(() => {});
  console.log(`☁️ SoundCloud emergency playback started: ${track.title}`);
}

function install(Manager) {
  if (!Manager || Manager.prototype.__deathDirectPlaybackPatched) return;
  Manager.prototype.__deathDirectPlaybackPatched = true;

  Manager.prototype.startTrack = async function deathStartTrack(guildId, track, startMs = 0) {
    const state = this.getState(guildId);
    state.current = track;
    state.transitioning = true;
    try {
      if (/youtube\.com|youtu\.be/i.test(track?.url || "")) {
        try { await startYtStream(this, guildId, track, startMs); return; }
        catch (youtubeError) {
          console.warn(`🛟 YouTube unavailable; switching to SoundCloud fallback: ${errText(youtubeError?.message || youtubeError, 1400)}`);
        }
        await startSoundCloud(this, guildId, track, startMs);
        return;
      }
      await startSoundCloud(this, guildId, track, startMs);
    } catch (error) {
      state.transitioning = false;
      state.audioResource = null;
      throw error;
    }
  };

  console.log("🎵 DEATH direct playback loaded: modern YouTube clients + SoundCloud emergency fallback.");
}

try { install(require("./DirectMusicManager")); }
catch (e) { console.error("❌ Direct playback patch failed to load:", e?.message || e); }
module.exports = { install };
