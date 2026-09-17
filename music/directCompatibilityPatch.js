"use strict";

const MusicManager = require("./DirectMusicManager");

// index-direct.js owns the single ClientReady -> ensure247 startup path.
// DirectMusicManager used to register a second legacy `ready` listener in its
// constructor, which caused two simultaneous voice connections/startups and
// could abort the autoplay startup sequence. Keep setupPlayerEvents as a
// compatibility no-op; the recovery loop and index-direct startup handle it.
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
