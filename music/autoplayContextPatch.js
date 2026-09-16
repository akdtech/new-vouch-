"use strict";

/*
 * DEATH Music 24/7 runtime patch.
 *
 * Fixes:
 * 1) /play must not select unrelated YouTube results;
 * 2) tolerate small typing mistakes in song/artist searches;
 * 3) autoplay stays in the selected artist/search context;
 * 4) reject long/spam/non-music videos from autoplay;
 * 5) prevent concurrent 24/7 startup calls from creating duplicate players.
 */
const Module = require("module");
const originalLoad = Module._load;
let patched = false;

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
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
    "unknown artist", "unknown", "various artists", "various",
    "youtube", "youtube music", "topic"
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

function levenshtein(a, b) {
  a = String(a || "");
  b = String(b || "");
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const cur = [i + 1];
    for (let j = 0; j < b.length; j++) {
      cur.push(Math.min(
        cur[j] + 1,
        prev[j + 1] + 1,
        prev[j] + (a[i] === b[j] ? 0 : 1)
      ));
    }
    prev = cur;
  }
  return prev[b.length];
}

function fuzzyTokenMatches(token, words) {
  if (!token) return false;
  return words.some(word => {
    if (word === token || word.includes(token) || token.includes(word)) return true;
    const maxDistance = token.length >= 7 ? 2 : 1;
    return Math.max(token.length, word.length) >= 4 &&
      levenshtein(token, word) <= maxDistance;
  });
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

function trackLength(track) {
  return Number(track?.info?.length || track?.length || 0);
}

function isBadVideo(track, manager) {
  const title = clean(manager.getTrackTitle(track));
  const lower = title.toLowerCase();
  const length = trackLength(track);

  // Music autoplay should not jump into hour-long videos, podcasts,
  // documentaries, mixes, compilations, or hashtag/spam uploads.
  if (length > 10 * 60 * 1000) return true;
  if (/#\w+/.test(title)) return true;
  if (/(podcast|lecture|documentary|documentary|rabbit hole|compilation|full movie|movie|mix \d+ hour|\b\d+ hours?\b|tutorial|how to|reaction|commentary|gameplay)/i.test(lower)) return true;
  if (/(\[?\s*(official|audio|music video|lyrics?)\s*\]?)/i.test(lower)) return false;
  return false;
}

function scoreTrack(track, query, manager) {
  const title = normalize(manager.getTrackTitle(track));
  const author = normalize(manager.getTrackAuthor(track));
  const queryNorm = normalize(query);
  const tokens = queryTokens(query);
  const titleWords = title.split(" ").filter(Boolean);
  const authorWords = author.split(" ").filter(Boolean);
  if (!title && !author) return -1000;

  let score = 0;
  if (queryNorm && title === queryNorm) score += 1500;
  else if (queryNorm && title.includes(queryNorm)) score += 1100;

  if (queryNorm && author === queryNorm) score += 900;
  else if (queryNorm && author.includes(queryNorm)) score += 750;

  const titleHits = tokens.filter(token => fuzzyTokenMatches(token, titleWords)).length;
  const authorHits = tokens.filter(token => fuzzyTokenMatches(token, authorWords)).length;
  score += titleHits * 140;
  score += authorHits * 160;
  if (tokens.length && titleHits === tokens.length) score += 700;
  if (tokens.length && titleHits + authorHits >= tokens.length) score += 450;

  if (isBadVideo(track, manager)) score -= 2000;
  return score;
}

function isValidSearchMatch(track, query, manager) {
  const title = normalize(manager.getTrackTitle(track));
  const author = normalize(manager.getTrackAuthor(track));
  const queryNorm = normalize(query);
  const tokens = queryTokens(query);
  const titleWords = title.split(" ").filter(Boolean);
  const authorWords = author.split(" ").filter(Boolean);

  if (!title && !author) return false;
  if (queryNorm && (title === queryNorm || title.includes(queryNorm))) return true;
  if (queryNorm && author.includes(queryNorm)) return true;

  if (tokens.length >= 2) {
    return tokens.every(token =>
      fuzzyTokenMatches(token, titleWords) || fuzzyTokenMatches(token, authorWords)
    );
  }

  return tokens.length === 1 && (
    fuzzyTokenMatches(tokens[0], titleWords) ||
    fuzzyTokenMatches(tokens[0], authorWords)
  );
}

function trackId(manager, track) {
  return manager.getTrackId(track);
}

function autoplayCandidate(track, manager, artist) {
  if (!track || isBadVideo(track, manager)) return false;
  if (artist) {
    if (artistMatches(manager.getTrackAuthor(track), artist)) return true;
    if (titleLooksRelevant(manager.getTrackTitle(track), artist)) return true;
    return false;
  }
  return true;
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
      try { return await promise; }
      finally {
        if (this._ensure247Locks.get(guildId) === promise) this._ensure247Locks.delete(guildId);
      }
    };

    const originalSearch = exported.prototype.search;
    exported.prototype.search = async function(query, requester = null) {
      query = clean(query);
      if (!query || this.isYouTubeUrl(query)) return originalSearch.call(this, query, requester);

      const variants = [query, `"${query}"`, `${query} song`, `${query} official audio`];
      const identifiers = [];
      for (const variant of variants) {
        identifiers.push(`ytmsearch:${variant}`, `ytsearch:${variant}`);
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
          console.warn(`⚠️ Validated music search failed for ${identifier}:`, error?.message || error);
        }
      }

      if (!allTracks.length) return { tracks: [], type: "SEARCH_RESULT" };

      const ranked = allTracks
        .map((track, index) => ({ track, score: scoreTrack(track, query, this), index }))
        .sort((a, b) => b.score - a.score || a.index - b.index);
      const valid = ranked.filter(item => isValidSearchMatch(item.track, query, this));
      const best = valid[0];

      if (!best) {
        console.warn(`❌ No reliable music match for: "${query}"`);
        return { tracks: [], type: "SEARCH_RESULT" };
      }

      console.log(`🔎 Validated search: "${query}" → ${this.getTrackTitle(best.track)} — ${this.getTrackAuthor(best.track)} (score ${best.score})`);
      return {
        tracks: [
          best.track,
          ...ranked
            .filter(item => item !== best && isValidSearchMatch(item.track, query, this))
            .map(item => item.track)
        ],
        type: "SEARCH_RESULT"
      };
    };

    const originalPlay = exported.prototype.play;
    exported.prototype.play = async function(args) {
      const guildId = args?.guildId;
      const state = guildId ? this.getState(guildId) : null;
      const query = clean(args?.query);
      if (state && query) state.autoplayContext = { query, artist: "", title: "" };

      const result = await originalPlay.call(this, args);
      if (state) {
        const track = result?.track || result?.tracks?.[0] || args?.track || null;
        const artist = normalizeArtist(track ? this.getTrackAuthor(track) : "");
        state.autoplayContext = {
          query,
          artist: isGenericArtist(artist) ? "" : artist,
          title: clean(track ? this.getTrackTitle(track) : "")
        };
      }
      return result;
    };

    exported.prototype.autoplayNext = async function(guildId, player = this.getPlayer(guildId)) {
      if (!player) return false;
      const state = this.getState(guildId);
      if (!state.autoplay || this.autoplayBusy.has(guildId)) return false;
      if (player.playing || player.paused || player.queue?.current || (player.queue?.length || 0) > 0) return false;

      this.autoplayBusy.add(guildId);
      const generation = state.autoplayGeneration || 0;
      try {
        const recent = this.recentTracks.get(guildId) || [];
        const context = state.autoplayContext || {};
        const artist = normalizeArtist(context.artist);
        const query = clean(context.query);
        const seeds = artist
          ? [`${artist} official songs`, `${artist} songs`, artist]
          : query
            ? [`${query} official song`, `${query} music`]
            : ["popular music official audio"];

        let chosen = null;
        for (const seed of seeds) {
          for (const identifier of [`ytmsearch:${seed}`, `ytsearch:${seed}`]) {
            try {
              const result = await this.kazagumo.search(identifier, { requester: this.client.user });
              if (!result?.tracks?.length) continue;
              let candidates = result.tracks.filter(track => {
                const id = trackId(this, track);
                return id && !recent.includes(id) && autoplayCandidate(track, this, artist);
              });
              if (!candidates.length) continue;

              candidates.sort((a, b) => scoreTrack(b, artist || query || "", this) - scoreTrack(a, artist || query || "", this));
              chosen = candidates[0];
              break;
            } catch (error) {
              console.warn(`⚠️ Context autoplay search failed for ${identifier}:`, error?.message || error);
            }
          }
          if (chosen) break;
        }

        if (!chosen || (state.autoplayGeneration || 0) !== generation) return false;
        if (player.playing || player.paused || player.queue?.current || (player.queue?.length || 0) > 0) return false;

        const id = trackId(this, chosen);
        if (id) this.recentTracks.set(guildId, [...recent, id].slice(-20));
        player.queue.add(chosen);
        if (!player.playing && !player.paused) await player.play();

        console.log(`🎯 Context autoplay queued: ${this.getTrackTitle(chosen)} — ${this.getTrackAuthor(chosen)}`);
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
