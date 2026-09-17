"use strict";

/*
 * DEATH Music startup compatibility patch.
 *
 * The previous runtime patch replaced ensure247() and returned immediately
 * after joining voice. That prevented the normal startup sequence from
 * creating the panel and starting autoplay. Keep voice handling in
 * MusicManager and only provide the missing startup autoplay context.
 */

const MusicManager = require("./MusicManager");

const originalEnsure247 = MusicManager.prototype.ensure247;

if (!MusicManager.prototype.__deathStartupAutoplayPatch) {
  MusicManager.prototype.__deathStartupAutoplayPatch = true;

  MusicManager.prototype.ensure247 = async function(guildId = this.musicGuildId) {
    if (!guildId) return null;

    const state = this.getState(guildId);

    if (!state.autoplayContext) {
      state.autoplayContext = {
        query: "popular music",
        artist: "",
        title: ""
      };
    }

    const player = await originalEnsure247.call(this, guildId);

    if (player) {
      console.log("🎵 Startup autoplay/panel sequence completed.");
    }

    return player;
  };
}

console.log("🛠️ DEATH startup autoplay repair loaded.");
