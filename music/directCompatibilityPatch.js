"use strict";

const MusicManager = require("./DirectMusicManager");

// index-direct.js owns the single ClientReady -> ensure247 startup path.
// DirectMusicManager used to register a second legacy `ready` listener in its
// constructor, which caused duplicate voice startup and aborted autoplay.
MusicManager.prototype.setupPlayerEvents = function setupPlayerEvents() {};

MusicManager.prototype.skip = async function skip(guildId) {
  const state = this.getState(guildId);
  const player = this.players.get(guildId);
  if (!state.current) throw new Error("Nothing is playing.");

  const ended = state.current;
  this.destroyStream(guildId);
  state.current = null;
  state.startedAt = 0;
  state.positionOffset = 0;
  try { player?.stop(true); } catch {}

  if (state.loop === "queue" && !ended.isAutoplay) {
    state.queue.push({ ...ended });
  }

  const next = state.queue.shift();
  if (next) {
    await this.startTrack(guildId, next);
  } else if (state.autoplay && !state.intentionalLeave) {
    await this.autoplayNext(guildId).catch(() => {});
  }

  await this.refreshPanel(guildId).catch(() => {});
};

const originalReconnect = MusicManager.prototype.reconnect;
MusicManager.prototype.reconnect = async function reconnect(guildId, voiceId) {
  await originalReconnect.call(this, guildId, voiceId);
  const connection = this.connections.get(guildId);
  const player = this.players.get(guildId);
  if (connection && player) {
    try { connection.subscribe(player); } catch {}
  }
};

// A bot joining/disconnecting during startup emits transient VoiceStateUpdate
// events. Only recover when the bot was actually in the permanent music
// channel and then moved somewhere else (or disconnected from it).
MusicManager.prototype.handleVoiceStateUpdate = async function handleVoiceStateUpdate(oldState, newState) {
  if (newState.guild?.id !== this.musicGuildId) return;
  if (newState.id !== this.client.user?.id) return;

  const state = this.getState(newState.guild.id);
  if (state.intentionalLeave) return;
  if (newState.channelId === this.musicVoiceChannelId) return;
  if (oldState.channelId !== this.musicVoiceChannelId) return;

  console.warn("🟠 DEATH left the permanent music channel; reconnecting.");
  await this.reconnect(newState.guild.id, this.musicVoiceChannelId).catch(error => {
    console.warn("⚠️ Voice-state recovery failed:", error?.message || error);
  });
};
