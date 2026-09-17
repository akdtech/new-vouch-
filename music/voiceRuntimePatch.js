"use strict";

/*
 * DEATH Music 24/7 startup patch.
 *
 * Voice join, panel creation, and autoplay are separate operations. The bot
 * must not consider startup complete merely because Discord voice connected.
 * After the player joins, explicitly guarantee that a playable track is
 * queued and started.
 */

const MusicManager = require("./MusicManager");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const originalEnsure247 = MusicManager.prototype.ensure247;

async function forceStartupMusic(manager, guildId, player) {
  if (!player) return false;

  const state = manager.getState(guildId);
  state.autoplay = true;

  if (player.playing || player.paused || player.queue?.current || (player.queue?.length || 0) > 0) {
    return true;
  }

  const seeds = [
    "popular music",
    "top hits",
    "chill music",
    "gaming music",
    "lofi beats"
  ];

  for (let attempt = 1; attempt <= 5; attempt++) {
    for (const seed of seeds) {
      try {
        console.log(`🎵 Startup music attempt ${attempt}/5: searching "${seed}"`);

        const result = await manager.search(seed, manager.client.user);
        const track = result?.tracks?.find(Boolean);

        if (!track) {
          console.warn(`⚠️ Startup search returned no playable track for "${seed}".`);
          continue;
        }

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

        console.log(`🎵 AUTO PLAY STARTED: ${manager.getTrackTitle(track)} — ${manager.getTrackAuthor(track)}`);
        await manager.refreshPanel(guildId).catch(() => {});
        return true;
      } catch (error) {
        console.warn(`⚠️ Startup music failed for "${seed}":`, error?.message || error);
      }
    }

    await sleep(2000);
  }

  console.error("❌ Startup music could not start after 5 attempts.");
  return false;
}

if (!MusicManager.prototype.__deathStartupAutoplayPatch) {
  MusicManager.prototype.__deathStartupAutoplayPatch = true;

  MusicManager.prototype.ensure247 = async function(guildId = this.musicGuildId) {
    if (!guildId) return null;

    const state = this.getState(guildId);
    state.autoplay = true;

    if (!state.autoplayContext) {
      state.autoplayContext = {
        query: "popular music",
        artist: "",
        title: ""
      };
    }

    const player = await originalEnsure247.call(this, guildId);

    if (!player) {
      console.error("❌ 24/7 player was not created; startup music cannot begin.");
      return null;
    }

    console.log("🔊 24/7 voice player connected. Checking startup playback...");

    if (!player.playing && !player.paused && !player.queue?.current && (player.queue?.length || 0) === 0) {
      await forceStartupMusic(this, guildId, player);
    }

    await this.refreshPanel(guildId).catch(() => {});

    console.log("🎵 Startup autoplay/panel sequence completed.");
    return player;
  };
}

console.log("🛠️ DEATH forced startup autoplay patch loaded.");
