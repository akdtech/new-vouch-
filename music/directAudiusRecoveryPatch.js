"use strict";

/*
 * DEATH Music — non-YouTube playback recovery.
 * Railway's datacenter IP is currently being challenged by YouTube, so the
 * permanent music engine uses Audius' public catalog/stream API as the first
 * playable source. YouTube/Piped code remains available for URLs/fallbacks.
 */
const { spawn } = require("node:child_process");
const { PassThrough } = require("node:stream");
const { createAudioResource, StreamType } = require("@discordjs/voice");
const MusicManager = require("./DirectMusicManager");

const FFMPEG = process.env.FFMPEG_PATH || "/usr/bin/ffmpeg";
const AUDIUS_API = String(process.env.AUDIUS_API_URL || "https://api.audius.co/v1").replace(/\/+$/, "");
const SEARCH_TIMEOUT_MS = 9000;
const PCM_TIMEOUT_MS = 9000;

const clean = v => String(v || "").replace(/\s+/g, " ").trim();
const idOf = t => t?.identifier || t?.id || t?.url || null;
const badTitle = /\b(playlist|mix|compilation|full album|album mix|nonstop|continuous|radio|medley|meg[a\s-]?mix|hour mix|1 hour|2 hour|3 hour|karaoke|reaction|review)\b/i;

function kill(child) {
  try { child?.kill("SIGKILL"); } catch {}
}

function retire(stream) {
  if (!stream) return;
  try { stream.ff?.stdout?.unpipe?.(); } catch {}
  kill(stream.ff);
  try { stream.pcm?.destroy?.(); } catch {}
}

async function audiusSearch(query, requester) {
  const q = clean(query);
  if (!q) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const url = new URL(AUDIUS_API + "/tracks/search");
    url.searchParams.set("query", q);
    url.searchParams.set("limit", "25");
    url.searchParams.set("sort_method", "relevant");

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "user-agent": "DEATH-GMAO-Music/6.0"
      }
    });
    if (!response.ok) throw new Error("Audius HTTP " + response.status);
    const json = await response.json();
    const items = Array.isArray(json?.data) ? json.data : [];

    const norm = v => clean(v).toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
    const queryNorm = norm(q);
    const words = queryNorm.split(" ").filter(Boolean);

    return items
      .filter(x => x?.id && x?.title)
      .map(x => {
        const title = clean(x.title);
        const artist = clean(x.user?.name || x.user?.handle || "Unknown artist");
        const nt = norm(title);
        const na = norm(artist);
        const titleWords = new Set(nt.split(" ").filter(Boolean));
        const matchedTitle = words.filter(w => titleWords.has(w)).length;
        const matchedArtist = words.filter(w => na.includes(w)).length;
        let score = matchedTitle * 20 + matchedArtist * 10;
        if (nt === queryNorm) score += 250;
        if (nt.includes(queryNorm)) score += 120;
        if (words.length && words.every(w => titleWords.has(w))) score += 100;
        if (badTitle.test(title)) score -= 1000;

        return {
          identifier: String(x.id),
          id: String(x.id),
          url: AUDIUS_API + "/tracks/" + encodeURIComponent(x.id) + "/stream",
          title,
          author: artist,
          length: Number(x.duration || 0) * 1000,
          genre: x.genre || x.tags?.genre || null,
          requester: requester || null,
          thumbnail: x.artwork?.["480x480"] || x.artwork?.["150x150"] || null,
          source: "audius",
          _score: score
        };
      })
      .filter(t => !badTitle.test(t.title))
      .sort((a, b) => b._score - a._score);
  } finally {
    clearTimeout(timer);
  }
}

async function playAudius(manager, guildId, track, startMs = 0, options = {}) {
  const state = manager.getState(guildId);
  const player = manager.players.get(guildId) || manager.ensurePlayer(guildId);
  manager.bindPlayerEvents(guildId, player);

  const oldStream = manager.streams.get(guildId);
  const token = Number(state.playbackToken || 0) + 1;
  state.playbackToken = token;
  state.pendingTrack = track;
  state.transitioning = true;

  const ff = spawn(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5",
    "-i", track.url,
    ...(startMs > 0 ? ["-ss", String(startMs / 1000)] : []),
    "-vn", "-af", "aresample=48000:async=1:first_pts=0", "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"
  ], { stdio: ["ignore", "pipe", "pipe"] });

  let stderr = "";
  ff.stderr.on("data", chunk => {
    stderr += chunk.toString();
    if (stderr.length > 5000) stderr = stderr.slice(-5000);
  });

  const first = await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      kill(ff);
      reject(new Error("Audius audio produced no PCM within 15 seconds."));
    }, PCM_TIMEOUT_MS);

    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    ff.stdout.once("data", chunk => {
      if (!chunk?.length) return done(reject, new Error("Audius returned empty audio."));
      done(resolve, chunk);
    });
    ff.once("error", error => done(reject, error));
    ff.once("close", code => {
      if (code !== 0) done(reject, new Error("FFmpeg exited " + code + ": " + clean(stderr).slice(-800)));
    });
  }).catch(error => {
    kill(ff);
    state.pendingTrack = null;
    state.transitioning = false;
    throw error;
  });

  if (state.playbackToken !== token) {
    kill(ff);
    state.pendingTrack = null;
    state.transitioning = false;
    throw new Error("Playback attempt superseded.");
  }

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

  manager.streams.set(guildId, {
    ff,
    pcm,
    resource,
    source: "audius"
  });

  pcm.write(first);
  ff.stdout.pipe(pcm);
  player.play(resource);

  if (options?.handoff !== false) retire(oldStream);

  Promise.resolve(manager.updateVoiceStatus?.(guildId, "🎵 Playing: " + manager.getTrackTitle(track))).catch(() => {});
  Promise.resolve(manager.refreshPanel?.(guildId)).catch(() => {});
  console.log("🎧 Audius playback started: " + manager.getTrackTitle(track) + " — " + manager.getTrackAuthor(track));
  return true;
}


const YTDLP = process.env.YTDLP_PATH || "/usr/local/bin/yt-dlp";
const SEARCH_CACHE = new Map();
const normalizeKey = value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();

async function youtubeSearch(query, requester) {
  const q = clean(query);
  if (!q) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6500);
  try {
    const args = [
      "--no-warnings", "--no-progress", "--no-playlist",
      "--flat-playlist", "--dump-single-json",
      `ytsearch8:${q} official audio`
    ];
    const child = spawn(YTDLP, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timeout = setTimeout(() => kill(child), 6000);
    child.stdout.on("data", x => { stdout += x.toString(); if (stdout.length > 120000) stdout = stdout.slice(-120000); });
    child.stderr.on("data", x => { stderr += x.toString(); if (stderr.length > 5000) stderr = stderr.slice(-5000); });
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    }).finally(() => clearTimeout(timeout));
    if (code !== 0) throw new Error(clean(stderr).slice(-800) || "YouTube search failed");
    const data = JSON.parse(stdout || "{}");
    const entries = Array.isArray(data?.entries) ? data.entries : [];
    const norm = normalizeKey(q);
    const tokens = norm.split(" ").filter(Boolean);
    const bad = /\b(playlist|mix|compilation|full album|album mix|nonstop|continuous|radio|medley|meg[a\s-]?mix|hour mix|karaoke|reaction|review|sped up|slowed|nightcore|8d|remix)\b/i;
    const scored = entries.filter(x => x?.id && x?.title && !bad.test(x.title)).map(x => {
      const title = normalizeKey(x.title);
      const channel = normalizeKey(x.channel || x.uploader || "");
      const titleTokens = new Set(title.split(" "));
      let score = tokens.filter(t => titleTokens.has(t)).length * 25;
      if (tokens.length && tokens.every(t => titleTokens.has(t))) score += 100;
      if (title === norm) score += 300;
      if (title.includes(norm)) score += 180;
      if (/\b(official|audio|lyrics|lyric video)\b/i.test(x.title)) score += 25;
      if (/\b(topic|records|music|vevo)\b/i.test(channel)) score += 10;
      return { x, score };
    }).sort((a,b) => b.score - a.score);
    return scored.slice(0, 4).map(({x}) => ({
      identifier: String(x.id), id: String(x.id),
      url: `https://www.youtube.com/watch?v=${x.id}`,
      title: clean(x.title), author: clean(x.channel || x.uploader || "Unknown artist"),
      length: Number(x.duration || 0) * 1000, requester: requester || null,
      thumbnail: x.thumbnail || `https://i.ytimg.com/vi/${x.id}/hqdefault.jpg`,
      source: "youtube-search"
    }));
  } finally {
    clearTimeout(timer);
  }
}

const previousSearch = MusicManager.prototype.search;
const previousStartTrack = MusicManager.prototype.startTrack;

MusicManager.prototype.search = async function accurateMusicSearch(query, requester, options = {}) {
  const q = typeof query === "string" ? this.cleanQuery(query) : this.cleanQuery(query?.query || query?.search || query?.name);
  if (!q) throw new Error("Please provide a song name or URL.");

  if ((q.startsWith("http://") || q.startsWith("https://")) && !q.includes("youtube.com") && !q.includes("youtu.be")) {
    return previousSearch.call(this, q, requester, options);
  }

  const key = normalizeKey(q);
  const cached = SEARCH_CACHE.get(key);
  if (cached && Date.now() - cached.at < 6 * 60 * 60 * 1000) {
    console.log("⚡ MUSIC CACHE HIT: \"" + q + "\" -> \"" + cached.track.title + "\"");
    return { type: "track", tracks: [{ ...cached.track, requester: requester || cached.track.requester }] };
  }

  // Search YouTube for the exact recording first. This gives us the real
  // YouTube title/artist/video ID instead of an unrelated Audius upload.
  try {
    const yt = await youtubeSearch(q, requester);
    if (yt.length) {
      const track = yt[0];
      SEARCH_CACHE.set(key, { at: Date.now(), track });
      console.log("🎯 ACCURATE YOUTUBE SEARCH: \"" + q + "\" -> \"" + track.title + "\" by \"" + track.author + "\"");
      return { type: "track", tracks: [track] };
    }
  } catch (error) {
    console.warn("⚠️ YouTube search unavailable; trying Audius exact-match fallback:", error?.message || error);
  }

  try {
    const tracks = await audiusSearch(q, requester);
    if (tracks.length) {
      const track = tracks[0];
      SEARCH_CACHE.set(key, { at: Date.now(), track });
      console.log("🎵 AUDIUS FALLBACK SEARCH: \"" + q + "\" -> \"" + track.title + "\" by \"" + track.author + "\"");
      return { type: "track", tracks: [track] };
    }
  } catch (error) {
    console.warn("⚠️ Audius search failed for \"" + q + "\": " + (error?.message || error));
  }

  return previousSearch.call(this, q, requester, options);
};

