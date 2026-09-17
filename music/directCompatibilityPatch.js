"use strict";

const MusicManager = require("./DirectMusicManager");
const PATCH_STARTED_AT = Date.now();
const STARTUP_GRACE_MS = 30000;
const RECOVERY_INTERVAL_MS = 10000;

// index-direct.js owns the single ClientReady -> ensure247 startup path.
MusicManager.prototype.setupPlayerEvents = function setupPlayerEvents() {};

// Permanent GMAO music must always start with autoplay enabled.
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
  const state = this.getState(guildId);
  const player = this.players.get(guildId);
  const current = state.current;
  const position = current ? this.getPosition(guildId) : 0;

  await originalReconnect.call(this, guildId, voiceId);

  const connection = this.connections.get(guildId);
  const activePlayer = this.players.get(guildId) || player;
  if (connection && activePlayer) {
    try { connection.subscribe(activePlayer); } catch {}
  }

  // A voice reconnect can leave the old Discord audio player alive but silent.
  // Restart the current track from approximately where it stopped instead of
  // waiting for an Idle event that may never arrive.
  if (current && state.current === current && !state.intentionalLeave) {
    const status = activePlayer?.state?.status;
    if (status !== "playing" && status !== "paused") {
      await this.startTrack(guildId, current, position).catch(error => {
        console.warn(`⚠️ Current-track recovery failed [${guildId}]: ${error?.message || error}`);
      });
    }
  } else if (!state.current && !state.queue.length && state.autoplay && !state.intentionalLeave) {
    await this.autoplayNext(guildId).catch(() => {});
  }
};

// Continuous watchdog. VoiceStateUpdate alone is not sufficient because a
// Discord voice gateway failure can leave a stale connection object in memory.
// Every 10 seconds we verify BOTH the Discord member's actual voice channel
// and the local VoiceConnection state, then rebuild/restart when needed.
MusicManager.prototype.startRecoveryLoop = function startRecoveryLoop() {
  if (this.recoveryStarted) return;
  this.recoveryStarted = true;

  const tick = async () => {
    const guildId = this.musicGuildId;
    if (!guildId) return;
    const state = this.getState(guildId);
    if (!state.permanent || state.intentionalLeave) return;
    if (Date.now() - PATCH_STARTED_AT < STARTUP_GRACE_MS) return;
    if (this.__deathRecoveryBusy) return;

    const guild = this.client.guilds.cache.get(guildId);
    const me = guild?.members?.me;
    const actualChannelId = me?.voice?.channelId || null;
    const connection = this.connections.get(guildId);
    const connectionStatus = connection?.state?.status || "missing";
    const player = this.players.get(guildId);
    const playerStatus = player?.state?.status || "missing";

    const voiceHealthy = actualChannelId === this.musicVoiceChannelId &&
      connection &&
      connectionStatus === "ready";

    if (!voiceHealthy) {
      this.__deathRecoveryBusy = true;
      try {
        console.warn(`♻️ 24/7 watchdog recovery | voice=${actualChannelId || "none"} connection=${connectionStatus}`);
        await this.reconnect(guildId, this.musicVoiceChannelId);
        console.log("✅ 24/7 watchdog voice recovery complete.");
      } catch (error) {
        console.warn(`⚠️ 24/7 watchdog recovery failed: ${error?.message || error}`);
      } finally {
        this.__deathRecoveryBusy = false;
      }
      return;
    }

    // If Discord voice is healthy but the player unexpectedly became idle with
    // no queued/current track, restart autoplay. If a current track exists,
    // the reconnect path will restore it when necessary.
    if (state.autoplay && !state.intentionalLeave && !state.autoplayBusy) {
      if (!state.current && !state.queue.length && playerStatus === "idle") {
        await this.autoplayNext(guildId).catch(() => {});
      } else if (state.current && playerStatus === "idle") {
        const position = this.getPosition(guildId);
        await this.startTrack(guildId, state.current, position).catch(() => {});
      }
    }
  };

  this.recoveryTimer = setInterval(() => {
    tick().catch(error => console.warn("⚠️ 24/7 watchdog tick:", error?.message || error));
  }, RECOVERY_INTERVAL_MS);

  console.log("🛡️ Direct music recovery watchdog active (10s).");
};

// Ignore stale READY/VOICE_STATE events from the previous container during a
// Railway restart. A real move/disconnect is handled by the watchdog as well.
MusicManager.prototype.handleVoiceStateUpdate = async function handleVoiceStateUpdate(oldState, newState) {
  if (newState.guild?.id !== this.musicGuildId) return;
  if (newState.id !== this.client.user?.id) return;
  if (Date.now() - PATCH_STARTED_AT < STARTUP_GRACE_MS) return;

  const guildId = newState.guild.id;
  const state = this.getState(guildId);
  if (state.intentionalLeave) return;
  if (newState.channelId === this.musicVoiceChannelId) return;
  if (oldState.channelId !== this.musicVoiceChannelId) return;
  if (this.__deathRecoveryBusy) return;

  console.warn("🟠 DEATH left the permanent music channel; reconnecting.");
  await this.reconnect(guildId, this.musicVoiceChannelId).catch(error => {
    console.warn("⚠️ Voice-state recovery failed:", error?.message || error);
  });
};
