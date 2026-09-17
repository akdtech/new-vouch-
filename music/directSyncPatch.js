"use strict";

/* DEATH playback truth sync: Discord's live AudioResource is authoritative. */
const MusicManager = require("./DirectMusicManager");
const { AudioPlayerStatus } = require("@discordjs/voice");

if (!MusicManager.prototype.__deathDirectSyncPatched) {
  MusicManager.prototype.__deathDirectSyncPatched = true;

  const originalBindPlayerEvents = MusicManager.prototype.bindPlayerEvents;

  MusicManager.prototype.bindPlayerEvents = function syncBindPlayerEvents(guildId, player) {
    originalBindPlayerEvents.call(this, guildId, player);

    if (player.__deathTruthSyncBound) return;
    player.__deathTruthSyncBound = true;

    player.on(AudioPlayerStatus.Playing, () => {
      const state = this.getState(guildId);
      const liveTrack = player.state?.resource?.metadata;
      if (!liveTrack) return;

      // Never let an older state object win over the resource Discord is
      // actually outputting to the voice channel.
      state.current = liveTrack;
      state.transitioning = false;
      state.paused = false;
      state.startedAt = state.startedAt || Date.now();

      Promise.resolve(this.updateVoiceStatus?.(guildId, `🎵 ${this.getTrackTitle(liveTrack)}`)).catch(() => {});
      Promise.resolve(this.refreshPanel?.(guildId)).catch(() => {});
    });

    player.on(AudioPlayerStatus.Buffering, () => {
      const state = this.getState(guildId);
      const liveTrack = player.state?.resource?.metadata;
      if (!liveTrack) return;
      state.current = liveTrack;
      Promise.resolve(this.refreshPanel?.(guildId)).catch(() => {});
    });
  };

  console.log("🔄 DEATH truth sync loaded: panel + voice status follow the actual Discord audio resource.");
}
