"use strict";

/*
 * DEATH Music 24/7 runtime repair.
 *
 * Important: Kazagumo adds the default search prefix itself when a
 * search source is supplied through { source }. Passing `ytmsearch:`
 * inside the query string causes Lavalink to receive the broken form
 * `ytsearch:ytmsearch:...`, which was the reason valid songs were found
 * by Lavalink but rejected by the bot.
 */

console.log("🛠️ DEATH Music runtime patch preloaded.");

const Module = require("module");
const originalLoad = Module._load;
let patched = false;

const clean = value =>
  String(value || "").replace(/\s+/g, " ").trim();

const normalize = value =>
  clean(value)
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9'& ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "for", "with",
  "it", "is", "in", "on", "at", "by", "from", "official",
  "music", "song", "songs", "video", "audio", "lyrics", "lyric",
  "full", "hd", "4k", "original", "officialaudio", "topic", "vevo",
  "audio", "version", "edit", "remix", "live"
]);

function tokens(value) {
  return normalize(value).split(" ").filter(Boolean);
}

function meaningful(value) {
  return tokens(value).filter(token => !STOP.has(token) && token.length > 1);
}

function distance(a, b) {
  a = String(a || "");
  b = String(b || "");

  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const row = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;

    for (let j = 1; j <= b.length; j++) {
      const old = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      previous = old;
    }
  }

  return row[b.length];
}

function fuzzy(a, b) {
  a = normalize(a);
  b = normalize(b);

  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;

  const limit = a.length <= 4 ? 1 : a.length <= 7 ? 2 : 3;
  return distance(a, b) <= limit;
}

function wordMatch(word, text) {
  return tokens(text).some(token => fuzzy(word, token));
}

function normalizeArtist(value) {
  return clean(value)
    .replace(/\s*-\s*topic$/i, "")
    .replace(/\s*\|\s*topic$/i, "")
    .replace(/\s*official$/i, "")
    .replace(/\s*vevo$/i, "")
    .trim();
}

function artistMatch(wanted, actual) {
  const w = normalizeArtist(wanted);
  const a = normalizeArtist(actual);

  if (!w || !a) return false;
  if (w.toLowerCase() === a.toLowerCase()) return true;
  if (a.toLowerCase().includes(w.toLowerCase())) return true;
  if (w.toLowerCase().includes(a.toLowerCase())) return true;

  const wantedWords = meaningful(w);
  return wantedWords.length > 0 && wantedWords.every(word => wordMatch(word, a));
}

function trackLength(track) {
  return Number(track?.info?.length || track?.length || 0);
}

function isBadVideo(track, manager) {
  const title = clean(manager.getTrackTitle(track));
  const lower = title.toLowerCase();

  if (trackLength(track) > 10 * 60 * 1000) return true;

  return /(podcast|lecture|documentary|rabbit hole|compilation|full movie|\bmovie\b|tutorial|how to|reaction|commentary|gameplay|\b\d+\s*hours?\b|10 hour|8 hour|nonstop|medley|karaoke version|instrumental version)/i.test(lower);
}

function scoreTrack(track, query, manager, source = "") {
  const title = normalize(manager.getTrackTitle(track));
  const author = normalize(manager.getTrackAuthor(track));
  const q = normalize(query);
  const wanted = meaningful(query);

  if (!title && !author) return -100000;

  let score = 0;

  if (title === q) score += 10000;
  else if (title.includes(q)) score += 7000;

  if (author === q) score += 4500;
  else if (author.includes(q)) score += 3000;

  let titleHits = 0;
  let authorHits = 0;

  for (const word of wanted) {
    if (wordMatch(word, title)) titleHits++;
    if (wordMatch(word, author)) authorHits++;
  }

  score += titleHits * 1200;
  score += authorHits * 1000;

  if (wanted.length && titleHits === wanted.length) score += 3500;
  if (wanted.length && titleHits + authorHits === wanted.length) score += 1800;

  if (source === "ytmsearch:") score += 500;
  if (source === "ytsearch:") score += 300;
  if (source === "scsearch:") score += 100;

  if (isBadVideo(track, manager)) score -= 15000;

  const length = trackLength(track);
  if (length > 0 && length <= 8 * 60 * 1000) score += 150;

  return score;
}

function looksRelevant(track, query, manager) {
  const title = normalize(manager.getTrackTitle(track));
  const author = normalize(manager.getTrackAuthor(track));
  const q = normalize(query);
  const wanted = meaningful(query);

  if (!title && !author) return false;
  if (isBadVideo(track, manager)) return false;

  if (title === q || title.includes(q)) return true;
  if (author.includes(q)) return true;

  if (!wanted.length) return true;

  const titleHits = wanted.filter(word => wordMatch(word, title)).length;
  const authorHits = wanted.filter(word => wordMatch(word, author)).length;

  /* For normal multi-word song searches, require the query to match
     either the title or the artist strongly enough, but allow natural
     metadata differences such as "Risk It All" vs "Risk It All [Official]". */
  if (wanted.length >= 2) {
    return titleHits >= Math.max(1, wanted.length - 1) ||
      titleHits + authorHits >= wanted.length;
  }

  return titleHits > 0 || authorHits > 0;
}

function getId(manager, track) {
  return manager.getTrackId(track) ||
    `${manager.getTrackTitle(track)}|${manager.getTrackAuthor(track)}`;
}

function isSpotifyUrl(value) {
  return /^https?:\/\/(open\.)?spotify\.com\//i.test(clean(value));
}

function isSoundCloudUrl(value) {
  return /^https?:\/\/(www\.)?soundcloud\.com\//i.test(clean(value));
}

function isYouTubeUrl(value) {
  return /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(clean(value));
}

async function spotifyMetadata(url) {
  try {
    const response = await fetch(
      `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`
    );

    if (!response.ok) return null;

    const data = await response.json();
    const title = clean(data?.title);
    const author = clean(data?.author_name);

    if (!title) return null;

    return { title, author };
  } catch (error) {
    console.warn(
      "⚠️ Spotify metadata lookup failed:",
      error?.message || error
    );
    return null;
  }
}

async function sourceSearch(manager, query, source, requester) {
  /*
   * NEVER pass `ytmsearch:query` as the first argument here.
   * Kazagumo then prepends its default YouTube engine and Lavalink sees:
   *     ytsearch:ytmsearch:query
   * which is exactly what the production logs showed.
   */
  return manager.kazagumo.search(query, {
    requester,
    source
  });
}

Module._load = function(request, parent, isMain) {
  const exported = originalLoad.apply(this, arguments);

  if (
    !patched &&
    typeof exported === "function" &&
    /(^|[\\/])music[\\/]MusicManager(?:\.js)?$/.test(request)
  ) {
    patched = true;

    const Original = exported;
    const originalPlay = Original.prototype.play;
    const originalEnsure247 = Original.prototype.ensure247;
    const originalPause = Original.prototype.pause;
    const originalResume = Original.prototype.resume;
    const originalSkip = Original.prototype.skip;
    const originalStop = Original.prototype.stop;
    const originalShuffle = Original.prototype.shuffle;
    const originalSetVolume = Original.prototype.setVolume;

    /* ----------------------------------------------------------
       SEARCH
       ---------------------------------------------------------- */
    Original.prototype.search = async function(query, requester = null) {
      query = clean(query);

      if (!query) return null;

      if (isSpotifyUrl(query)) {
        const meta = await spotifyMetadata(query);

        if (!meta) {
          throw new Error(
            "Spotify link could not be read. Please use a Spotify track link."
          );
        }

        const mirrorQuery = `${meta.title} ${meta.author}`.trim();
        const result = await this.search(mirrorQuery, requester);

        if (!result?.tracks?.length) {
          throw new Error(
            `Could not find a playable source for Spotify track: ${meta.title} — ${meta.author}`
          );
        }

        result.spotifyMirror = meta;
        return result;
      }

      if (isYouTubeUrl(query) || isSoundCloudUrl(query)) {
        try {
          const direct = await this.kazagumo.search(query, { requester });
          if (direct?.tracks?.length) return direct;
        } catch (error) {
          console.warn(
            "⚠️ Direct music URL failed:",
            error?.message || error
          );
        }

        return null;
      }

      const cacheKey = normalize(query);
      const cached = this.searchCache?.get(cacheKey);

      if (cached && cached.expires > Date.now()) {
        return cached.result;
      }

      const variants = [
        query,
        `"${query}"`,
        `${query} official audio`,
        `${query} song`
      ];

      const searches = [
        { source: "ytmsearch:", name: "YouTube Music" },
        { source: "ytsearch:", name: "YouTube" },
        { source: "scsearch:", name: "SoundCloud" }
      ];

      const candidates = [];
      const seen = new Set();

      for (const { source } of searches) {
        for (const variant of variants) {
          try {
            const result = await sourceSearch(
              this,
              variant,
              source,
              requester
            );

            for (const track of result?.tracks || []) {
              const id = getId(this, track);

              if (seen.has(id)) continue;
              seen.add(id);

              candidates.push({
                track,
                source,
                score: scoreTrack(track, query, this, source)
              });
            }
          } catch (error) {
            console.warn(
              `⚠️ ${source}${variant} failed:`,
              error?.message || error
            );
          }
        }
      }

      if (!candidates.length) {
        console.warn(`❌ No search results from Lavalink for: "${query}"`);
        return { tracks: [], type: "SEARCH_RESULT" };
      }

      candidates.sort((a, b) => b.score - a.score);

      const valid = candidates.filter(item =>
        looksRelevant(item.track, query, this)
      );

      const ranked = valid.length ? valid : candidates.filter(item => !isBadVideo(item.track, this));
      const best = ranked[0];

      if (!best) {
        return { tracks: [], type: "SEARCH_RESULT" };
      }

      console.log(
        `🔎 Music match: "${query}" → ${this.getTrackTitle(best.track)} — ${this.getTrackAuthor(best.track)} [${best.source}] score=${best.score}`
      );

      const result = {
        tracks: ranked.slice(0, 10).map(item => item.track),
        type: "SEARCH_RESULT"
      };

      this.searchCache?.set(cacheKey, {
        result,
        expires: Date.now() + 30000
      });

      return result;
    };

    /* ----------------------------------------------------------
       PLAY
       ---------------------------------------------------------- */
    Original.prototype.play = async function(args) {
      const result = await originalPlay.call(this, args);
      const player = result?.player || this.getPlayer(args?.guildId);

      if (!player) return result;

      const state = this.getState(args.guildId);
      const track = result?.track || result?.tracks?.[0];

      if (track) {
        state.autoplayContext = {
          query: clean(args?.query),
          artist: normalizeArtist(this.getTrackAuthor(track)),
          title: clean(this.getTrackTitle(track))
        };
        state.autoplayGeneration =
          (state.autoplayGeneration || 0) + 1;
      }

      if (
        !player.playing &&
        !player.paused &&
        !player.queue?.current &&
        (player.queue?.length || 0) > 0
      ) {
        await player.play();
      }

      await this.refreshPanel(args.guildId).catch(() => {});

      return result;
    };

    /* ----------------------------------------------------------
       CONTROLS
       ---------------------------------------------------------- */
    const wrapControl = (name, original, fallback) => {
      Original.prototype[name] = async function(guildId, ...rest) {
        const player = this.getPlayer(guildId);

        try {
          if (original) {
            const result = await original.call(this, guildId, ...rest);
            await this.refreshPanel(guildId).catch(() => {});
            return result;
          }
        } catch (error) {
          console.warn(
            `⚠️ ${name} original control failed:`,
            error?.message || error
          );
        }

        if (!player) {
          throw new Error("There is no music player in this server.");
        }

        const result = await fallback.call(this, player, guildId, ...rest);
        await this.refreshPanel(guildId).catch(() => {});
        return result;
      };
    };

    wrapControl(
      "pause",
      originalPause,
      async player => {
        if (!player.queue?.current) return false;
        await player.pause(true);
        return true;
      }
    );

    wrapControl(
      "resume",
      originalResume,
      async player => {
        if (!player.queue?.current) return false;
        await player.pause(false);
        return true;
      }
    );

    wrapControl(
      "skip",
      originalSkip,
      async player => {
        if (!player.queue?.current) return false;
        await player.skip();
        return true;
      }
    );

    wrapControl(
      "stop",
      originalStop,
      async function(player, guildId) {
        if (typeof player.queue?.clear === "function") {
          player.queue.clear();
        }

        if (typeof player.stop === "function") {
          await player.stop();
        } else if (typeof player.stopTrack === "function") {
          await player.stopTrack();
        }

        const state = this.getState(guildId);
        state.autoplayContext = null;
        state.autoplayGeneration = (state.autoplayGeneration || 0) + 1;

        return true;
      }
    );

    wrapControl(
      "shuffle",
      originalShuffle,
      async player => {
        if (typeof player.queue?.shuffle === "function") {
          player.queue.shuffle();
        }
        return true;
      }
    );

    wrapControl(
      "setVolume",
      originalSetVolume,
      async function(player, guildId, volume) {
        const level = Math.max(
          1,
          Math.min(100, Number(volume) || 70)
        );
        await player.setVolume(level);
        return level;
      }
    );

    /* ----------------------------------------------------------
       AUTOPLAY
       ---------------------------------------------------------- */
    Original.prototype.autoplayNext = async function(
      guildId,
      player = this.getPlayer(guildId)
    ) {
      if (!player) return false;

      const state = this.getState(guildId);

      if (!state.autoplay || this.autoplayBusy.has(guildId)) {
        return false;
      }

      if (
        player.playing ||
        player.paused ||
        player.queue?.current ||
        (player.queue?.length || 0) > 0
      ) {
        return false;
      }

      const context = state.autoplayContext || {};
      const artist = normalizeArtist(context.artist);
      const query = clean(context.query);

      /* Never invent a random song at startup. */
      if (!artist && !query) return false;

      this.autoplayBusy.add(guildId);
      const generation = state.autoplayGeneration || 0;
      const recent = this.recentTracks.get(guildId) || [];

      try {
        const seeds = artist
          ? [`${artist} official songs`, `${artist} songs`, artist]
          : [query, `${query} official song`];

        for (const seed of seeds) {
          for (const source of ["ytmsearch:", "ytsearch:", "scsearch:"]) {
            try {
              const result = await sourceSearch(
                this,
                seed,
                source,
                this.client.user
              );

              const candidates = (result?.tracks || [])
                .filter(track => {
                  const id = getId(this, track);
                  if (!id || recent.includes(id)) return false;
                  if (isBadVideo(track, this)) return false;

                  if (artist) {
                    return artistMatch(
                      artist,
                      this.getTrackAuthor(track)
                    );
                  }

                  return looksRelevant(track, query, this);
                })
                .sort(
                  (a, b) =>
                    scoreTrack(b, seed, this, source) -
                    scoreTrack(a, seed, this, source)
                );

              const chosen = candidates[0];

              if (!chosen) continue;

              if (
                (state.autoplayGeneration || 0) !== generation ||
                player.playing ||
                player.paused ||
                player.queue?.current ||
                (player.queue?.length || 0) > 0
              ) {
                return false;
              }

              const id = getId(this, chosen);
              if (id) {
                this.recentTracks.set(
                  guildId,
                  [...recent, id].slice(-20)
                );
              }

              player.queue.add(chosen);
              await player.play();
              await this.refreshPanel(guildId).catch(() => {});

              console.log(
                `🎯 Context autoplay queued: ${this.getTrackTitle(chosen)} — ${this.getTrackAuthor(chosen)}`
              );

              return true;
            } catch (error) {
              console.warn(
                `⚠️ Context autoplay ${source}${seed} failed:`,
                error?.message || error
              );
            }
          }
        }

        return false;
      } finally {
        this.autoplayBusy.delete(guildId);
      }
    };

    /* ----------------------------------------------------------
       24/7 RECOVERY
       ---------------------------------------------------------- */
    Original.prototype.startRecoveryLoop = function() {
      if (this.recoveryStarted) return;

      this.recoveryStarted = true;

      if (this.recoveryTimer) {
        clearInterval(this.recoveryTimer);
      }

      this.recoveryTimer = setInterval(async () => {
        try {
          const guildId = this.musicGuildId;
          if (!guildId) return;

          const player = this.getPlayer(guildId);
          const guild = this.client.guilds.cache.get(guildId);
          const me = guild?.members?.me;
          const inVoice =
            me?.voice?.channelId === this.musicVoiceChannelId;

          if (!player || player.destroyed || !inVoice) {
            await this.ensure247(guildId);
          }
        } catch (error) {
          console.warn(
            "⚠️ Music recovery check failed:",
            error?.message || error
          );
        }
      }, 30000);

      console.log("♾️ Stable music recovery loop enabled.");
    };

    /* Do not let the 24/7 startup invent music before a user chooses a song. */
    Original.prototype.ensure247 = async function(guildId) {
      const state = this.getState(guildId || this.musicGuildId);
      const oldAutoplay = state.autoplay;

      if (!state.autoplayContext) {
        state.autoplay = false;
      }

      try {
        return await originalEnsure247.call(this, guildId);
      } finally {
        state.autoplay = oldAutoplay;
      }
    };

    console.log("🛠️ DEATH Music runtime repair hooked MusicManager.");
  }

  return exported;
};
