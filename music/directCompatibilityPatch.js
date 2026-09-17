"use strict";

const MusicManager = require("./DirectMusicManager");
const PATCH_STARTED_AT = Date.now();
const STARTUP_GRACE_MS = 30000;

// index-direct.js owns the single ClientReady -> ensure247 startup path.
MusicManager.prototype.setupPlayerEvents = function setupPlayerEvents() {};

// Make the permanent GMAO music service start autoplay on the first boot even
// if AUTOPLAY_DEFAULT was left disabled in an older Railway environment.
// After first boot, the normal Autoplay button/setting controls the state.
const originalEnsure247 = MusicManager.prototype.ensure247;
MusicManager.prototype.ensure247 = async function ensure247(guildId) {
  const state = this.getState(guildId);
  if (guildId === this.musicGuildId && !this.__deathPermanentStartupInitialized) {
    this.__deathPermanentStartupInitialized = true;
    state.autoplay = true;
    state.permanent = true;
    state.intentionalLeave = false;
  }
  return originalEnsure247.call(this, guildId);
};

// Discord voice can take several seconds to finish its gateway/UDP handshake.
// Do not let an entersState timeout abort the entire music startup. The
// VoiceConnection remains registered and will transition to Ready asynchronously.
const originalEnsureConnection = MusicManager.prototype.ensureConnection;
MusicManager.prototype.ensureConnection = async function ensureConnection(guildId, voiceId) {
  try {
    return await originalEnsureConnection.call(this, guildId, voiceId);
  } catch (error) {
    const connection = this.connections.get(guildId);
    if (connection && connection.state.status !== "destroyed") {
      console.warn(`⚠️ Voice handshake still in progress [${guildId}]: ${error?.message || error}`);
      return connection;
    }
    throw error;
  }
};

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
// Railway restart. A real move/disconnect is only actionable after startup.
MusicManager.prototype.handleVoiceStateUpdate = async function handleVoiceStateUpdate(oldState, newState) {
  if (newState.guild?.id !== this.musicGuildId) return;
  if (newState.id !== this.client.user?.id) return;
  if (Date.now() - PATCH_STARTED_AT < STARTUP_GRACE_MS) return;

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
