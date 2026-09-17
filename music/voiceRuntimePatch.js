"use strict";

/*
 * DEATH Music 24/7 startup + reliable playback patch.
 *
 * YouTube playback can hit transient 403/login/signature failures.
 * LavaSrc + yt-dlp is installed as a direct playback fallback.
 *
 * Reliable path:
 *   1) ytdlpsearch
 *   2) ytmsearch
 *   3) ytsearch
 *
 * SoundCloud is intentionally NOT used as a fallback for YouTube searches.
 */

const MusicManager = require("./MusicManager");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const originalEnsure247 = MusicManager.prototype.ensure247;
const originalSearch = MusicManager.prototype.search;
const originalAutoplayNext = MusicManager.prototype.autoplayNext;

async function reliableSearch(manager, query, requester = null) {
  const clean = manager.cleanQuery(query);
  if (!clean) return null;

  // Direct YouTube URLs/IDs should still use the normal URL loader.
  if (manager.isYouTubeUrl(clean)) {
    return originalSearch.call(manager, clean, requester);
  }

  const identifiers = [
    `ytdlpsearch:${clean}`,
    `ytmsearch:${clean}`,
    `ytsearch:${clean}`
  ];

  for (const identifier of identifiers) {
    try {
      console.log(`🔎 Reliable music search: ${identifier}`);
      const result = await manager.kazagumo.search(identifier, { requester });

      if (result?.tracks?.length) {
        console.log(
          `✅ Reliable search found ${result.tracks.length} track(s) using ${identifier}`
        );
        return result;
      }
    } catch (error) {
      console.warn(
        `⚠️ Reliable search failed for ${identifier}:`,
        error?.message || error
      );
    }
  }

  console.error(`❌ No reliable music source returned tracks for "${clean}".`);
  return null;
}

async function reliableAutoplayNext(manager, guildId, player) {
  if (!player) return false;

  const state = manager.getState(guildId);

  if (!state.autoplay || manager.autoplayBusy.has(guildId)) {
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

  manager.autoplayBusy.add(guildId);

  try {
    const recent = manager.recentTracks.get(guildId) || [];
    const seeds = [
      "popular music 2026",
      "top hits",
      "chill music",
      "gaming music",
      "night drive music",
      "electronic music",
      "hip hop hits",
      "pop hits",
      "rnb hits",
      "rock classics",
      "dance music",
      "lofi beats"
    ];

    for (let attempt = 1; attempt <= 8; attempt++) {
      const seed = seeds[Math.floor(Math.random() * seeds.length)];

      try {
        console.log(`🎵 Reliable autoplay ${attempt}/8: "${seed}"`);

        const result = await reliableSearch(
          manager,
          seed,
          manager.client.user
        );

        if (!result?.tracks?.length) continue;

        const candidates = result.tracks.filter(track => {
          const id = manager.getTrackId(track);
          return id && !recent.includes(id);
        });

        const chosen = candidates[0] || result.tracks[0];
        if (!chosen) continue;

        if (
          player.playing ||
          player.paused ||
          player.queue?.current ||
          (player.queue?.length || 0) > 0
        ) {
          return true;
        }

        const id = manager.getTrackId(chosen);
        if (id) {
          manager.recentTracks.set(
            guildId,
            [...recent, id].slice(-10)
          );
        }

        player.queue.add(chosen);
        await player.play();

        state.autoplayContext = {
          query: seed,
          artist: manager.getTrackAuthor(chosen),
          title: manager.getTrackTitle(chosen)
        };

        state.autoplayGeneration =
          (state.autoplayGeneration || 0) + 1;

        console.log(
          `🎵 RELIABLE AUTOPLAY STARTED: ${manager.getTrackTitle(chosen)} — ${manager.getTrackAuthor(chosen)}`
        );

        await manager.refreshPanel(guildId).catch(() => {});
        return true;
      } catch (error) {
        console.warn(
          `⚠️ Reliable autoplay failed for "${seed}":`,
          error?.message || error
        );
      }
    }

    // Last-resort call to the original implementation, but only if it
    // hasn't already queued anything. This keeps existing recovery logic.
    if (
      !player.playing &&
      !player.paused &&
      !player.queue?.current &&
      (player.queue?.length || 0) === 0
    ) {
      return originalAutoplayNext.call(manager, guildId, player);
    }

    return true;
  } finally {
    manager.autoplayBusy.delete(guildId);
  }
}

async function forceStartupMusic(manager, guildId, player) {
  if (!player) return false;

  const state = manager.getState(guildId);
  state.autoplay = true;

  if (
    player.playing ||
    player.paused ||
    player.queue?.current ||
    (player.queue?.length || 0) > 0
  ) {
    return true;
  }

  const seeds = [
    "popular music 2026",
    "top hits",
    "chill music",
    "gaming music",
    "lofi beats",
    "pop hits"
  ];

  for (let attempt = 1; attempt <= 5; attempt++) {
    for (const seed of seeds) {
      try {
        console.log(
          `🎵 Startup music attempt ${attempt}/5: searching "${seed}"`
        );

        const result = await reliableSearch(
          manager,
          seed,
          manager.client.user
        );

        const track = result?.tracks?.find(Boolean);

        if (!track) {
          console.warn(
            `⚠️ Startup search returned no track for "${seed}".`
          );
          continue;
        }

        if (
          player.playing ||
          player.paused ||
          player.queue?.current ||
          (player.queue?.length || 0) > 0
        ) {
          return true;
        }

        player.queue.add(track);
        await player.play();

        state.autoplayContext = {
          query: seed,
          artist: manager.getTrackAuthor(track),
          title: manager.getTrackTitle(track)
        };

        state.autoplayGeneration =
          (state.autoplayGeneration || 0) + 1;

        console.log(
          `🎵 AUTO PLAY STARTED: ${manager.getTrackTitle(track)} — ${manager.getTrackAuthor(track)}`
        );

        await manager.refreshPanel(guildId).catch(() => {});
        return true;
      } catch (error) {
        console.warn(
          `⚠️ Startup music failed for "${seed}":`,
          error?.message || error
        );
      }
    }

    await sleep(2000);
  }

  console.error("❌ Startup music could not start after 5 attempts.");
  return false;
}

if (!MusicManager.prototype.__deathReliablePlaybackPatch) {
  MusicManager.prototype.__deathReliablePlaybackPatch = true;

  MusicManager.prototype.search = async function(query, requester = null) {
    return reliableSearch(this, query, requester);
  };

  MusicManager.prototype.autoplayNext = async function(
    guildId,
    player = this.getPlayer(guildId)
  ) {
    return reliableAutoplayNext(this, guildId, player);
  };

  MusicManager.prototype.ensure247 = async function(
    guildId = this.musicGuildId
  ) {
    if (!guildId) return null;

    const state = this.getState(guildId);
    state.autoplay = true;

    if (!state.autoplayContext) {
      state.autoplayContext = {
        query: "popular music 2026",
        artist: "",
        title: ""
      };
    }

    const player = await originalEnsure247.call(this, guildId);

    if (!player) {
      console.error(
        "❌ 24/7 player was not created; startup music cannot begin."
      );
      return null;
    }

    console.log(
      "🔊 24/7 voice player connected. Checking reliable startup playback..."
    );

    if (
      !player.playing &&
      !player.paused &&
      !player.queue?.current &&
      (player.queue?.length || 0) === 0
    ) {
      await forceStartupMusic(this, guildId, player);
    }

    await this.refreshPanel(guildId).catch(() => {});

    console.log("🎵 Startup autoplay/panel sequence completed.");
    return player;
  };
}

console.log("🛠️ DEATH reliable yt-dlp playback patch loaded.");
