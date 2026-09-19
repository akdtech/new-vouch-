"use strict";

/*
 * DEATH Music 24/7 — FINAL SELF-HEALING PLAYBACK CORE
 *
 * This patch is intentionally loaded last. It removes the fragile yt-dlp ->
 * FFmpeg stdin pipeline, uses yt-dlp only to resolve a fresh media URL, then
 * lets FFmpeg read that URL directly. The Discord AudioPlayer is changed only
 * after real PCM bytes exist.
 *
 * It also fixes:
 * - YouTube PO-token provider configuration
 * - search fallback
 * - autoplay recovery
 * - stale current-track state
 * - panel/status synchronization
 * - atomic manual /play and skip handoffs
 */
const { spawn } = require("node:child_process");
const { PassThrough } = require("node:stream");
const { createAudioResource, StreamType, AudioPlayerStatus } = require("@discordjs/voice");
const MusicManager = require("./DirectMusicManager");
let getPipedStream = null;
try { ({ getPipedStream } = require("./directPipedPlaybackPatch")); } catch {}

const YTDLP = process.env.YTDLP_PATH || "/usr/local/bin/yt-dlp";
const FFMPEG = process.env.FFMPEG_PATH || "/usr/bin/ffmpeg";
const POT = process.env.YTDLP_POT_PROVIDER_URL || "http://bgutil-pot.railway.internal:4416";
const SEARCH_TIMEOUT = 12000;
const RESOLVE_TIMEOUT = 14000;
const PCM_TIMEOUT = 15000;
const RECONNECT_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140 Safari/537.36";

const clean = v => String(v || "").replace(/\s+/g, " ").trim();
const idOf = t => t?.identifier || t?.id || t?.url || null;
const kill = p => { try { p?.kill("SIGKILL"); } catch {} };

function youtubeArgs(profile = "default,web_embedded") {
  return [
    "--extractor-args", `youtube:player_client=${profile}`,
    "--extractor-args", `youtubepot-bgutilhttp:base_url=${POT}`,
    "--remote-components", "ejs:github",
    "--js-runtimes", "node,deno"
  ];
}

function runYtDlp(args, timeoutMs, profile = "default,web_embedded") {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP, [
      "--no-warnings",
      "--no-progress",
      "--no-playlist",
      "--force-ipv4",
      ...youtubeArgs(profile),
      ...args
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const timer = setTimeout(() => {
      kill(child);
      finish(reject, new Error(`yt-dlp timed out after ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);

    child.stdout.on("data", c => {
      stdout += c.toString();
      if (stdout.length > 120000) stdout = stdout.slice(-120000);
    });
    child.stderr.on("data", c => {
      stderr += c.toString();
      if (stderr.length > 12000) stderr = stderr.slice(-12000);
    });
    child.on("error", e => finish(reject, e));
    child.on("close", code => {
      if (code === 0) finish(resolve, { stdout, stderr });
      else finish(reject, new Error(clean(stderr).slice(-2200) || `yt-dlp exited ${code}`));
    });
  });
}

function normalize(info, requester, fallbackUrl = null) {
  const id = info?.id || info?.identifier || null;
  const url = info?.webpage_url || info?.original_url || fallbackUrl || (id ? `https://www.youtube.com/watch?v=${id}` : null);
  return {
    identifier: id || url,
    id: id || url,
    url,
    title: clean(info?.title) || "Unknown track",
    author: clean(info?.uploader || info?.channel || info?.artist) || "Unknown artist",
    length: Number(info?.duration || 0) * 1000,
    requester: requester || null,
    thumbnail: info?.thumbnail || (id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null),
    isAutoplay: false
  };
}

function botBlocked(error) {
  const s = String(error?.message || error || "").toLowerCase();
  return s.includes("sign in to confirm") || s.includes("not a bot") ||
    s.includes("login_required") || s.includes("bot-check");
}

function safePanel(manager, guildId) {
  Promise.resolve(manager.refreshPanel?.(guildId)).catch(() => {});
}

function safeStatus(manager, guildId, track, label = "Playing") {
  const title = manager.getTrackTitle(track);
  Promise.resolve(manager.updateVoiceStatus?.(guildId, `🎵 ${label}: ${title}`)).catch(() => {});
  try {
    manager.updatePresence?.(track);
  } catch {}
}

async function waitForPcm(ff, timeoutMs) {
  return new Promise((resolve, reject) => {
    let first = null;
    let stderr = "";
    const timer = setTimeout(() => {
      kill(ff);
      reject(new Error(`FFmpeg produced no audio within ${Math.round(timeoutMs / 1000)}s. ${clean(stderr).slice(-700)}`));
    }, timeoutMs);

    ff.stderr?.on("data", c => {
      stderr += c.toString();
      if (stderr.length > 6000) stderr = stderr.slice(-6000);
    });

    const fail = e => {
      if (first) return;
      clearTimeout(timer);
      reject(e instanceof Error ? e : new Error(String(e)));
    };

    ff.stdout.once("data", chunk => {
      if (!chunk?.length) return fail(new Error("FFmpeg returned empty audio."));
      first = chunk;
      clearTimeout(timer);
      resolve(first);
    });

    ff.on("error", fail);
    ff.on("close", code => {
      if (!first && code !== 0) fail(new Error(`FFmpeg exited ${code}: ${clean(stderr).slice(-700)}`));
    });
  });
}

async function resolveYouTubeUrl(track) {
  const profiles = [
    "web_embedded",
    "default,web_embedded",
    "mweb"
  ];
  let lastError = null;

  for (const profile of profiles) {
    try {
      const result = await runYtDlp([
        "--dump-single-json",
        "--skip-download",
        "--format", "bestaudio/best",
        "--no-check-certificates",
        track.url
      ], RESOLVE_TIMEOUT, profile);

      const info = JSON.parse(result.stdout);
      const url = clean(info?.url || info?.requested_formats?.find(x => x?.url)?.url);
      if (url) {
        const rawHeaders = info?.http_headers || {};
        const headers = Object.entries(rawHeaders)
          .filter(([k, v]) => k && v)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\\r\\n") + "\\r\\n";
        console.log(`🔑 YouTube direct URL resolved with client profile: ${profile}`);
        return { url, headers };
      }
      lastError = new Error(`No direct URL from YouTube client ${profile}`);
    } catch (error) {
      lastError = error;
      console.warn(`⚠️ YouTube client ${profile} failed: ${clean(error?.message || error).slice(-500)}`);
    }
  }

  throw lastError || new Error("yt-dlp returned no direct audio URL.");
}

function retire(stream) {
  if (!stream) return;
  try { stream.ff?.removeAllListeners("error"); } catch {}
  kill(stream.ff);
  try { stream.pcm?.destroy(); } catch {}
}

async function directStart(manager, guildId, track, startMs, token, handoff) {
  const state = manager.getState(guildId);
  const player = manager.players.get(guildId) || manager.ensurePlayer(guildId);
  manager.bindPlayerEvents(guildId, player);

  let sourceUrl = null;
  let sourceHeaders = "";
  let sourceName = "youtube";

  // Piped is attempted first because it can hand us a server-side audio URL
  // without exposing the Railway IP to YouTube's normal yt-dlp download path.
  if (typeof getPipedStream === "function") {
    try {
      const piped = await getPipedStream(idOf(track));
      sourceUrl = piped?.url || null;
      sourceName = `piped:${piped?.base || "instance"}`;
      if (sourceUrl) console.log(`🚀 Final core selected Piped source for ${manager.getTrackTitle(track)}`);
    } catch (error) {
      console.warn(`⚠️ Piped source unavailable for ${manager.getTrackTitle(track)}: ${clean(error?.message || error).slice(-500)}`);
    }
  }

  if (!sourceUrl) {
    const resolved = await resolveYouTubeUrl(track);
    sourceUrl = resolved.url;
    sourceHeaders = resolved.headers || "";
  }
  if (state.playbackToken !== token) throw new Error("playback attempt superseded");

  const ffArgs = [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5",
    "-user_agent", RECONNECT_UA
  ];
  if (sourceHeaders) ffArgs.push("-headers", sourceHeaders);
  ffArgs.push("-i", sourceUrl,
  ...(startMs > 0 ? ["-ss", String(startMs / 1000)] : []),
  "-vn", "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"
  ];
  const ff = spawn(FFMPEG, ffArgs, { stdio: ["ignore", "pipe", "pipe"] });

  const first = await waitForPcm(ff, PCM_TIMEOUT);
  if (state.playbackToken !== token) {
    kill(ff);
    throw new Error("playback attempt superseded");
  }

  const oldStream = manager.streams.get(guildId);
  const pcm = new PassThrough({ highWaterMark: 1024 * 1024 });
  const resource = createAudioResource(pcm, {
    inputType: StreamType.Raw,
    inlineVolume: true,
    metadata: track
  });
  resource.volume?.setVolume(Math.max(0.01, Number(state.volume || 70) / 100));

  state.audioResource = resource;
  state.current = track;
  state.pendingTrack = null;
  state.transitioning = false;
  state.paused = false;
  state.startedAt = Date.now();
  state.positionOffset = Math.max(0, Number(startMs || 0));

  manager.streams.set(guildId, { ff, pcm, resource, source: "yt-dlp-direct" });
  pcm.write(first);
  ff.stdout.pipe(pcm);

  // AudioPlayer.play() atomically replaces the old Discord resource.
  player.play(resource);

  if (handoff) retire(oldStream);

  safeStatus(manager, guildId, track, "Playing");
  safePanel(manager, guildId);
  console.log(`🎵 FINAL playback started: ${manager.getTrackTitle(track)} via ${sourceName}`);
  return true;
}

async function searchYt(manager, query, requester) {
  const q = manager.cleanQuery(query);
  const result = await runYtDlp([
    "--dump-single-json",
    "--flat-playlist",
    "--playlist-end", "5",
    `ytsearch5:${q}`
  ], SEARCH_TIMEOUT);

  let data;
  try { data = JSON.parse(result.stdout); }
  catch {
    const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
    data = lines.length ? JSON.parse(lines.at(-1)) : null;
  }

  const entries = Array.isArray(data?.entries) ? data.entries : [];
  const tracks = entries
    .filter(x => x?.id)
    .map(x => normalize(x, requester))
    .filter(x => x.url);

  if (!tracks.length) throw new Error(`Track not found for "${q}".`);
  return { type: "track", tracks };
}

function install() {
  if (MusicManager.prototype.__deathFinalCoreV1) return;
  MusicManager.prototype.__deathFinalCoreV1 = true;

  const originalSearch = MusicManager.prototype.search;
  MusicManager.prototype.search = async function finalSearch(query, requester) {
    const q = typeof query === "string" ? this.cleanQuery(query) : this.cleanQuery(query?.query || query?.search || query?.name);
    if (!q) throw new Error("Please provide a song name or URL.");

    // Keep the existing fast Invidious search if it is healthy.
    if (!this.isYouTubeUrl(q)) {
      try {
        const result = await originalSearch.call(this, q, requester);
        if (result?.tracks?.length) return result;
      } catch (error) {
        console.warn(`⚠️ Primary music search failed; using direct YouTube search: ${clean(error?.message || error).slice(-500)}`);
      }
      return searchYt(this, q, requester);
    }

    try {
      const result = await this.runYtDlp([
        "--dump-single-json",
        "--skip-download",
        q
      ], SEARCH_TIMEOUT);
      return { type: "track", tracks: [normalize(JSON.parse(result.stdout), requester, q)] };
    } catch (error) {
      // URL metadata is not required to start playback; keep the URL playable.
      return { type: "track", tracks: [normalize({ id: q.match(/[?&]v=([A-Za-z0-9_-]{11})/)?.[1], title: q, uploader: "YouTube" }, requester, q)] };
    }
  };

  MusicManager.prototype.startTrack = async function finalStartTrack(guildId, track, startMs = 0, options = {}) {
    const state = this.getState(guildId);
    const previous = state.current;
    const handoff = options?.handoff !== false;
    const token = Number(state.playbackToken || 0) + 1;

    state.playbackToken = token;
    state.pendingTrack = track;
    state.transitioning = true;

    try {
      await directStart(this, guildId, track, startMs, token, handoff);
      return true;
    } catch (error) {
      if (state.playbackToken === token) {
        state.pendingTrack = null;
        state.current = previous || null;
        state.transitioning = false;
        if (!previous && !handoff) state.audioResource = null;
        safePanel(this, guildId);
      }
      throw error;
    }
  };

  MusicManager.prototype.play = async function finalPlay(args) {
    const guildId = args.guildId;
    const state = this.getState(guildId);
    state.intentionalLeave = false;
    state.autoplay = true;
    state.manualGeneration = Number(state.manualGeneration || 0) + 1;

    const destination = guildId === this.musicGuildId
      ? this.musicVoiceChannelId
      : args.voiceId;

    const player = await this.ensureConnection(guildId, destination).then(() => this.ensurePlayer(guildId));
    this.bindPlayerEvents(guildId, player);

    const result = await this.search(args.query, args.requester || this.client.user);
    const tracks = Array.isArray(result?.tracks) ? result.tracks.slice(0, 5) : [];
    if (!tracks.length) throw new Error(`Track not found for "${args.query}".`);

    const live = player.state?.resource?.metadata || state.current;
    const playing = Boolean(live && player.state.status !== AudioPlayerStatus.Idle);
    let lastError = null;

    // Try several search results. One YouTube upload can be blocked while the
    // next official/Topic upload is perfectly playable.
    for (const track of tracks) {
      track.isAutoplay = false;
      try {
        await this.startTrack(guildId, track, 0, { handoff: playing });
        state.autoplayContext = {
          artist: clean(track.author),
          title: clean(track.title),
          query: clean(args.query),
          words: clean(`${track.title} ${args.query}`).toLowerCase().split(/\s+/).filter(w => w.length >= 3).slice(0, 10)
        };
        state.autoplayBlockedUntil = 0;
        safePanel(this, guildId);
        return { type: "track", tracks: [track], track, player: this.getPlayer(guildId), startedNow: true, queued: false };
      } catch (error) {
        lastError = error;
        console.warn(`⚠️ Manual source failed; trying next result: ${clean(track.title)} — ${clean(error?.message || error).slice(-500)}`);
      }
    }

    // If all sources failed, keep the current resource alive rather than
    // replacing it with a dead state.
    if (playing) {
      state.transitioning = false;
      safePanel(this, guildId);
    }
    throw lastError || new Error("No playable source was found for that search.");
  };

  MusicManager.prototype.autoplayNext = async function finalAutoplayNext(guildId) {
    const state = this.getState(guildId);
    const player = this.players.get(guildId) || this.ensurePlayer(guildId);

    if (!state.autoplay || state.intentionalLeave || state.autoplayBusy) return false;
    if (state.current || state.queue.length || player.state.status === AudioPlayerStatus.Playing || player.state.status === AudioPlayerStatus.Paused) return false;
    if (Number(state.autoplayBlockedUntil || 0) > Date.now()) return false;

    state.autoplayBusy = true;
    state.transitioning = true;

    try {
      const ctx = state.autoplayContext || {};
      const seeds = [];
      if (clean(ctx.artist)) {
        seeds.push(`${ctx.artist} songs official audio`);
        if (clean(ctx.title)) seeds.push(`${ctx.artist} similar to ${ctx.title}`);
      }
      if (clean(ctx.title)) seeds.push(`${ctx.title} similar songs`);
      seeds.push("popular songs 2026 official audio", "top English songs 2026 official audio");

      const recent = new Set(Array.isArray(state.recent) ? state.recent : []);
      let candidates = [];

      for (const seed of [...new Set(seeds)]) {
        try {
          const result = await this.search(seed, this.client.user);
          candidates.push(...(result?.tracks || []));
        } catch (error) {
          if (!botBlocked(error)) console.warn(`⚠️ Autoplay search failed: ${clean(error?.message || error).slice(-500)}`);
        }
        if (candidates.length >= 8) break;
      }

      candidates = candidates
        .filter(t => t?.url && Number(t.length || 0) > 0 && Number(t.length || 0) <= 8 * 60 * 1000)
        .filter(t => !recent.has(idOf(t)))
        .filter(t => !/\b(mix|playlist|album|compilation|continuous|radio|medley|hour|hours)\b/i.test(t.title || ""));

      if (!candidates.length) throw new Error("No autoplay candidates were found.");

      let lastError = null;
      for (const chosen of candidates.slice(0, 6)) {
        chosen.isAutoplay = true;
        chosen.autoplayGroup = clean(ctx.artist) ? `Related to ${ctx.artist}` : "Popular music";
        try {
          await this.startTrack(guildId, chosen, 0, { handoff: false });
          const id = idOf(chosen);
          state.recent = id ? [...state.recent, id].slice(-20) : state.recent;
          state.autoplayBlockedUntil = 0;
          state.transitioning = false;
          state.autoplayContext = {
            artist: clean(chosen.author || ctx.artist),
            title: clean(chosen.title),
            query: clean(chosen.title),
            words: clean(chosen.title).toLowerCase().split(/\s+/).filter(w => w.length >= 3).slice(0, 10)
          };
          safeStatus(this, guildId, chosen, "Autoplay");
          safePanel(this, guildId);
          console.log(`🎯 FINAL AUTOPLAY: ${chosen.title} — ${chosen.author || "Unknown artist"}`);
          return true;
        } catch (error) {
          lastError = error;
          console.warn(`⚠️ Autoplay candidate failed; trying next: ${clean(chosen.title)} — ${clean(error?.message || error).slice(-500)}`);
        }
      }
      throw lastError || new Error("No autoplay source could be started.");
    } catch (error) {
      state.transitioning = false;
      state.current = null;
      state.autoplayBlockedUntil = Date.now() + (botBlocked(error) ? 20000 : 5000);
      safePanel(this, guildId);
      console.warn(`⚠️ Final autoplay recovery: ${clean(error?.message || error).slice(-900)}`);
      if (state.autoplay && !state.intentionalLeave && !state.retryTimer) {
        state.retryTimer = setTimeout(() => {
          state.retryTimer = null;
          this.autoplayNext(guildId).catch(() => {});
        }, 6000);
      }
      return false;
    } finally {
      state.autoplayBusy = false;
    }
  };

  // Make the panel/status follow the actual AudioResource, not a speculative
  // state update. Also keep it live without editing Discord every second.
  const originalBind = MusicManager.prototype.bindPlayerEvents;
  MusicManager.prototype.bindPlayerEvents = function finalBind(guildId, player) {
    originalBind.call(this, guildId, player);
    if (player.__deathFinalTruthBound) return;
    player.__deathFinalTruthBound = true;

    const sync = status => {
      const resource = player.state?.resource;
      const track = resource?.metadata;
      const state = this.getState(guildId);
      if (track) {
        state.current = track;
        state.transitioning = false;
        state.paused = status === "paused";
        if (status === "playing" && !state.startedAt) state.startedAt = Date.now();
        safeStatus(this, guildId, track, status === "paused" ? "Paused" : "Playing");
      }
      safePanel(this, guildId);
    };

    player.on(AudioPlayerStatus.Playing, () => sync("playing"));
    player.on(AudioPlayerStatus.Paused, () => sync("paused"));
    player.on(AudioPlayerStatus.Buffering, () => safePanel(this, guildId));

    if (!player.__deathPanelTicker) {
      player.__deathPanelTicker = setInterval(() => {
        const state = this.getState(guildId);
        if (state.intentionalLeave) return;
        if (state.current || player.state?.resource) safePanel(this, guildId);
      }, 5000);
    }
  };

  if (!this?.dummy) {}
  console.log("🧰 DEATH FINAL core loaded: direct media URLs + bgutil PO tokens + atomic playback + self-healing autoplay + live panel/status.");
}

install();

module.exports = { install };
