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
const PCM_TIMEOUT_MS = 15000;

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
    "-vn", "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"
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

const previousSearch = MusicManager.prototype.search;
const previousStartTrack = MusicManager.prototype.startTrack;

MusicManager.prototype.search = async function audiusFirstSearch(query, requester, options = {}) {
  const q = typeof query === "string" ? this.cleanQuery(query) : this.cleanQuery(query?.query || query?.search || query?.name);
  if (!q) throw new Error("Please provide a song name or URL.");

  // Non-YouTube direct URLs are still supported normally.
  if (/^https?:\/\//i.test(q) && !/youtube\.com|youtu\.be/i.test(q)) {
    return previousSearch.call(this, q, requester, options);
  }

  try {
    const tracks = await audiusSearch(q, requester);
    if (tracks.length) {
      const selected = tracks.slice(0, options?.returnAll ? 20 : 6).map(({_score, ...track}) => track);
      console.log("🎵 Audius-first search: \"" + q + "\" -> \"" + selected[0].title + "\" by \"" + selected[0].author + "\"");
      return { type: "track", tracks: selected };
    }
  } catch (error) {
    console.warn("⚠️ Audius search failed for \"" + q + "\": " + (error?.message || error));
  }

  // Keep the existing engine as a fallback for environments where Audius is
  // temporarily unavailable.
  return previousSearch.call(this, q, requester, options);
};

async function audiusTrending(requester) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const url = new URL(AUDIUS_API + "/tracks/trending");
    url.searchParams.set("time", "week");
    url.searchParams.set("limit", "100");
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": "DEATH-GMAO-Music/6.0" }
    });
    if (!response.ok) throw new Error("Audius trending HTTP " + response.status);
    const json = await response.json();
    const items = Array.isArray(json?.data) ? json.data : [];
    return items
      .filter(x => x?.id && x?.title)
      .map(x => ({
        identifier: String(x.id),
        id: String(x.id),
        url: AUDIUS_API + "/tracks/" + encodeURIComponent(x.id) + "/stream",
        title: clean(x.title),
        author: clean(x.user?.name || x.user?.handle || "Unknown artist"),
        length: Number(x.duration || 0) * 1000,
        genre: x.genre || x.tags?.genre || null,
        requester: requester || null,
        thumbnail: x.artwork?.["480x480"] || x.artwork?.["150x150"] || null,
        source: "audius"
      }))
      .filter(t => Number(t.length || 0) >= 60 * 1000 && Number(t.length || 0) <= 8 * 60 * 1000)
      .filter(t => !badTitle.test(t.title));
  } finally {
    clearTimeout(timer);
  }
}

const previousAutoplayNext = MusicManager.prototype.autoplayNext;

MusicManager.prototype.autoplayNext = async function audiusAutoplayNext(guildId) {
  const state = this.getState(guildId);
  const player = this.players.get(guildId) || this.ensurePlayer(guildId);
  if (!state.autoplay || state.intentionalLeave || state.autoplayBusy) return false;
  if (state.current || state.queue.length) return false;
  if (Number(state.autoplayBlockedUntil || 0) > Date.now()) return false;

  state.autoplayBusy = true;
  state.transitioning = true;
  try {
    const ctx = state.autoplayContext || {};
    const recent = new Set(Array.isArray(state.recent) ? state.recent : []);
    let candidates = [];

    // When we know the artist, search that artist first so Skip/end-of-track
    // stays close to the current artist/genre instead of jumping randomly.
    if (clean(ctx.artist || ctx.author)) {
      const artist = clean(ctx.artist || ctx.author);
      try { candidates.push(...await audiusSearch(artist, this.client.user)); } catch {}
      if (clean(ctx.title)) {
        try { candidates.push(...await audiusSearch(artist + " similar " + clean(ctx.title), this.client.user)); } catch {}
      }
    }

    // Startup has no artist context, so use Audius' real trending endpoint
    // instead of YouTube search phrases that are commonly playlists/mixes.
    if (!candidates.length) {
      try { candidates = await audiusTrending(this.client.user); } catch (error) {
        console.warn("⚠️ Audius trending autoplay failed: " + (error?.message || error));
      }
    }

    candidates = candidates
      .filter(t => t?.source === "audius" && t?.url)
      .filter(t => Number(t.length || 0) >= 60 * 1000 && Number(t.length || 0) <= 8 * 60 * 1000)
      .filter(t => !badTitle.test(t.title))
      .filter(t => !recent.has(idOf(t)));

    if (clean(ctx.artist || ctx.author)) {
      const artist = clean(ctx.artist || ctx.author).toLowerCase();
      candidates.sort((a, b) => {
        const aa = clean(a.author).toLowerCase().includes(artist) ? 1 : 0;
        const bb = clean(b.author).toLowerCase().includes(artist) ? 1 : 0;
        return bb - aa;
      });
    }

    const chosen = candidates[0];
    if (!chosen) {
      state.transitioning = false;
      state.autoplayBusy = false;
      state.autoplayBlockedUntil = Date.now() + 10000;
      console.warn("⚠️ Audius autoplay found no suitable track.");
      return false;
    }

    chosen.isAutoplay = true;
    chosen.autoplayGroup = clean(ctx.artist || ctx.author)
      ? "Related to " + clean(ctx.artist || ctx.author)
      : "Audius Trending";

    await this.startTrack(guildId, chosen, 0, { handoff: false });
    const id = idOf(chosen);
    if (id) state.recent = [...state.recent, id].slice(-20);
    state.autoplayContext = {
      artist: clean(chosen.author),
      title: clean(chosen.title),
      query: clean(chosen.title),
      words: clean(chosen.title).toLowerCase().split(/\s+/).filter(w => w.length >= 3).slice(0, 10)
    };
    state.autoplayBlockedUntil = 0;
    state.transitioning = false;
    console.log("🎯 Audius autoplay started: " + chosen.title + " — " + chosen.author);
    return true;
  } catch (error) {
    state.transitioning = false;
    state.current = null;
    state.autoplayBlockedUntil = Date.now() + 10000;
    console.warn("⚠️ Audius autoplay recovery failed: " + (error?.message || error));
    return false;
  } finally {
    state.autoplayBusy = false;
  }
};

MusicManager.prototype.startTrack = async function audiusAwareStartTrack(guildId, track, startMs = 0, options = {}) {
  if (String(track?.source || "").toLowerCase() === "audius" && track?.url) {
    try {
      return await playAudius(this, guildId, track, startMs, options);
    } catch (error) {
      console.warn("⚠️ Audius playback failed; falling back to existing source engine: " + (error?.message || error));
    }
  }
  return previousStartTrack.call(this, guildId, track, startMs, options);
};

console.log("🎧 DEATH Audius recovery loaded: non-YouTube search + direct stream playback for Railway.");
