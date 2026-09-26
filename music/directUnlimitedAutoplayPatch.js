"use strict";

/*
 * DEATH unlimited related-autoplay queue.
 *
 * The old autoplay path could repeatedly receive the same cached search result.
 * This patch bypasses that search cache for autoplay by asking yt-dlp directly
 * for multiple YouTube search results, then keeps a rolling queue of related
 * tracks. Manual /play remains the user's selected song.
 */
const { spawn } = require("node:child_process");
const MusicManager = require("./DirectMusicManager");

const YTDLP = process.env.YTDLP_PATH || "/usr/local/bin/yt-dlp";
const COOKIE_FILE = process.env.YOUTUBE_COOKIES_PATH || "/tmp/youtube-cookies.txt";
const POT = String(process.env.YTDLP_POT_PROVIDER_URL || "").trim();
const MAX_QUEUE = 5;
const RECENT_LIMIT = 50;
const SEARCH_TIMEOUT = 12000;
const BAD_TITLE = /\b(playlist|mix|compilation|full album|album mix|nonstop|continuous|radio|medley|hour mix|meg[a\s-]?mix|collection|reaction|review|podcast|karaoke|cover)\b/i;

const clean = v => String(v || "").replace(/\s+/g, " ").trim();
const idOf = t => t?.identifier || t?.id || t?.url || null;
const artistOf = t => clean(t?.author || t?.uploader || t?.channel);
const normalize = v => clean(v).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

function artistMatch(actual, wanted) {
  const a = normalize(actual);
  const w = normalize(wanted);
  if (!a || !w) return false;
  return a === w || a.includes(w) || w.includes(a);
}

function cookieArgs() {
  try {
    return require("node:fs").existsSync(COOKIE_FILE) ? ["--cookies", COOKIE_FILE] : [];
  } catch { return []; }
}

function ytArgs(profile = "web_music,web_creator,tv,web_safari") {
  const args = [
    "--no-warnings", "--no-progress", "--no-playlist", "--flat-playlist",
    "--playlist-end", "12", "--force-ipv4",
    ...cookieArgs(),
    "--extractor-args", `youtube:player_client=${profile};fetch_pot=always;use_ad_playback_context=false`,
    "--extractor-args", "youtubepot-wpc:browser_path=/usr/bin/chromium",
    "--remote-components", "ejs:github",
    "--js-runtimes", "node,deno"
  ];
  if (POT) args.push("--extractor-args", `youtubepot-bgutilhttp:base_url=${POT}`);
  return args;
}

function searchYouTube(query) {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP, [
      ...ytArgs(),
      "--dump-single-json",
      "ytsearch12:" + clean(query)
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      if (!settled) {
        settled = true;
        reject(new Error("autoplay YouTube search timeout"));
      }
    }, SEARCH_TIMEOUT);

    child.stdout.on("data", c => { stdout += c.toString(); });
    child.stderr.on("data", c => { stderr += c.toString(); });
    child.on("error", e => {
      if (settled) return;
      settled = true; clearTimeout(timer); reject(e);
    });
    child.on("close", code => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (code !== 0) return reject(new Error(clean(stderr).slice(-1200) || `yt-dlp exited ${code}`));
      try {
        const data = JSON.parse(stdout || "{}");
        resolve(Array.isArray(data?.entries) ? data.entries : []);
      } catch (e) {
        reject(e);
      }
    });
  });
}

function toTrack(entry, requester) {
  const id = entry?.id;
  if (!id || !entry?.title) return null;
  return {
    identifier: id,
    id,
    url: `https://www.youtube.com/watch?v=${id}`,
    title: clean(entry.title),
    author: clean(entry.uploader || entry.channel || entry.creator) || "Unknown artist",
    length: Number(entry.duration || entry.duration_string || 0) * (Number(entry.duration || 0) ? 1000 : 0),
    requester: requester || null,
    thumbnail: entry.thumbnail || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    isAutoplay: true,
    source: "youtube-autoplay"
  };
}

async function discover(manager, context, recent) {
  const artist = clean(context?.artist || context?.author);
  const title = clean(context?.title);
  const query = clean(context?.query);

  const seeds = [];
  if (artist) {
    seeds.push(`${artist} songs official audio`);
    seeds.push(`${artist} best songs official audio`);
    seeds.push(`${artist} latest songs official audio`);
  }
  if (title) {
    seeds.push(`${title} similar songs official audio`);
    seeds.push(`${title} related songs official audio`);
  }
  if (query && !artist) {
    seeds.push(`${query} songs official audio`);
    seeds.push(`${query} similar songs official audio`);
  }

  const candidates = new Map();
  for (const seed of [...new Set(seeds)].slice(0, 6)) {
    try {
      const entries = await searchYouTube(seed);
      for (const entry of entries) {
        const track = toTrack(entry, manager.client.user);
        if (!track || BAD_TITLE.test(track.title)) continue;
        const id = idOf(track);
        if (!id || recent.has(id)) continue;
        if (!Number.isFinite(track.length) || track.length < 60 * 1000 || track.length > 8 * 60 * 1000) continue;

        let score = 0;
        if (artistMatch(artistOf(track), artist)) score += 200;
        const hay = normalize(`${track.title} ${artistOf(track)}`);
        for (const word of normalize(title || query).split(" ").filter(x => x.length >= 3)) {
          if (hay.includes(word)) score += 10;
        }
        if (/\b(official|topic|vevo)\b/i.test(artistOf(track) + " " + track.title)) score += 5;
        const old = candidates.get(id);
        if (!old || score > old.score) candidates.set(id, { track, score });
      }
    } catch (error) {
      console.warn(`⚠️ Unlimited autoplay search failed: ${seed} — ${error?.message || error}`);
    }
  }

  return [...candidates.values()]
    .sort((a, b) => b.score - a.score)
    .map(x => x.track)
    .slice(0, 12);
}

async function fillQueue(manager, guildId, minimum = 3) {
  const state = manager.getState(guildId);
  if (!state.autoplay || state.intentionalLeave) return 0;
  if (state.autoplayQueueBusy) return 0;
  if (state.queue.length >= minimum) return state.queue.length;

  state.autoplayQueueBusy = true;
  try {
    const recent = new Set(Array.isArray(state.recent) ? state.recent : []);
    for (const queued of state.queue) {
      const id = idOf(queued);
      if (id) recent.add(id);
    }
    if (state.current) {
      const id = idOf(state.current);
      if (id) recent.add(id);
    }

    const candidates = await discover(manager, state.autoplayContext || {}, recent);
    for (const track of candidates) {
      if (state.queue.length >= MAX_QUEUE) break;
      const id = idOf(track);
      if (!id || recent.has(id)) continue;
      track.isAutoplay = true;
      track.autoplayGroup = artistOf(state.autoplayContext) ? `Same artist / related: ${artistOf(state.autoplayContext)}` : "Related / same genre";
      state.queue.push(track);
      state.recent = [...(state.recent || []), id].slice(-RECENT_LIMIT);
      recent.add(id);
    }

    if (state.queue.length) {
      console.log(`♾️ Unlimited autoplay queue: ${state.queue.length} tracks ready`);
      Promise.resolve(manager.refreshPanel?.(guildId)).catch(() => {});
    }
    return state.queue.length;
  } finally {
    state.autoplayQueueBusy = false;
  }
}

if (!MusicManager.prototype.__deathUnlimitedAutoplay) {
  MusicManager.prototype.__deathUnlimitedAutoplay = true;

  const originalPlay = MusicManager.prototype.play;
  MusicManager.prototype.play = async function unlimitedPlay(args) {
    const result = await originalPlay.call(this, args);
    const state = this.getState(args.guildId);
    const track = result?.track || state.current;
    if (track) {
      state.autoplayContext = {
        artist: artistOf(track),
        title: clean(track.title),
        query: clean(args.query)
      };
      state.recent = [...(state.recent || []), idOf(track)].filter(Boolean).slice(-RECENT_LIMIT);
    }
    // Build several next songs immediately so playback does not depend on
    // finding another result after the current track has already ended.
    fillQueue(this, args.guildId, 3).catch(error =>
      console.warn("⚠️ Initial autoplay queue fill failed:", error?.message || error)
    );
    return result;
  };

  const originalHandleTrackEnd = MusicManager.prototype.handleTrackEnd;
  MusicManager.prototype.handleTrackEnd = async function unlimitedTrackEnd(guildId, fromError = false) {
    const state = this.getState(guildId);
    const result = await originalHandleTrackEnd.call(this, guildId, fromError);
    if (state.autoplay && !state.intentionalLeave) {
      fillQueue(this, guildId, 3).catch(error =>
        console.warn("⚠️ Background autoplay refill failed:", error?.message || error)
      );
    }
    return result;
  };

  const originalAutoplayNext = MusicManager.prototype.autoplayNext;
  MusicManager.prototype.autoplayNext = async function unlimitedAutoplayNext(guildId) {
    const state = this.getState(guildId);
    if (!state.autoplay || state.intentionalLeave) return false;
    if (!state.queue.length) await fillQueue(this, guildId, 1);
    if (!state.queue.length) return originalAutoplayNext.call(this, guildId);
    const player = this.players.get(guildId) || this.ensurePlayer(guildId);
    if (state.current || player.state.status === "playing" || player.state.status === "paused") return false;
    const next = state.queue.shift();
    try {
      await this.startTrack(guildId, next, 0, { handoff: false });
      state.autoplayContext = {
        artist: artistOf(next),
        title: clean(next.title),
        query: clean(next.title)
      };
      state.transitioning = false;
      Promise.resolve(fillQueue(this, guildId, 3)).catch(() => {});
      console.log(`♾️ Unlimited autoplay started: ${next.title} — ${artistOf(next)}`);
      return true;
    } catch (error) {
      state.current = null;
      state.transitioning = false;
      console.warn(`⚠️ Unlimited autoplay track failed: ${next.title} — ${error?.message || error}`);
      return this.autoplayNext(guildId);
    }
  };

  console.log("♾️ DEATH unlimited autoplay queue loaded: 3+ related tracks kept ready.");
}
