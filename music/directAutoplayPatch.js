"use strict";

/*
 * DEATH direct autoplay intelligence.
 *
 * Autoplay is deliberately restricted to normal individual songs. It must not
 * select long mixes, playlists, albums, compilations, radio uploads, or other
 * huge videos. After /play, it follows the requested artist/title/search
 * context so the station stays musically related.
 */
const MusicManager = require("./DirectMusicManager");

// Normal-song policy: anything over 8 minutes is rejected from autoplay.
const MAX_AUTOPLAY_MS = 8 * 60 * 1000;
const IDEAL_MIN_MS = 90 * 1000;
const IDEAL_MAX_MS = 6 * 60 * 1000;

const BAD_TITLE = /\b(\d+\s*(?:hour|hr)s?|hour\s*mix|\bmix\b|playlist|compilation|continuous|nonstop|radio|medley|full\s*album|album|collection|lofi\s*mix|sleep\s*music|long\s*version)\b/i;
const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "for", "in", "on", "at",
  "with", "from", "is", "it", "my", "your", "me", "you", "official",
  "video", "audio", "music", "song", "songs", "lyrics", "lyric", "remix",
  "edit", "version", "full", "hd", "4k", "feat", "ft"
]);

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function artistIsUseful(artist) {
  const value = clean(artist).toLowerCase();
  return value && ![
    "unknown artist", "various artists", "various", "youtube", "youtube music",
    "topic", "unknown"
  ].includes(value);
}

function words(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gi, " ")
    .split(/\s+/)
    .filter(word => word.length >= 3 && !STOP_WORDS.has(word));
}

function artistMatches(a, b) {
  const left = clean(a).toLowerCase();
  const right = clean(b).toLowerCase();
  return !!left && !!right && (left === right || left.includes(right) || right.includes(left));
}

function trackId(track) {
  return track?.identifier || track?.id || track?.url;
}

function isAutoplayCandidate(track) {
  const title = clean(track?.title);
  const length = Number(track?.length || 0);
  return Number.isFinite(length) && length > 0 && length <= MAX_AUTOPLAY_MS && !BAD_TITLE.test(title);
}

function candidateScore(track, context, recent) {
  const title = clean(track?.title);
  const artist = clean(track?.author || track?.uploader);
  const length = Number(track?.length || 0);
  const haystack = `${title} ${artist}`.toLowerCase();
  let score = 0;

  if (artistMatches(artist, context.artist)) score += 150;
  for (const word of context.words) {
    if (haystack.includes(word)) score += 20;
  }

  if (length >= IDEAL_MIN_MS && length <= IDEAL_MAX_MS) score += 25;
  else if (length > IDEAL_MAX_MS) score -= 5;
  else score -= 5;

  const id = trackId(track);
  if (id && recent.includes(id)) score -= 1000;
  return score;
}

const originalPlay = MusicManager.prototype.play;

MusicManager.prototype.play = async function patchedPlay(args) {
  const result = await originalPlay.call(this, args);
  const state = this.getState(args.guildId);
  const track = result?.track || state.current || null;
  const title = clean(track?.title);
  const artist = clean(track?.author || track?.uploader);
  const query = clean(args?.query);

  // Learn from the actual requested song, not just the raw search text.
  state.autoplayContext = {
    artist: artistIsUseful(artist) ? artist : "",
    title,
    query,
    words: [...new Set([...words(title), ...words(query)])].slice(0, 8)
  };

  console.log(`🎯 Autoplay context: ${artist || "search/genre"}${title ? ` — ${title}` : ""}`);
  return result;
};

MusicManager.prototype.autoplayNext = async function contextAwareAutoplay(guildId) {
  const state = this.getState(guildId);
  const player = this.players.get(guildId);
  if (!player || !state.autoplay || state.intentionalLeave || state.autoplayBusy) return false;
  if (state.current || state.queue.length) return false;

  state.autoplayBusy = true;
  try {
    const context = state.autoplayContext || {};
    const recent = Array.isArray(state.recent) ? state.recent : [];
    const artist = clean(context.artist);
    const contextWords = Array.isArray(context.words)
      ? context.words
      : words(`${context.title} ${context.query}`);

    // Artist is the strongest signal. Title/search words keep it related even
    // when the platform does not expose useful genre metadata.
    const queries = [];
    if (artist) {
      queries.push(`${artist} songs`);
      if (contextWords.length) queries.push(`${artist} ${contextWords.slice(0, 2).join(" ")} songs`);
    }
    if (contextWords.length) {
      queries.push(`${contextWords.slice(0, 3).join(" ")} songs`);
      if (context.query) queries.push(`${context.query} similar songs`);
    }
    if (!queries.length) queries.push("popular songs");

    let chosen = null;
    let chosenScore = -Infinity;

    for (const query of [...new Set(queries)]) {
      try {
        const result = await this.search(query, this.client.user);
        const candidates = (result?.tracks || [])
          .filter(isAutoplayCandidate)
          .filter(track => !recent.includes(trackId(track)))
          .map(track => ({
            track,
            score: candidateScore(track, { artist, words: contextWords }, recent)
          }))
          .sort((a, b) => b.score - a.score);

        if (!candidates.length) continue;

        // Pick randomly from the top few close matches, not from the entire
        // result set, so quality/context remains strong without repetition.
        const topScore = candidates[0].score;
        const top = candidates.filter(item => item.score >= topScore - 15).slice(0, 5);
        const picked = top[Math.floor(Math.random() * top.length)];
        if (picked && picked.score > chosenScore) {
          chosen = picked.track;
          chosenScore = picked.score;
        }

        if (chosen && chosenScore >= 150) break;
      } catch (error) {
        console.warn(`⚠️ Context autoplay search failed: ${query} — ${error?.message || error}`);
      }
    }

    if (!chosen) {
      const fallback = await this.search("popular songs", this.client.user).catch(() => null);
      chosen = (fallback?.tracks || [])
        .filter(isAutoplayCandidate)
        .find(track => !recent.includes(trackId(track))) || null;
    }

    if (!chosen || !isAutoplayCandidate(chosen)) {
      console.warn("⚠️ No short individual autoplay track found; refusing long-track fallback.");
      return false;
    }

    const id = trackId(chosen);
    if (id) state.recent = [...recent, id].slice(-20);
    chosen.isAutoplay = true;
    chosen.autoplayGroup = artist ? `Same artist / related: ${artist}` : "Related search / genre";
    state.current = chosen;

    await this.startTrack(guildId, chosen);
    console.log(`🎯 Short-track autoplay started: ${this.getTrackTitle(chosen)} — ${this.getTrackAuthor(chosen)} | ${chosen.autoplayGroup} | max=8m`);
    return true;
  } catch (error) {
    console.error("❌ Context autoplay error:", error?.message || error);
    state.current = null;
    return false;
  } finally {
    state.autoplayBusy = false;
  }
};

console.log("🎯 DEATH smart autoplay loaded: related songs + hard 8-minute maximum.");
