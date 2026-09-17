"use strict";

/* DEATH search accelerator. Playback is owned by directPlaybackPatch.js. */
const MusicManager = require("./DirectMusicManager");

const INSTANCES = String(process.env.INVIDIOUS_API_URLS || [
  "https://inv.nadeko.net",
  "https://invidious.nerdvpn.de",
  "https://yt.chocolatemoo53.com",
  "https://invidious.tiekoetter.com",
  "https://invidious.f5.si",
  "https://yewtu.be",
  "https://yt.artemislena.eu",
  "https://invidious.flokinet.to"
].join(",")).split(",").map(v => v.trim().replace(/\/+$/, "")).filter(Boolean);
const TIMEOUT = Math.max(2500, Number(process.env.INVIDIOUS_TIMEOUT_MS || 5000));
const clean = v => String(v || "").replace(/\s+/g, " ").trim();

function ytId(value) {
  return String(value || "").match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i)?.[1] || null;
}
function trackFrom(item, requester) {
  const id = item?.videoId || item?.id;
  if (!id) return null;
  const thumbs = Array.isArray(item?.videoThumbnails) ? item.videoThumbnails : [];
  return {
    identifier: id,
    id,
    url: `https://www.youtube.com/watch?v=${id}`,
    title: clean(item?.title) || "Unknown track",
    author: clean(item?.author || item?.uploader) || "Unknown artist",
    length: Number(item?.lengthSeconds ?? item?.duration ?? 0) * 1000,
    requester,
    thumbnail: thumbs.find(x => x?.quality === "maxres")?.url || thumbs.at(-1)?.url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    isAutoplay: false,
    source: "invidious-search"
  };
}

async function query(base, q, requester) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const r = await fetch(`${base}/api/v1/search?q=${encodeURIComponent(q)}&type=video&sort=relevance`, {
      headers: { accept: "application/json", "user-agent": "DEATH-Music-24-7/2.0" }, signal: controller.signal, redirect: "follow"
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const tracks = (Array.isArray(data) ? data : []).filter(x => x?.type === "video").map(x => trackFrom(x, requester)).filter(Boolean).slice(0, 5);
    if (!tracks.length) throw new Error("no results");
    return { type: "track", tracks, base };
  } finally { clearTimeout(timer); }
}

if (!MusicManager.prototype.__deathInvidiousSearchOnlyPatched) {
  MusicManager.prototype.__deathInvidiousSearchOnlyPatched = true;
  const originalSearch = MusicManager.prototype.search;
  MusicManager.prototype.search = async function fastInvidiousSearch(queryValue, requester) {
    const value = typeof queryValue === "string" ? queryValue : (queryValue?.query || queryValue?.search || queryValue?.name || "");
    const q = this.cleanQuery(value);
    if (!q) return originalSearch.call(this, queryValue, requester);

    if (this.isYouTubeUrl(q)) return originalSearch.call(this, q, requester);

    try {
      const jobs = INSTANCES.map(base => query(base, q, requester || this.client.user));
      const result = await Promise.any(jobs);
      console.log(`🔎 Invidious search success via ${result.base}: ${result.tracks[0]?.title || q}`);
      return { type: "track", tracks: result.tracks };
    } catch (error) {
      console.warn(`⚠️ Invidious search unavailable; falling back to yt-dlp: ${error?.message || error}`);
      return originalSearch.call(this, q, requester);
    }
  };
  console.log(`🛟 DEATH Invidious search accelerator loaded: ${INSTANCES.length} parallel search routes; playback stays in stable v6 engine.`);
}

module.exports = { ytId };
