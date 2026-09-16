"use strict";

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

function tokens(value) {
  return normalize(value)
    .split(" ")
    .filter(x => x.length >= 2);
}

function distance(a, b) {
  a = String(a || "");
  b = String(b || "");
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const old = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      prev = old;
    }
  }
  return row[b.length];
}

function fuzzyTokenMatch(wanted, actual) {
  wanted = normalize(wanted);
  actual = normalize(actual);
  if (!wanted || !actual) return false;
  if (wanted === actual || actual.includes(wanted) || wanted.includes(actual)) return true;
  const max = wanted.length <= 4 ? 1 : wanted.length <= 7 ? 2 : 3;
  return distance(wanted, actual) <= max;
}

function tokenMatchesAny(wanted, text) {
  return tokens(text).some(actual => fuzzyTokenMatch(wanted, actual));
}

function artistMatches(actual, wanted) {
  const wantedTokens = tokens(wanted);
  const actualText = normalize(actual);
  if (!wantedTokens.length || !actualText) return false;
  return wantedTokens.every(w => tokenMatchesAny(w, actualText));
}

const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "for", "with", "it",
  "is", "in", "on", "at", "by", "from", "official", "music", "song",
  "songs", "video", "audio", "lyrics", "lyric", "full", "hd", "4k",
  "remix", "live", "version", "original"
]);

function meaningful(value) {
  return tokens(value).filter(x => !STOP.has(x));
}

function trackScore(track, query, manager) {
  const title = normalize(manager.getTrackTitle(track));
  const author = normalize(manager.getTrackAuthor(track));
  const wanted = meaningful(query);
  let score = 0;

  for (const word of wanted) {
    if (tokenMatchesAny(word, title)) score += 220;
    if (tokenMatchesAny(word, author)) score += 180;
  }

  const exact = normalize(query);
  if (title === exact) score += 1500;
  else if (title.includes(exact)) score += 1200;

  if (wanted.length && wanted.every(w => tokenMatchesAny(w, title))) score += 900;
  if (wanted.length && wanted.every(w => tokenMatchesAny(w, `${title} ${author}`))) score += 500;

  if (/(shorts?|tiktok|tutorial|how to|funny|reaction|compilation|podcast|lecture)/i.test(title)) {
    score -= 500;
  }

  return score;
}

function validMatch(track, query, manager) {
  const title = normalize(manager.getTrackTitle(track));
  const author = normalize(manager.getTrackAuthor(track));
  const wanted = meaningful(query);
  if (!title && !author) return false;

  const exact = normalize(query);
  if (title === exact || title.includes(exact)) return true;

  if (wanted.length === 0) return Boolean(title);

  // Every meaningful search word must be represented in the title/artist.
  // A small Levenshtein tolerance allows normal typos such as "brunu" -> "bruno".
  const combined = `${title} ${author}`;
  return wanted.every(word => tokenMatchesAny(word, combined));
}

Module._load = function(request, parent, isMain) {
  const exported = originalLoad.apply(this, arguments);

  if (!patched && typeof exported === "function" && /(^|[\\/])music[\\/]MusicManager$/.test(request)) {
    patched = true;

    const originalEnsure247 = exported.prototype.ensure247;
    exported.prototype.ensure247 = async function(guildId) {
      guildId = guildId || this.musicGuildId;
      if (!guildId) return originalEnsure247.call(this, guildId);
      if (!this._musicEnsureLocks) this._musicEnsureLocks = new Map();
      const existing = this._musicEnsureLocks.get(guildId);
      if (existing) return existing;
      const promise = originalEnsure247.call(this, guildId);
      this._musicEnsureLocks.set(guildId, promise);
      try { return await promise; }
      finally {
        if (this._musicEnsureLocks.get(guildId) === promise) this._musicEnsureLocks.delete(guildId);
      }
    };

    const originalSearch = exported.prototype.search;
    exported.prototype.search = async function(query, requester = null) {
      query = clean(query);
      if (!query || this.isYouTubeUrl(query)) return originalSearch.call(this, query, requester);

      const variants = [
        query,
        `"${query}"`,
        `${query} song`,
        `${query} official audio`,
        `${query} official`
      ];
      const tracks = [];
      const seen = new Set();

      for (const variant of variants) {
        for (const prefix of ["ytmsearch:", "ytsearch:"]) {
          try {
            const result = await this.kazagumo.search(`${prefix}${variant}`, { requester });
            for (const track of result?.tracks || []) {
              const id = this.getTrackId(track);
              const key = id || `${this.getTrackTitle(track)}|${this.getTrackAuthor(track)}`;
              if (seen.has(key)) continue;
              seen.add(key);
              tracks.push(track);
            }
          } catch (error) {
            console.warn(`⚠️ Music search failed for ${prefix}${variant}:`, error?.message || error);
          }
        }
      }

      const ranked = tracks
        .map((track, index) => ({ track, score: trackScore(track, query, this), index }))
        .sort((a, b) => b.score - a.score || a.index - b.index);

      const valid = ranked.filter(x => validMatch(x.track, query, this));
      if (!valid.length) {
        console.warn(`❌ No reliable music match for: "${query}"`);
        return { tracks: [], type: "SEARCH_RESULT" };
      }

      const best = valid[0];
      console.log(`🔎 Music search: "${query}" → ${this.getTrackTitle(best.track)} — ${this.getTrackAuthor(best.track)} (score ${best.score})`);
      return {
        tracks: [best.track, ...valid.slice(1).map(x => x.track)],
        type: "SEARCH_RESULT"
      };
    };

    const originalPlay = exported.prototype.play;
    exported.prototype.play = async function(args) {
      const guildId = args?.guildId;
      const query = clean(args?.query);
      const state = guildId ? this.getState(guildId) : null;
      const result = await originalPlay.call(this, args);

      if (state && result?.track) {
        const artist = clean(this.getTrackAuthor(result.track));
        const title = clean(this.getTrackTitle(result.track));
        state.autoplayContext = {
          query,
          artist,
          title
        };
        console.log(`🎯 Autoplay context: ${title} — ${artist}`);
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
        const context = state.autoplayContext || {};
        const artist = clean(context.artist);
        const query = clean(context.query);
        const seeds = artist ? [`${artist} songs`, `${artist} official songs`, artist] : query ? [`${query} songs`, query] : ["popular music"];
        const recent = this.recentTracks.get(guildId) || [];
        let chosen = null;

        for (const seed of seeds) {
          for (const prefix of ["ytmsearch:", "ytsearch:"]) {
            try {
              const result = await this.kazagumo.search(`${prefix}${seed}`, { requester: this.client.user });
              let candidates = (result?.tracks || []).filter(track => {
                const id = this.getTrackId(track);
                return id && !recent.includes(id) && !/(shorts?|tiktok|tutorial|reaction|podcast|lecture)/i.test(this.getTrackTitle(track));
              });
              if (!candidates.length) continue;

              if (artist) {
                const sameArtist = candidates.filter(track => artistMatches(this.getTrackAuthor(track), artist));
                if (sameArtist.length) candidates = sameArtist;
                else continue;
              }

              candidates.sort((a, b) => trackScore(b, seed, this) - trackScore(a, seed, this));
              chosen = candidates[0];
              if (chosen) break;
            } catch (error) {
              console.warn(`⚠️ Autoplay search failed for ${prefix}${seed}:`, error?.message || error);
            }
          }
          if (chosen) break;
        }

        if (!chosen || (state.autoplayGeneration || 0) !== generation) return false;
        if (player.playing || player.paused || player.queue?.current || (player.queue?.length || 0) > 0) return false;

        const id = this.getTrackId(chosen);
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
