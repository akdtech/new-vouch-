"use strict";

const MusicManager = require("./DirectMusicManager");

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
