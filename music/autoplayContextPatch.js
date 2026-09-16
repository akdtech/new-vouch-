"use strict";

/*
 * DEATH Music 24/7 runtime patch.
 *
 * Fixes:
 * 1) search results must match the user's requested song/artist;
 * 2) autoplay must follow the selected artist/search;
 * 3) concurrent 24/7 startup calls must not create duplicate players.
 */
const Module = require("module");
const originalLoad = Module._load;

let patched = false;

function clean(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalize(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^a-z0-9'& ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeArtist(value) {
  return clean(value)
    .replace(/\s*-\s*topic$/i, "")
    .replace(/\s*\|\s*topic$/i, "")
    .replace(/\s*official$/i, "")
    .replace(/\s*vevo$/i, "")
    .trim();
}

function isGenericArtist(artist) {
  const value = normalizeArtist(artist).toLowerCase();
  return !value || [
    "unknown artist",
    "unknown",
    "various artists",
    "various",
    "youtube",
    "youtube music",
    "topic"
  ].includes(value);
}

function artistMatches(actual, wanted) {
  const a = normalizeArtist(actual).toLowerCase();
  const w = normalizeArtist(wanted).toLowerCase();

  if (!a || !w) return false;
  if (a === w) return true;
  if (a.includes(w)) return true;
  if (w.includes(a)) return true;

  const parts = a.split(/\s*(?:,|&|feat\.?|ft\.?|x)\s*/i);
  return parts.some(part => part === w || part.includes(w) || w.includes(part));
}

function titleLooksRelevant(title, artist) {
  const t = normalize(title);
  const a = normalize(artist);
  if (!t || !a) return false;

  const words = a.split(" ").filter(Boolean);
  const hits = words.filter(word => t.includes(word)).length;
  return hits >= Math.max(1, Math.ceil(words.length * 0.5));
}

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "for", "with", "official",
  "music", "song", "songs", "video", "audio", "lyrics", "lyric", "full",
  "hd", "4k", "remix", "live", "version", "original"
]);

function queryTokens(query) {
  return normalize(query)
    .split(" ")
    .filter(token => token.length >= 2 && !STOP_WORDS.has(token));
}

function scoreTrack(track, query, manager) {
  const title = normalize(manager.getTrackTitle(track));
  const author = normalize(manager.getTrackAuthor(track));
  const queryNorm = normalize(query);
  const tokens = queryTokens(query);

  if (!title && !author) return -1000;

  let score = 0;

  if (queryNorm && title === queryNorm) score += 100;
  if (queryNorm && author === queryNorm) score += 90;
  if (queryNorm && title.includes(queryNorm)) score += 60;
  if (queryNorm && author.includes(queryNorm)) score += 80;

  for (const token of tokens) {
    if (author === token) score += 55;
    else if (author.includes(token)) score += 35;

    if (title === token) score += 30;
    else if (title.includes(token)) score += 20;
  }

  // If the query contains a likely artist name, matching author metadata
  // must beat an unrelated first YouTube result.
  if (tokens.length >= 2) {
    const authorHits = tokens.filter(token => author.includes(token)).length;
    const titleHits = tokens.filter(token => title.includes(token)).length;
    score += authorHits * 25 + titleHits * 5;
  }

  if (/(shorts?|tiktok|tutorial|how to|funny|reaction|compilation)/i.test(title)) {
    score -= 80;
  }

  return score;
}

function trackId(manager, track) {
  return manager.getTrackId(track);
}

Module._load = function(request, parent, isMain) {
  const exported = originalLoad.apply(this, arguments);

  if (
    !patched &&
    typeof exported === "function" &&
    /(^|[\\/])music[\\/]MusicManager$/.test(request)
  ) {
    patched = true;

    // ------------------------------------------------------------
    // Prevent concurrent 24/7 startup/recovery calls from creating
    // multiple Kazagumo players for the same guild.
    // ------------------------------------------------------------
    const originalEnsure247 = exported.prototype.ensure247;

    exported.prototype.ensure247 = async function(guildId) {
      guildId = guildId || this.musicGuildId;

      if (!guildId) return originalEnsure247.call(this, guildId);

      if (!this._ensure247Locks) {
        this._ensure247Locks = new Map();
      }

      const existing = this._ensure247Locks.get(guildId);
      if (existing) return existing;

      const promise = originalEnsure247.call(this, guildId);
      this._ensure247Locks.set(guildId, promise);

      try {
        return await promise;
      } finally {
        if (this._ensure247Locks.get(guildId) === promise) {
          this._ensure247Locks.delete(guildId);
        }
      }
    };

    // ------------------------------------------------------------
    // Replace the search selection logic so a bad first YouTube result
    // cannot turn /play "perfect ed sheeran" into a Lil Nas X track.
    // ------------------------------------------------------------
    const originalSearch = exported.prototype.search;

    exported.prototype.search = async function(query, requester = null) {
      query = clean(query);
      if (!query || this.isYouTubeUrl(query)) {
        return originalSearch.call(this, query, requester);
      }

      const searches = [
        `ytmsearch:${query}`,
        `ytsearch:${query}`
      ];

      const allTracks = [];
      const seen = new Set();

      for (const identifier of searches) {
        try {
          const result = await this.kazagumo.search(identifier, { requester });
          if (!result?.tracks?.length) continue;

          for (const track of result.tracks) {
            const id = trackId(this, track);
            const key = id || `${this.getTrackTitle(track)}|${this.getTrackAuthor(track)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            allTracks.push(track);
          }
        } catch (error) {
          console.warn(
            `⚠️ Validated music search failed for ${identifier}:`,
            error?.message || error
          );
        }
      }

      if (!allTracks.length) {
        return originalSearch.call(this, query, requester);
      }

      const ranked = allTracks
        .map((track, index) => ({
          track,
          score: scoreTrack(track, query, this),
          index
        }))
        .sort((a, b) => b.score - a.score || a.index - b.index);

      const best = ranked[0];

      // Only accept the validated winner when it has meaningful overlap.
      // Otherwise preserve the existing search behavior.
      if (!best || best.score <= 0) {
        return originalSearch.call(this, query, requester);
      }

      const orderedTracks = [
        best.track,
        ...ranked
          .slice(1)
          .map(item => item.track)
      ];

      console.log(
        `🔎 Validated search: "${query}" → ${this.getTrackTitle(best.track)} — ${this.getTrackAuthor(best.track)} (score ${best.score})`
      );

      return {
        tracks: orderedTracks,
        type: "SEARCH_RESULT"
      };
    };

    // ------------------------------------------------------------
    // Remember the user's actual /play query and selected artist.
    // ------------------------------------------------------------
    const originalPlay = exported.prototype.play;

    exported.prototype.play = async function(args) {
      const guildId = args?.guildId;
      const state = guildId ? this.getState(guildId) : null;
      const query = clean(args?.query);

      if (state && query) {
        state.autoplayContext = {
          query,
          artist: clean(state.autoplayContext?.artist),
          title: clean(state.autoplayContext?.title)
        };
      }

      const result = await originalPlay.call(this, args);

      if (state) {
        const track = result?.track || result?.tracks?.[0] || args?.track || null;
        const rawArtist = track ? this.getTrackAuthor(track) : "";
        const artist = normalizeArtist(rawArtist);

        state.autoplayContext = {
          query,
          artist: isGenericArtist(artist) ? "" : artist,
          title: clean(track ? this.getTrackTitle(track) : "")
        };
      }

      return result;
    };

    // ------------------------------------------------------------
    // Context-aware autoplay.
    // ------------------------------------------------------------
    exported.prototype.autoplayNext = async function(
      guildId,
      player = this.getPlayer(guildId)
    ) {
      if (!player) return false;

      const state = this.getState(guildId);
      if (!state.autoplay) return false;
      if (this.autoplayBusy.has(guildId)) return false;

      if (
        player.playing ||
        player.paused ||
        player.queue?.current ||
        (player.queue?.length || 0) > 0
      ) {
        return false;
      }

      this.autoplayBusy.add(guildId);
      const generation = state.autoplayGeneration || 0;

      try {
        const recent = this.recentTracks.get(guildId) || [];
        const context = state.autoplayContext || {};
        const artist = normalizeArtist(context.artist);
        const query = clean(context.query);

        const seeds = [];
        if (artist) {
          seeds.push(`${artist} songs`);
          seeds.push(artist);
        } else if (query) {
          seeds.push(query);
        } else {
          seeds.push("popular music");
        }

        let chosen = null;

        for (const seed of seeds) {
          const identifiers = [
            `ytmsearch:${seed}`,
            `ytsearch:${seed}`
          ];

          for (const identifier of identifiers) {
            try {
              const result = await this.kazagumo.search(identifier, {
                requester: this.client.user
              });

              if (!result?.tracks?.length) continue;

              let candidates = result.tracks.filter(track => {
                const id = trackId(this, track);
                return id && !recent.includes(id);
              });

              if (!candidates.length) continue;

              if (artist) {
                const metadataMatches = candidates.filter(track =>
                  artistMatches(this.getTrackAuthor(track), artist)
                );

                if (metadataMatches.length) {
                  candidates = metadataMatches;
                } else {
                  const titleMatches = candidates.filter(track =>
                    titleLooksRelevant(this.getTrackTitle(track), artist)
                  );

                  if (titleMatches.length) {
                    candidates = titleMatches;
                  } else {
                    continue;
                  }
                }
              }

              const sensible = candidates.filter(track => {
                const title = this.getTrackTitle(track).toLowerCase();
                return !/(shorts?|tiktok|tutorial|how to|funny|reaction)/i.test(title);
              });

              if (sensible.length) candidates = sensible;

              chosen = candidates[Math.floor(Math.random() * candidates.length)];
              break;
            } catch (error) {
              console.warn(
                `⚠️ Context autoplay search failed for ${identifier}:`,
                error?.message || error
              );
            }
          }

          if (chosen) break;
        }

        if (!chosen || (state.autoplayGeneration || 0) !== generation) {
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

        const id = trackId(this, chosen);
        if (id) {
          this.recentTracks.set(guildId, [...recent, id].slice(-20));
        }

        player.queue.add(chosen);

        if (!player.playing && !player.paused) {
          await player.play();
        }

        console.log(
          `🎯 Context autoplay queued: ${this.getTrackTitle(chosen)} — ${this.getTrackAuthor(chosen)}`
        );

        return true;
      } catch (error) {
        console.error(
          "❌ Context autoplay error:",
          error?.message || error
        );
        return false;
      } finally {
        this.autoplayBusy.delete(guildId);
      }
    };
  }

  return exported;
};
