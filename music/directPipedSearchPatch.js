"use strict";

/* DEATH search recovery: Piped + Invidious + yt-dlp fallback. */
const MusicManager = require("./DirectMusicManager");

const PIPED = String(process.env.PIPED_API_URLS || [
  "https://pipedapi.kavin.rocks",
  "https://pipedapi.ducks.party",
  "https://api.piped.private.coffee",
  "https://pipedapi.leptons.xyz",
  "https://pipedapi.adminforge.de",
  "https://pipedapi.darkness.services"
].join(",")).split(",").map(v => v.trim().replace(/\/+$/, "")).filter(Boolean);

const clean = v => String(v || "").replace(/\s+/g, " ").trim();
const ytId = value => String(value || "").match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i)?.[1] || null;

async function requestJson(url, ms = 4500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "DEATH-Music-24-7/3.0" },
      signal: controller.signal,
      redirect: "follow"
    });
    if (!response.ok) throw new Error("HTTP " + response.status);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function pipedTrack(item, requester) {
  const id = String(item?.url || "").match(/[?&]v=([A-Za-z0-9_-]{11})/)?.[1]
    || ytId(item?.url)
    || item?.videoId;
  if (!id || !item?.title) return null;
  return {
    identifier: id,
    id,
    url: "https://www.youtube.com/watch?v=" + id,
    title: clean(item.title),
    author: clean(item.uploaderName) || "Unknown artist",
    length: Math.max(0, Number(item.duration || 0) * 1000),
    requester: requester || null,
    thumbnail: item.thumbnail || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    isAutoplay: false,
    source: "piped-search"
  };
}

async function pipedSearch(q, requester) {
  const jobs = PIPED.map(async base => {
    const data = await requestJson(`${base}/search?q=${encodeURIComponent(q)}&filter=music_songs`);
    const items = Array.isArray(data?.items) ? data.items : [];
    const tracks = items.filter(x => x?.type === "stream").map(x => pipedTrack(x, requester)).filter(Boolean).slice(0, 8);
    if (!tracks.length) throw new Error("no Piped results");
    return tracks;
  });
  return Promise.any(jobs);
}

async function pipedVideo(id, requester) {
  const jobs = PIPED.map(async base => {
    const data = await requestJson(`${base}/streams/${encodeURIComponent(id)}`);
    if (!Array.isArray(data?.audioStreams) || !data.audioStreams.length) throw new Error("no audio streams");
    return {
      identifier: id,
      id,
      url: "https://www.youtube.com/watch?v=" + id,
      title: clean(data.title) || "Unknown track",
      author: clean(data.uploader) || clean(data.uploaderName) || "Unknown artist",
      length: Math.max(0, Number(data.duration || 0) * 1000),
      requester: requester || null,
      thumbnail: data.thumbnailUrl || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      isAutoplay: false,
      source: "piped"
    };
  });
  return Promise.any(jobs);
}

if (!MusicManager.prototype.__deathPipedSearchPatched) {
  MusicManager.prototype.__deathPipedSearchPatched = true;
  const originalSearch = MusicManager.prototype.search;

  MusicManager.prototype.search = async function deathPipedSearch(queryValue, requester) {
    const q = this.cleanQuery(typeof queryValue === "string" ? queryValue : (queryValue?.query || ""));
    if (!q) throw new Error("Please provide a song name or URL.");

    const id = ytId(q);
    if (id) {
      try {
        const track = await pipedVideo(id, requester || this.client.user);
        console.log(`🔎 Piped URL metadata success: ${track.title}`);
        return { type: "track", tracks: [track] };
      } catch (error) {
        console.warn(`⚠️ Piped URL metadata failed: ${error?.message || error}`);
        return originalSearch.call(this, q, requester);
      }
    }

    try {
      const tracks = await pipedSearch(q, requester || this.client.user);
      console.log(`🔎 Piped search success: ${tracks[0]?.title || q}`);
      return { type: "track", tracks };
    } catch (error) {
      console.warn(`⚠️ Piped search unavailable; using existing search providers: ${error?.message || error}`);
      return originalSearch.call(this, q, requester);
    }
  };

  console.log(`🔎 DEATH Piped search recovery loaded: ${PIPED.length} parallel search routes.`);
}

module.exports = { pipedSearch, pipedVideo };
