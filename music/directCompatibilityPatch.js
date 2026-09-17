"use strict";

const MusicManager = require("./DirectMusicManager");

// index-direct.js owns the single ClientReady -> ensure247 startup path.
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

  if (state.loop === "queue" && !ended.isAutoplay) state.queue.push({ ...ended });

  const next = state.queue.shift();
  if (next) await this.startTrack(guildId, next);
  else if (state.autoplay && !state.intentionalLeave) await this.autoplayNext(guildId).catch(() => {});

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

// Ignore stale READY/VOICE_STATE events from the previous container during a
// Railway restart. A real move/disconnect is only actionable after this
// process has an active connection registered for the guild.
MusicManager.prototype.handleVoiceStateUpdate = async function handleVoiceStateUpdate(oldState, newState) {
  if (newState.guild?.id !== this.musicGuildId) return;
  if (newState.id !== this.client.user?.id) return;

  const guildId = newState.guild.id;
  const state = this.getState(guildId);
  if (state.intentionalLeave) return;
  if (!this.connections.has(guildId)) return;
  if (newState.channelId === this.musicVoiceChannelId) return;
  if (oldState.channelId !== this.musicVoiceChannelId) return;

  console.warn("🟠 DEATH left the permanent music channel; reconnecting.");
  await this.reconnect(guildId, this.musicVoiceChannelId).catch(error => {
    console.warn("⚠️ Voice-state recovery failed:", error?.message || error);
  });
};
