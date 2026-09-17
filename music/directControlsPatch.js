"use strict";

/*
 * DEATH fast music controls.
 *
 * Discord buttons should feel instant. Control actions never wait for a
 * network-heavy YouTube lookup, FFmpeg startup, or panel edit. Panel updates
 * and next-track startup run in the background.
 */
const MusicManager = require("./DirectMusicManager");
const { AudioPlayerStatus } = require("@discordjs/voice");

if (!MusicManager.prototype.__deathFastControlsPatched) {
  MusicManager.prototype.__deathFastControlsPatched = true;

  const backgroundPanel = manager => {
    Promise.resolve(manager.refreshPanel?.(arguments[1])).catch(() => {});
  };

  MusicManager.prototype.pause = async function fastPause(guildId) {
    const player = this.players.get(guildId);
    if (!player) throw new Error("Music player is not active.");
    if (player.state.status === AudioPlayerStatus.Paused) return;
    player.pause(true);
    const state = this.getState(guildId);
    state.positionOffset = this.getPosition(guildId);
    state.paused = true;
    Promise.resolve(this.refreshPanel(guildId)).catch(() => {});
  };

  MusicManager.prototype.resume = async function fastResume(guildId) {
    const player = this.players.get(guildId);
    if (!player) throw new Error("Music player is not active.");
    player.unpause();
    const state = this.getState(guildId);
    state.startedAt = Date.now();
    state.paused = false;
    Promise.resolve(this.refreshPanel(guildId)).catch(() => {});
  };

  MusicManager.prototype.skip = async function fastSkip(guildId) {
    const state = this.getState(guildId);
    if (!state.current) throw new Error("Nothing is playing.");

    const player = this.players.get(guildId);
    const ended = state.current;

    // Clear state BEFORE stop(). This prevents the player's Idle event from
    // running a second transition while the explicit skip is already doing it.
    this.destroyStream(guildId);
    state.current = null;
    state.startedAt = 0;
    state.positionOffset = 0;
    state.paused = false;
    try { player?.stop(true); } catch {}

    const next = state.queue.shift();
    if (next) {
      // Start immediately in the background. The Discord interaction itself
      // can finish without waiting for yt-dlp/YouTube/FFmpeg.
      Promise.resolve(this.startTrack(guildId, next)).catch(error => {
        console.warn(`⚠️ Fast skip next track failed: ${error?.message || error}`);
        if (state.autoplay && !state.intentionalLeave) {
          Promise.resolve(this.autoplayNext(guildId)).catch(() => {});
        }
      });
    } else if (state.autoplay && !state.intentionalLeave) {
      Promise.resolve(this.autoplayNext(guildId)).catch(error => {
        console.warn(`⚠️ Fast skip autoplay failed: ${error?.message || error}`);
      });
    }

    console.log(`⏭️ Fast skip: ${this.getTrackTitle(ended)}`);
    Promise.resolve(this.refreshPanel(guildId)).catch(() => {});
  };

  MusicManager.prototype.stop = async function fastStop(guildId) {
    const state = this.getState(guildId);
    this.destroyStream(guildId);
    state.queue = [];
    state.current = null;
    state.startedAt = 0;
    state.positionOffset = 0;
    state.paused = false;
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

    // Do NOT restart the current YouTube stream just to change volume.
    // Restarting causes a fresh yt-dlp extraction and makes the button feel
    // extremely slow. Keep the existing AudioResource and change its volume.
    const player = this.players.get(guildId);
    const resource = player?.state?.resource || state.audioResource;
    if (resource?.volume) {
      resource.volume.setVolume(Math.max(0.01, state.volume / 100));
    }

    Promise.resolve(this.refreshPanel(guildId)).catch(() => {});
    return state.volume;
  };

  MusicManager.prototype.seek = async function fastSeek(guildId, ms) {
    const state = this.getState(guildId);
    if (!state.current) throw new Error("Nothing is playing.");
    const target = Math.max(0, Number(ms) || 0);
    // Seeking necessarily restarts the source, so this remains an awaited
    // operation unlike the lightweight controls above.
    await this.startTrack(guildId, state.current, target);
  };

  console.log("⚡ DEATH fast music controls loaded: instant buttons + non-blocking transitions.");
}
