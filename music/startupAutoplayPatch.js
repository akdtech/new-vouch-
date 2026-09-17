"use strict";

/*
 * DEATH Music 24/7 final startup guard.
 *
 * The production symptom was:
 *   player connects -> no track -> "Autoplay did not find a track"
 *   -> player later closes.
 *
 * This patch deliberately bypasses any ambiguous search-prefix handling
 * and uses Kazagumo's documented `source` search option. It also treats a
 * player with no current track and no queue as idle even if a stale
 * playing/paused flag is left behind after a voice reconnect.
 */

const MusicManager = require("./MusicManager");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const originalAutoplayNext = MusicManager.prototype.autoplayNext;
const originalEnsure247 = MusicManager.prototype.ensure247;

const GROUPS = [
  {
    name: "Hindi Music",
    queries: [
      "best Hindi songs 2026",
      "latest Hindi songs 2026",
      "Bollywood hits 2026",
      "Hindi viral songs 2026"
    ]
  },
  {
    name: "English TikTok Viral",
    queries: [
      "TikTok viral songs 2026",
      "TikTok viral hits 2026",
      "viral English songs 2026",
      "TikTok trending songs 2026"
    ]
  },
  {
    name: "Top English",
    queries: [
      "top English songs 2026",
      "best English songs 2026",
      "global top hits 2026",
      "English chart hits 2026"
    ]
  }
];

function nextSeed(manager, guildId) {
  const state = manager.getState(guildId);
  const last = state.__deathStartupGroup || "";
  const groups = GROUPS.filter(group => group.name !== last);
  const group = groups[Math.floor(Math.random() * groups.length)] || GROUPS[0];
  const query = group.queries[Math.floor(Math.random() * group.queries.length)];
  return { group: group.name, query };
}

function hasQueuedTrack(player) {
  return Boolean(player?.queue?.current) || Number(player?.queue?.length || 0) > 0;
}

async function sourceSearch(manager, query, source) {
  return manager.kazagumo.search(query, {
    requester: manager.client.user,
    source
  });
}

async function finalAutoplay(manager, guildId, player) {
  if (!player) return false;

  const state = manager.getState(guildId);
  if (!state.autoplay || manager.autoplayBusy.has(guildId)) return false;

  // A player with no track and no queued items is idle. Do not let a stale
  // Kazagumo flag prevent startup after a voice reconnect.
  if (hasQueuedTrack(player)) {
    if (!player.playing && !player.paused) {
      await player.play().catch(error => console.warn("⚠️ Queue resume failed:", error?.message || error));
    }
    return true;
  }

  manager.autoplayBusy.add(guildId);

  try {
    for (let attempt = 1; attempt <= 12; attempt++) {
      const { group, query } = nextSeed(manager, guildId);
      console.log(`🚀 Startup autoplay ${attempt}/12 [${group}]: "${query}"`);

      const sources = ["ytmsearch:", "ytsearch:", "ytdlpsearch:", "scsearch:"];
      let result = null;

      for (const source of sources) {
        try {
          console.log(`🔎 Startup source: ${source}${query}`);
          const found = await sourceSearch(manager, query, source);
          if (found?.tracks?.length) {
            result = found;
            console.log(`✅ Startup source ${source} returned ${found.tracks.length} track(s).`);
            break;
          }
          console.warn(`⚠️ Startup source ${source} returned 0 tracks.`);
        } catch (error) {
          console.warn(`⚠️ Startup source ${source} failed:`, error?.message || error);
        }
      }

      if (!result?.tracks?.length) {
        await sleep(500);
        continue;
      }

      const recent = manager.recentTracks.get(guildId) || [];
      const candidates = result.tracks.filter(track => {
        const id = manager.getTrackId(track);
        return id && !recent.includes(id);
      });
      const track = candidates[0] || result.tracks[0];
      if (!track) continue;

      if (hasQueuedTrack(player)) {
        if (!player.playing && !player.paused) await player.play().catch(() => {});
        return true;
      }

      const id = manager.getTrackId(track);
      if (id) manager.recentTracks.set(guildId, [...recent, id].slice(-20));

      player.queue.add(track);
      await player.play();

      state.__deathStartupGroup = group;
      state.autoplayGroup = group;
      state.autoplayTrackId = id || null;
      state.autoplayContext = {
        query,
        group,
        title: manager.getTrackTitle(track),
        artist: manager.getTrackAuthor(track)
      };
      state.autoplayGeneration = (state.autoplayGeneration || 0) + 1;

      console.log(`🎵 STARTUP AUTOPLAY STARTED [${group}]: ${manager.getTrackTitle(track)} — ${manager.getTrackAuthor(track)}`);
      await manager.refreshPanel(guildId).catch(() => {});
      return true;
    }

    console.error("❌ Startup autoplay exhausted all search attempts.");
    return false;
  } finally {
    manager.autoplayBusy.delete(guildId);
  }
}

MusicManager.prototype.autoplayNext = function(guildId, player = this.getPlayer(guildId)) {
  return finalAutoplay(this, guildId, player);
};

MusicManager.prototype.ensure247 = async function(guildId = this.musicGuildId) {
  const state = this.getState(guildId);
  state.autoplay = true;
  const player = await originalEnsure247.call(this, guildId);
  if (!player) return null;

  // If startup returned with an idle player, explicitly launch our final
  // source-aware autoplay guard instead of waiting for another event.
  if (!hasQueuedTrack(player)) {
    const started = await finalAutoplay(this, guildId, player).catch(error => {
      console.error("❌ Final startup autoplay error:", error?.message || error);
      return false;
    });
    console.log(`🚀 Final startup autoplay result=${started}`);
  }

  return player;
};

if (!MusicManager.prototype.__deathStartupAutoplayGuard) {
  MusicManager.prototype.__deathStartupAutoplayGuard = true;

  // Recreate the permanent player after an unexpected close.
  MusicManager.prototype.__deathStartupAutoplayGuardInstalled = true;

  const kazagumo = MusicManager.prototype;
  void kazagumo;

  console.log("🛡️ DEATH final startup autoplay guard loaded.");
}
