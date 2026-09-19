"use strict";

/* DEATH fast music controls: UI actions return immediately while playback work runs in background. */
const MusicManager = require("./DirectMusicManager");
const { AudioPlayerStatus } = require("@discordjs/voice");

if (!MusicManager.prototype.__deathFastControlsPatched) {
  MusicManager.prototype.__deathFastControlsPatched = true;

  const originalHandleTrackEnd = MusicManager.prototype.handleTrackEnd;
  if (originalHandleTrackEnd && !MusicManager.prototype.__deathHandleTrackEndGuarded) {
    MusicManager.prototype.__deathHandleTrackEndGuarded = true;
    MusicManager.prototype.handleTrackEnd = async function guardedHandleTrackEnd(guildId, ...args) {
      const state = this.getState(guildId);
      if (state.transitioning) return;
      return originalHandleTrackEnd.call(this, guildId, ...args);
    };
  }

  MusicManager.prototype.pause = async function fastPause(guildId) {
    const player = this.players.get(guildId);
    if (!player) throw new Error("Music player is not active.");
    if (player.state.status === AudioPlayerStatus.Paused) return;
    if (player.state.status === AudioPlayerStatus.Idle && !this.getState(guildId).current) return;
    player.pause(true);
    const state = this.getState(guildId);
    state.positionOffset = this.getPosition(guildId);
    state.paused = true;
    Promise.resolve(this.refreshPanel(guildId)).catch(() => {});
  };

  MusicManager.prototype.resume = async function fastResume(guildId) {
    const player = this.players.get(guildId);
    if (!player) throw new Error("Music player is not active.");
    const state = this.getState(guildId);

    // Play is also a recovery button. If a source just failed and the player
    // is idle, immediately arm the normal autoplay/source recovery path.
    if (!state.current && state.autoplay && !state.intentionalLeave) {
      state.transitioning = true;
      Promise.resolve(this.autoplayNext(guildId)).catch(error => {
        state.transitioning = false;
        console.warn(`⚠️ Play-button recovery failed: ${error?.message || error}`);
      });
      return;
    }

    if (player.state.status !== AudioPlayerStatus.Paused && !state.current) return;
    player.unpause();
    state.startedAt = Date.now();
    state.paused = false;
    Promise.resolve(this.refreshPanel(guildId)).catch(() => {});
  };

  MusicManager.prototype.skip = async function fastSkip(guildId) {
    const state = this.getState(guildId);
    const player = this.players.get(guildId);
    if (state.transitioning) return;

    const resourceTrack = player?.state?.resource?.metadata || null;
    const ended = resourceTrack || state.current || null;

    if (!ended) {
      const next = state.queue.shift();
      if (next) {
        state.transitioning = true;
        state.current = next;
        state.startedAt = 0;
        state.positionOffset = 0;
        Promise.resolve(this.refreshPanel(guildId)).catch(() => {});
        Promise.resolve(this.startTrack(guildId, next, 0, { handoff: true })).catch(error => {
          state.transitioning = false;
          console.warn(`⚠️ Skip recovery failed: ${error?.message || error}`);
          if (state.autoplay && !state.intentionalLeave) Promise.resolve(this.autoplayNext(guildId)).catch(() => {});
        });
        return;
      }
      if (state.autoplay && !state.intentionalLeave) {
        state.transitioning = true;
        Promise.resolve(this.autoplayNext(guildId)).catch(error => {
          state.transitioning = false;
          console.warn(`⚠️ Skip autoplay recovery failed: ${error?.message || error}`);
        });
        return;
      }
      Promise.resolve(this.refreshPanel(guildId)).catch(() => {});
      return;
    }

    state.transitioning = true;

    // Prepare the replacement while the current resource remains alive.
    // startTrack() performs an atomic Discord audio-resource handoff once real PCM exists.
    const next = state.queue.shift();
    if (next) {
      state.current = next;
      state.startedAt = 0;
      state.positionOffset = 0;
      Promise.resolve(this.refreshPanel(guildId)).catch(() => {});
      Promise.resolve(this.startTrack(guildId, next)).catch(error => {
        state.transitioning = false;
        console.warn(`⚠️ Fast skip next track failed: ${error?.message || error}`);
        if (state.autoplay && !state.intentionalLeave) {
          state.transitioning = true;
          Promise.resolve(this.autoplayNext(guildId)).catch(() => { state.transitioning = false; });
        }
      });
    } else if (state.autoplay && !state.intentionalLeave) {
      Promise.resolve(this.refreshPanel(guildId)).catch(() => {});
      Promise.resolve(this.autoplayNext(guildId)).catch(error => {
        state.transitioning = false;
        console.warn(`⚠️ Fast skip autoplay failed: ${error?.message || error}`);
      });
    } else {
      state.transitioning = false;
      Promise.resolve(this.refreshPanel(guildId)).catch(() => {});
    }

    console.log(`⏭️ Instant skip requested: ${this.getTrackTitle(ended)}`);
  };

  MusicManager.prototype.stop = async function fastStop(guildId) {
    const state = this.getState(guildId);
    state.transitioning = false;
    this.destroyStream(guildId);
    state.queue = [];
    state.current = null;
    state.startedAt = 0;
    state.positionOffset = 0;
    state.paused = false;
    state.audioResource = null;
    try { this.players.get(guildId)?.stop(true); } catch {}
    console.log(`⏹️ Fast stop: ${guildId}`);
    Promise.resolve(this.refreshPanel(guildId)).catch(() => {});
  };

  MusicManager.prototype.shuffle = async function fastShuffle(guildId) {
    const state = this.getState(guildId);
    for (let i = state.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [state.queue[i], state.queue[j]] = [state.queue[j], state.queue[i]];
    }
    Promise.resolve(this.refreshPanel(guildId)).catch(() => {});
  };

  MusicManager.prototype.setLoop = async function fastSetLoop(guildId, mode) {
    if (!["none", "track", "queue"].includes(mode)) throw new Error("Invalid loop mode.");
    this.getState(guildId).loop = mode;
    Promise.resolve(this.refreshPanel(guildId)).catch(() => {});
    return mode;
  };

  MusicManager.prototype.setVolume = async function fastSetVolume(guildId, level) {
    const state = this.getState(guildId);
    state.volume = Math.max(1, Math.min(100, Number(level) || this.defaultVolume));
    const player = this.players.get(guildId);
    const resource = player?.state?.resource || state.audioResource;
    if (resource?.volume) resource.volume.setVolume(Math.max(0.01, state.volume / 100));
    Promise.resolve(this.refreshPanel(guildId)).catch(() => {});
    return state.volume;
  };

  MusicManager.prototype.seek = async function fastSeek(guildId, ms) {
    const state = this.getState(guildId);
    if (!state.current) throw new Error("Nothing is playing.");
    const target = Math.max(0, Number(ms) || 0);
    await this.startTrack(guildId, state.current, target);
  };

  console.log("⚡ DEATH instant controls loaded: live-resource skip + background transitions + live panel updates + recovery buttons.");
}
