"use strict";

/*
 * DEATH Music 24/7 startup + reliable playback patch.
 *
 * Reliable path:
 *   1) ytdlpsearch
 *   2) ytmsearch
 *   3) ytsearch
 *
 * This patch also protects the track-to-track transition. Kazagumo can emit
 * playerEnd/playerEmpty while the previous queue.current is still present for
 * a short time. The old autoplay guard returned immediately in that window,
 * leaving the player connected but silent. We now wait for the old track to
 * clear and also retry after playerEnd/playerException.
 */

const MusicManager = require("./MusicManager");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const originalEnsure247 = MusicManager.prototype.ensure247;
const originalSearch = MusicManager.prototype.search;
const originalAutoplayNext = MusicManager.prototype.autoplayNext;
const originalSetupEvents = MusicManager.prototype.setupEvents;

async function reliableSearch(manager, query, requester = null) {
  const clean = manager.cleanQuery(query);
  if (!clean) return null;

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

async function waitForPreviousTrackToClear(player, timeout = 8000) {
  const started = Date.now();

  while (Date.now() - started < timeout) {
    if (!player?.queue?.current) return true;
    await sleep(250);
  }

  return !player?.queue?.current;
}

async function reliableAutoplayNext(manager, guildId, player) {
  if (!player) return false;

  const state = manager.getState(guildId);

  if (!state.autoplay || manager.autoplayBusy.has(guildId)) {
    return false;
  }

  if (player.playing || player.paused) {
    return false;
  }

  // IMPORTANT: after playerEnd, Kazagumo may still expose the previous
  // track as queue.current for a few milliseconds/seconds. Do not give up.
  if (player.queue?.current) {
    console.log(`⏳ Waiting for previous track to clear before autoplay | guild=${guildId}`);
    const cleared = await waitForPreviousTrackToClear(player, 8000);
    if (!cleared) {
      console.warn(`⚠️ Previous track did not clear in time | guild=${guildId}`);
      return false;
    }
  }

  // If another queued track already exists, Kazagumo should play it normally;
  // don't inject an autoplay track in front of it.
  if ((player.queue?.length || 0) > 0) {
    if (!player.playing && !player.paused) {
      await player.play().catch(() => {});
    }
    return true;
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

        const result = await reliableSearch(manager, seed, manager.client.user);
        if (!result?.tracks?.length) continue;

        const candidates = result.tracks.filter(track => {
          const id = manager.getTrackId(track);
          return id && !recent.includes(id);
        });

        const chosen = candidates[0] || result.tracks[0];
        if (!chosen) continue;

        if (player.playing || player.paused || player.queue?.current) {
          return true;
        }

        if ((player.queue?.length || 0) > 0) {
          await player.play().catch(() => {});
          return true;
        }

        const id = manager.getTrackId(chosen);
        if (id) {
          manager.recentTracks.set(guildId, [...recent, id].slice(-10));
        }

        player.queue.add(chosen);
        await player.play();

        state.autoplayContext = {
          query: seed,
          artist: manager.getTrackAuthor(chosen),
          title: manager.getTrackTitle(chosen)
        };

        state.autoplayGeneration = (state.autoplayGeneration || 0) + 1;

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

    if (!player.playing && !player.paused && !player.queue?.current && (player.queue?.length || 0) === 0) {
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
        console.log(`🎵 Startup music attempt ${attempt}/5: searching "${seed}"`);

        const result = await reliableSearch(manager, seed, manager.client.user);
        const track = result?.tracks?.find(Boolean);

        if (!track) continue;

        if (player.playing || player.paused || player.queue?.current || (player.queue?.length || 0) > 0) {
          return true;
        }

        player.queue.add(track);
        await player.play();

        state.autoplayContext = {
          query: seed,
          artist: manager.getTrackAuthor(track),
          title: manager.getTrackTitle(track)
        };

        state.autoplayGeneration = (state.autoplayGeneration || 0) + 1;

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

  MusicManager.prototype.autoplayNext = async function(guildId, player = this.getPlayer(guildId)) {
    return reliableAutoplayNext(this, guildId, player);
  };

  MusicManager.prototype.setupEvents = function() {
    originalSetupEvents.call(this);

    if (this.__deathTransitionRecoveryInstalled) return;
    this.__deathTransitionRecoveryInstalled = true;
    this.__deathTransitionTimers = new Map();

    const scheduleRecovery = (player, reason) => {
      const guildId = player?.guildId;
      if (!guildId) return;

      const old = this.__deathTransitionTimers.get(guildId);
      if (old) clearTimeout(old);

      console.log(`🔁 Track transition recovery scheduled (${reason}) | guild=${guildId}`);

      const timer = setTimeout(async () => {
        this.__deathTransitionTimers.delete(guildId);

        const currentPlayer = this.getPlayer(guildId);
        const state = this.getState(guildId);

        if (!currentPlayer || !state.autoplay) return;
        if (currentPlayer.playing || currentPlayer.paused) return;

        try {
          const started = await this.autoplayNext(guildId, currentPlayer);
          console.log(`🔁 Track transition recovery result=${started} | guild=${guildId}`);

          if (!started && state.autoplay) {
            const retry = setTimeout(() => {
              this.__deathTransitionTimers.delete(guildId);
              const p = this.getPlayer(guildId);
              if (p && this.getState(guildId).autoplay && !p.playing && !p.paused) {
                this.autoplayNext(guildId, p).catch(error =>
                  console.warn("⚠️ Transition retry failed:", error?.message || error)
                );
              }
            }, 2500);
            this.__deathTransitionTimers.set(guildId, retry);
          }
        } catch (error) {
          console.warn("⚠️ Track transition recovery failed:", error?.message || error);
        }
      }, 1500);

      this.__deathTransitionTimers.set(guildId, timer);
    };

    this.kazagumo.on("playerEnd", player => scheduleRecovery(player, "playerEnd"));
    this.kazagumo.on("playerException", player => scheduleRecovery(player, "playerException"));
    this.kazagumo.on("playerStuck", player => scheduleRecovery(player, "playerStuck"));
    this.kazagumo.on("playerEmpty", player => scheduleRecovery(player, "playerEmpty"));

    console.log("🛡️ DEATH track-transition recovery installed.");
  };

  MusicManager.prototype.ensure247 = async function(guildId = this.musicGuildId) {
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
      console.error("❌ 24/7 player was not created; startup music cannot begin.");
      return null;
    }

    console.log("🔊 24/7 voice player connected. Checking reliable startup playback...");

    if (!player.playing && !player.paused && !player.queue?.current && (player.queue?.length || 0) === 0) {
      await forceStartupMusic(this, guildId, player);
    }

    await this.refreshPanel(guildId).catch(() => {});
    console.log("🎵 Startup autoplay/panel sequence completed.");
    return player;
  };
}

console.log("🛠️ DEATH reliable yt-dlp playback + transition recovery patch loaded.");
