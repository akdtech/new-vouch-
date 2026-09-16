"use strict";

/*
 * DEATH Music 24/7 runtime patch.
 *
 * Fixes:
 * 1) /play must not select an unrelated first YouTube result;
 * 2) autoplay follows the selected artist/search;
 * 3) concurrent 24/7 startup calls do not create duplicate players.
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
  if (a === w || a.includes(w) || w.includes(a)) return true;

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
  "the", "a", "an", "and", "or", "of", "to", "for", "with", "it",
  "is", "in", "on", "at", "by", "from", "official", "music", "song",
  "songs", "video", "audio", "lyrics", "lyric", "full", "hd", "4k",
  "remix", "live", "version", "original"
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
  const combined = `${title} ${author}`.trim();

  if (!title && !author) return -1000;

  let score = 0;

  if (queryNorm && title === queryNorm) score += 1000;
  else if (queryNorm && title.includes(queryNorm)) score += 850;

  if (queryNorm && author === queryNorm) score += 700;
  else if (queryNorm && author.includes(queryNorm)) score += 600;

  const titleHits = tokens.filter(token => title.includes(token)).length;
  const authorHits = tokens.filter(token => author.includes(token)).length;
  const combinedHits = tokens.filter(token => combined.includes(token)).length;

  score += titleHits * 80;
  score += authorHits * 120;
  score += combinedHits * 20;

  if (tokens.length && titleHits === tokens.length) score += 500;
  if (tokens.length && combinedHits === tokens.length) score += 350;

  if (/(shorts?|tiktok|tutorial|how to|funny|reaction|compilation|podcast|lecture)/i.test(title)) {
    score -= 250;
  }

  return score;
}

function isValidSearchMatch(track, query, manager) {
  const title = normalize(manager.getTrackTitle(track));
  const author = normalize(manager.getTrackAuthor(track));
  const queryNorm = normalize(query);
  const tokens = queryTokens(query);

  if (!title && !author) return false;
  if (queryNorm && (title === queryNorm || title.includes(queryNorm))) return true;
  if (queryNorm && author.includes(queryNorm)) return true;

  // For multi-word searches such as "perfect ed sheeran", allow the
  // words to be split between title and artist metadata.
  if (tokens.length >= 2) {
    const titleHits = tokens.filter(token => title.includes(token)).length;
    const authorHits = tokens.filter(token => author.includes(token)).length;
    return titleHits + authorHits >= tokens.length;
  }

  // Single meaningful word: it must actually appear in title or artist.
  return tokens.length === 1 && (title.includes(tokens[0]) || author.includes(tokens[0]));
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

    const originalEnsure247 = exported.prototype.ensure247;

    exported.prototype.ensure247 = async function(guildId) {
      guildId = guildId || this.musicGuildId;
      if (!guildId) return originalEnsure247.call(this, guildId);

      if (!this._ensure247Locks) this._ensure247Locks = new Map();
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
    // VALIDATED SEARCH
    // ------------------------------------------------------------
    const originalSearch = exported.prototype.search;

    exported.prototype.search = async function(query, requester = null) {
      query = clean(query);

      if (!query || this.isYouTubeUrl(query)) {
        return originalSearch.call(this, query, requester);
      }

      // Try several forms because Lavalink/YouTube search providers can
      // return a poor first page for a short song title.
      const variants = [
        query,
        `"${query}"`,
        `${query} song`,
        `${query} official audio`
      ];

      const identifiers = [];
      for (const variant of variants) {
        identifiers.push(`ytmsearch:${variant}`);
        identifiers.push(`ytsearch:${variant}`);
      }

      const allTracks = [];
      const seen = new Set();

      for (const identifier of identifiers) {
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
        return { tracks: [], type: "SEARCH_RESULT" };
      }

      const ranked = allTracks
        .map((track, index) => ({
          track,
          score: scoreTrack(track, query, this),
          index
        }))
        .sort((a, b) => b.score - a.score || a.index - b.index);

      const valid = ranked.filter(item =>
        isValidSearchMatch(item.track, query, this)
      );

      const best = valid[0];

      // IMPORTANT: never fall back to the old "first result" behavior.
      // If YouTube/Lavalink cannot find a meaningful match, fail cleanly
      // instead of playing a completely unrelated video.
      if (!best) {
        console.warn(`❌ No reliable music match for: "${query}"`);
        return { tracks: [], type: "SEARCH_RESULT" };
      }

      const orderedTracks = [
        best.track,
        ...ranked
          .filter(item => item !== best && isValidSearchMatch(item.track, query, this))
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
    // REMEMBER USER SEARCH + ARTIST FOR AUTOPLAY
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
    // CONTEXT-AWARE AUTOPLAY
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
      ) return false;

      this.autoplayBusy.add(guildId);
      const generation = state.autoplayGeneration || 0;

      try {
        const recent = this.recentTracks.get(guildId) || [];
        const context = state.autoplayContext || {};
        const artist = normalizeArtist(context.artist);
        const query = clean(context.query);

        const seeds = artist
          ? [`${artist} songs`, artist]
          : query
            ? [query]
            : ["popular music"];

        let chosen = null;

        for (const seed of seeds) {
          for (const identifier of [`ytmsearch:${seed}`, `ytsearch:${seed}`]) {
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

                if (metadataMatches.length) candidates = metadataMatches;
                else {
                  const titleMatches = candidates.filter(track =>
                    titleLooksRelevant(this.getTrackTitle(track), artist)
                  );
                  if (titleMatches.length) candidates = titleMatches;
                  else continue;
                }
              }

              const sensible = candidates.filter(track =>
                !/(shorts?|tiktok|tutorial|how to|funny|reaction|compilation|podcast|lecture)/i
                  .test(this.getTrackTitle(track))
              );

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

        if (!chosen || (state.autoplayGeneration || 0) !== generation) return false;

        if (
          player.playing ||
          player.paused ||
          player.queue?.current ||
          (player.queue?.length || 0) > 0
        ) return false;

        const id = trackId(this, chosen);
        if (id) this.recentTracks.set(guildId, [...recent, id].slice(-20));

        player.queue.add(chosen);
        if (!player.playing && !player.paused) await player.play();

        console.log(
          `🎯 Context autoplay queued: ${this.getTrackTitle(chosen)} — ${this.getTrackAuthor(chosen)}`
        );

        return true;
      } catch (error) {
        console.error("❌ Context autoplay error:", error?.message || error);
        return false;
      } finally {
        this.autoplayBusy.delete(guildId);
      }
    };
  }

  return exported;
};
