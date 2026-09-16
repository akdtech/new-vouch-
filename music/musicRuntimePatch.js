"use strict";

console.log("🛠️ DEATH Music runtime patch preloaded.");
const Module = require("module");
const originalLoad = Module._load;
let patched = false;

const clean = value => String(value || "").replace(/\s+/g, " ").trim();
const normalize = value => clean(value).toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[^a-z0-9'& ]+/g, " ").replace(/\s+/g, " ").trim();
const STOP = new Set(["the","a","an","and","or","of","to","for","with","it","is","in","on","at","by","from","official","music","song","songs","video","audio","lyrics","lyric","full","hd","4k","original","officialaudio","topic","vevo"]);
function tokens(value) { return normalize(value).split(" ").filter(Boolean); }
function meaningful(value) { return tokens(value).filter(t => !STOP.has(t) && t.length > 1); }
function distance(a, b) {
  a = String(a || ""); b = String(b || "");
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const old = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = old;
    }
  }
  return row[b.length];
}
function fuzzy(a, b) {
  a = normalize(a); b = normalize(b);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const max = a.length <= 4 ? 1 : a.length <= 7 ? 2 : 3;
  return distance(a, b) <= max;
}
function wordInText(word, text) { return tokens(text).some(t => fuzzy(word, t)); }
function artistMatches(wanted, actual) {
  const ws = meaningful(wanted);
  return ws.length > 0 && ws.every(w => wordInText(w, actual));
}
function scoreTrack(track, query, manager) {
  const title = normalize(manager.getTrackTitle(track));
  const author = normalize(manager.getTrackAuthor(track));
  const q = normalize(query);
  const wanted = meaningful(query);
  let score = 0;
  if (title === q) score += 5000; else if (title.includes(q)) score += 3500;
  if (author === q) score += 2500; else if (author.includes(q)) score += 1800;
  for (const word of wanted) { if (wordInText(word, title)) score += 700; if (wordInText(word, author)) score += 500; }
  if (wanted.length && wanted.every(w => wordInText(w, title))) score += 1800;
  if (wanted.length && wanted.every(w => wordInText(w, `${title} ${author}`))) score += 800;
  if (/(shorts?|tiktok|podcast|lecture|documentary|compilation|full movie|movie|tutorial|how to|reaction|commentary|gameplay|hour long|10 hour|8 hour|mix|playlist|radio|nonstop|medley)/i.test(title)) score -= 5000;
  const length = Number(track?.info?.length || track?.length || 0);
  if (length > 0 && length > 10 * 60 * 1000) score -= 3000;
  if (length > 0 && length <= 8 * 60 * 1000) score += 100;
  return score;
}
function reliableMatch(track, query, manager) {
  const title = normalize(manager.getTrackTitle(track));
  const author = normalize(manager.getTrackAuthor(track));
  const q = normalize(query);
  const wanted = meaningful(query);
  if (!title && !author) return false;
  if (title === q || title.includes(q) || author.includes(q)) return true;
  return wanted.length > 0 && wanted.every(w => wordInText(w, `${title} ${author}`));
}
function isSpotifyUrl(value) { return /^https?:\/\/(open\.)?spotify\.com\//i.test(clean(value)); }
function isSoundCloudUrl(value) { return /^https?:\/\/(www\.)?soundcloud\.com\//i.test(clean(value)); }
function isYouTubeUrl(value) { return /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(clean(value)); }
async function spotifyMetadata(url) {
  try {
    const response = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`);
    if (!response.ok) return null;
    const data = await response.json();
    const title = clean(data?.title);
    const author = clean(data?.author_name);
    return title ? { title, author } : null;
  } catch (error) {
    console.warn("⚠️ Spotify metadata lookup failed:", error?.message || error);
    return null;
  }
}

Module._load = function(request, parent, isMain) {
  const exported = originalLoad.apply(this, arguments);
  if (!patched && typeof exported === "function" && /(^|[\\/])music[\\/]MusicManager(?:\.js)?$/.test(request)) {
    patched = true;
    const Original = exported;
    const originalPlay = Original.prototype.play;
    const originalRefreshPanel = Original.prototype.refreshPanel;
    const originalEnsure247 = Original.prototype.ensure247;

    Original.prototype.search = async function(query, requester = null) {
      query = clean(query);
      if (!query) return null;
      if (isYouTubeUrl(query) || isSoundCloudUrl(query)) {
        try { const direct = await this.kazagumo.search(query, { requester }); if (direct?.tracks?.length) return direct; }
        catch (error) { console.warn("⚠️ Direct music URL failed:", error?.message || error); }
        return null;
      }
      if (isSpotifyUrl(query)) {
        const meta = await spotifyMetadata(query);
        if (!meta) throw new Error("Spotify link could not be resolved. Use a Spotify track URL or search by song name.");
        const result = await this.search(`${meta.title} ${meta.author}`.trim(), requester);
        if (!result?.tracks?.length) throw new Error(`Could not find a playable mirror for Spotify track: ${meta.title} ${meta.author}`);
        result.spotifyMirror = meta;
        return result;
      }
      const cacheKey = normalize(query);
      const cached = this.searchCache?.get(cacheKey);
      if (cached && cached.expires > Date.now()) return cached.result;
      const variants = [query, `"${query}"`, `${query} official audio`, `${query} song`];
      const candidates = [];
      const seen = new Set();
      for (const prefix of ["ytmsearch:", "ytsearch:", "scsearch:"]) {
        for (const variant of variants) {
          try {
            const result = await this.kazagumo.search(`${prefix}${variant}`, { requester });
            for (const track of result?.tracks || []) {
              const id = this.getTrackId(track) || `${this.getTrackTitle(track)}|${this.getTrackAuthor(track)}`;
              if (seen.has(id)) continue;
              seen.add(id);
              candidates.push({ track, source: prefix });
            }
          } catch (error) { console.warn(`⚠️ ${prefix}${variant} failed:`, error?.message || error); }
        }
      }
      const ranked = candidates.map((entry, index) => ({ ...entry, score: scoreTrack(entry.track, query, this) + (entry.source === "ytmsearch:" ? 300 : entry.source === "ytsearch:" ? 200 : 0), index })).sort((a, b) => b.score - a.score || a.index - b.index);
      const valid = ranked.filter(entry => reliableMatch(entry.track, query, this));
      if (!valid.length) { console.warn(`❌ No reliable match for: "${query}"`); return { tracks: [], type: "SEARCH_RESULT" }; }
      const result = { tracks: valid.slice(0, 10).map(x => x.track), type: "SEARCH_RESULT" };
      this.searchCache?.set(cacheKey, { result, expires: Date.now() + 30000 });
      const best = valid[0].track;
      console.log(`🔎 Music match: "${query}" → ${this.getTrackTitle(best)} — ${this.getTrackAuthor(best)}`);
      return result;
    };

    Original.prototype.play = async function(args) {
      const result = await originalPlay.call(this, args);
      const player = result?.player || this.getPlayer(args?.guildId);
      if (!player) return result;
      if (!player.playing && !player.paused && !player.queue?.current && (player.queue?.length || 0) > 0) await player.play();
      const state = this.getState(args.guildId);
      if (result?.track) { state.autoplayContext = { query: clean(args?.query), artist: clean(this.getTrackAuthor(result.track)), title: clean(this.getTrackTitle(result.track)) }; state.autoplayGeneration = (state.autoplayGeneration || 0) + 1; }
      await this.refreshPanel(args.guildId).catch(() => {});
      return result;
    };

    const wrapControl = (name, fallback) => {
      const old = Original.prototype[name];
      Original.prototype[name] = async function(guildId, ...rest) {
        const player = this.getPlayer(guildId);
        let result; let worked = false;
        try { if (old) { result = await old.call(this, guildId, ...rest); worked = true; } }
        catch (error) { console.warn(`⚠️ ${name} fallback:`, error?.message || error); }
        if (!worked && player) result = await fallback.call(this, player, guildId, ...rest);
        await this.refreshPanel(guildId).catch(() => {});
        return result;
      };
    };
    wrapControl("pause", async function(player) { if (!player.queue?.current) return false; await player.pause(true); return true; });
    wrapControl("resume", async function(player) { if (!player.queue?.current) return false; await player.pause(false); return true; });
    wrapControl("skip", async function(player) { if (!player.queue?.current) return false; await player.skip(); return true; });
    wrapControl("stop", async function(player, guildId) { if (typeof player.queue?.clear === "function") player.queue.clear(); if (typeof player.stop === "function") await player.stop(); else if (typeof player.stopTrack === "function") await player.stopTrack(); this.getState(guildId).autoplayGeneration = (this.getState(guildId).autoplayGeneration || 0) + 1; return true; });
    wrapControl("shuffle", async function(player) { if (typeof player.queue?.shuffle === "function") player.queue.shuffle(); return true; });
    wrapControl("setVolume", async function(player, guildId, volume) { const level = Math.max(1, Math.min(100, Number(volume) || 70)); await player.setVolume(level); return level; });

    Original.prototype.refreshPanel = async function(guildId) {
      if (!guildId) return false;
      if (originalRefreshPanel) { try { return await originalRefreshPanel.call(this, guildId); } catch (error) { console.warn("⚠️ Panel refresh failed:", error?.message || error); } }
      return false;
    };

    Original.prototype.autoplayNext = async function(guildId, player = this.getPlayer(guildId)) {
      if (!player) return false;
      const state = this.getState(guildId);
      if (!state.autoplay || this.autoplayBusy.has(guildId)) return false;
      if (player.playing || player.paused || player.queue?.current || (player.queue?.length || 0) > 0) return false;
      const context = state.autoplayContext || {};
      const artist = clean(context.artist); const query = clean(context.query);
      if (!artist && !query) return false;
      this.autoplayBusy.add(guildId);
      const generation = state.autoplayGeneration || 0;
      try {
        const seeds = artist ? [`${artist} songs`, `${artist} official songs`, artist] : [query];
        const recent = this.recentTracks.get(guildId) || [];
        for (const seed of seeds) {
          const result = await this.search(seed, this.client.user).catch(() => null);
          const candidates = (result?.tracks || []).filter(track => {
            const id = this.getTrackId(track); const title = this.getTrackTitle(track); const len = Number(track?.info?.length || track?.length || 0);
            if (!id || recent.includes(id) || len > 10 * 60 * 1000) return false;
            if (/(podcast|lecture|documentary|compilation|full movie|tutorial|reaction|commentary|gameplay|10 hour|8 hour|mix|playlist|radio|nonstop|medley)/i.test(title)) return false;
            return !artist || artistMatches(artist, this.getTrackAuthor(track));
          }).sort((a, b) => scoreTrack(b, seed, this) - scoreTrack(a, seed, this));
          const chosen = candidates[0];
          if (!chosen) continue;
          if ((state.autoplayGeneration || 0) !== generation) return false;
          player.queue.add(chosen);
          const id = this.getTrackId(chosen); if (id) this.recentTracks.set(guildId, [...recent, id].slice(-20));
          await player.play(); await this.refreshPanel(guildId).catch(() => {});
          console.log(`🎯 Context autoplay queued: ${this.getTrackTitle(chosen)} — ${this.getTrackAuthor(chosen)}`);
          return true;
        }
        return false;
      } finally { this.autoplayBusy.delete(guildId); }
    };

    Original.prototype.startRecoveryLoop = function() {
      if (this.recoveryStarted) return;
      this.recoveryStarted = true;
      if (this.recoveryTimer) clearInterval(this.recoveryTimer);
      this.recoveryTimer = setInterval(async () => {
        try {
          const guildId = this.musicGuildId; if (!guildId) return;
          const player = this.getPlayer(guildId); const guild = this.client.guilds.cache.get(guildId); const me = guild?.members?.me; const inVoice = me?.voice?.channelId === this.musicVoiceChannelId;
          if (!player || player.destroyed || !inVoice) await this.ensure247(guildId);
        } catch (error) { console.warn("⚠️ Music recovery check failed:", error?.message || error); }
      }, 30000);
      console.log("♾️ Stable music recovery loop enabled.");
    };

    Original.prototype.ensure247 = async function(guildId) {
      const state = this.getState(guildId || this.musicGuildId); const oldAuto = state.autoplay;
      if (!state.autoplayContext) state.autoplay = false;
      try { return await originalEnsure247.call(this, guildId); }
      finally { state.autoplay = oldAuto; }
    };

    console.log("🛠️ DEATH Music runtime repair hooked MusicManager.");
  }
  return exported;
};
