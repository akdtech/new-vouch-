"use strict";

/*
 * DEATH direct autoplay intelligence.
 *
 * Rules:
 *  - Never autoplay hour-long mixes/playlists/albums.
 *  - Prefer normal individual songs (roughly 2-10 minutes; hard cap 15m).
 *  - After a user /play, stay close to that song: same artist first, then
 *    meaningful words from the title/search, so the queue feels like a radio
 *    station built around what the user actually requested.
 *  - Keep recent tracks out to avoid immediate repeats.
 *  - Startup still uses a small genre seed when nobody has played anything.
 */
const MusicManager = require("./DirectMusicManager");

const MAX_AUTOPLAY_MS = 15 * 60 * 1000;
const IDEAL_MIN_MS = 90 * 1000;
const IDEAL_MAX_MS = 10 * 60 * 1000;
const BAD_TITLE = /\b(1\s*hour|2\s*hour|3\s*hour|hour\s*mix|\bmix\b|playlist|compilation|continuous|nonstop|radio|medley|full\s*album|album|collection|lofi\s*mix|sleep\s*music)\b/i;
const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "for", "in", "on", "at",
  "with", "from", "is", "it", "my", "your", "me", "you", "official",
  "video", "audio", "music", "song", "lyrics", "lyric", "remix", "edit",
  "version", "full", "hd", "4k", "feat", "ft"
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

function candidateScore(track, context, recent) {
  const title = clean(track?.title);
  const artist = clean(track?.author || track?.uploader);
  const length = Number(track?.length || 0);
  const haystack = `${title} ${artist}`.toLowerCase();
  let score = 0;

  if (artistMatches(artist, context.artist)) score += 100;
  for (const word of context.words) {
    if (haystack.includes(word)) score += 15;
  }

  if (length >= IDEAL_MIN_MS && length <= IDEAL_MAX_MS) score += 20;
  else if (length > IDEAL_MAX_MS && length <= MAX_AUTOPLAY_MS) score -= 5;
  else if (length > 0 && length < IDEAL_MIN_MS) score -= 10;

  const id = track?.identifier || track?.id || track?.url;
  if (id && recent.includes(id)) score -= 1000;
  if (BAD_TITLE.test(title)) score -= 1000;

  // Strongly prefer a real single-track result over suspiciously long uploads.
  if (!length || length > MAX_AUTOPLAY_MS) score -= 500;
  return score;
}

const originalPlay = MusicManager.prototype.play;
const originalAutoplayNext = MusicManager.prototype.autoplayNext;

MusicManager.prototype.play = async function patchedPlay(args) {
  const result = await originalPlay.call(this, args);
  const state = this.getState(args.guildId);
  const track = result?.track || state.current || null;
  const title = clean(track?.title);
  const artist = clean(track?.author || track?.uploader);
  const query = clean(args?.query);

  state.autoplayContext = {
    artist: artistIsUseful(artist) ? artist : "",
    title,
    query,
    words: [...new Set([...words(title), ...words(query)])].slice(0, 6)
  };

  console.log(`🎯 Autoplay context: ${artist || "genre/search"}${title ? ` — ${title}` : ""}`);
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
    const contextWords = Array.isArray(context.words) ? context.words : words(`${context.title} ${context.query}`);

    const queries = [];
    if (artist) {
      queries.push(`${artist} ${contextWords.slice(0, 2).join(" ")} songs`);
      queries.push(`${artist} songs`);
    }
    if (contextWords.length) {
      queries.push(`${contextWords.slice(0, 3).join(" ")} songs`);
      queries.push(`${clean(context.query)} similar songs`);
    }
    if (!queries.length) {
      queries.push("popular English songs");
    }

    let chosen = null;
    let chosenScore = -Infinity;

    for (const query of queries) {
      try {
        const result = await this.search(query, this.client.user);
        const candidates = (result?.tracks || [])
          .filter(track => {
            const length = Number(track?.length || 0);
            return length > 0 && length <= MAX_AUTOPLAY_MS && !BAD_TITLE.test(clean(track?.title));
          })
          .map(track => ({ track, score: candidateScore(track, { artist, words: contextWords }, recent) }))
          .filter(item => item.score > -500)
          .sort((a, b) => b.score - a.score);

        if (candidates.length) {
          // Randomise only among the top few similarly-scored songs so autoplay
          // does not always pick search result #1 while still respecting context.
          const topScore = candidates[0].score;
          const top = candidates.filter(item => item.score >= topScore - 12).slice(0, 4);
          const picked = top[Math.floor(Math.random() * top.length)];
          if (picked && picked.score > chosenScore) {
            chosen = picked.track;
            chosenScore = picked.score;
          }
        }

        if (chosen && chosenScore >= 100) break;
      } catch (error) {
        console.warn(`⚠️ Context autoplay search failed: ${query} — ${error?.message || error}`);
      }
    }

    if (!chosen) {
      // Keep the 24/7 service alive if a context search temporarily fails, but
      // still use a normal-song query and the same strict length filter.
      const fallback = await this.search("popular songs", this.client.user).catch(() => null);
      const track = (fallback?.tracks || [])
        .filter(item => Number(item?.length || 0) > 0 && Number(item.length) <= MAX_AUTOPLAY_MS && !BAD_TITLE.test(clean(item?.title)))
        .find(item => !recent.includes(item?.identifier || item?.id || item?.url));
      chosen = track || null;
    }

    if (!chosen) return false;

    const id = chosen.identifier || chosen.id || chosen.url;
    if (id) state.recent = [...recent, id].slice(-20);
    chosen.isAutoplay = true;
    chosen.autoplayGroup = artist ? `Same artist: ${artist}` : "Same vibe / search context";
    state.current = chosen;

    await this.startTrack(guildId, chosen);
    console.log(`🎯 Context autoplay started: ${this.getTrackTitle(chosen)} — ${this.getTrackAuthor(chosen)} | ${chosen.autoplayGroup}`);
    return true;
  } catch (error) {
    console.error("❌ Context autoplay error:", error?.message || error);
    state.current = null;
    return false;
  } finally {
    state.autoplayBusy = false;
  }
};

console.log("🎯 DEATH smart autoplay loaded: same artist/title/genre context + short tracks only.");
