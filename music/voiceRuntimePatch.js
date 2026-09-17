"use strict";

/*
 * DEATH Music voice runtime repair.
 *
 * This patch is loaded directly before index.js. Requiring MusicManager here
 * is intentional: it guarantees the real class is patched before index.js
 * creates the manager instance. Discord's GuildMember voice state is the
 * source of truth; Kazagumo's player object alone is not enough.
 */

console.log("🛠️ DEATH voice runtime repair preloaded.");

const MusicManager = require("./MusicManager");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function actualVoiceChannelId(client, guildId) {
  try {
    const guild = client.guilds.cache.get(guildId);
    return guild?.members?.me?.voice?.channelId || null;
  } catch {
    return null;
  }
}

async function waitForVoice(client, guildId, channelId, timeout = 15000) {
  const started = Date.now();

  while (Date.now() - started < timeout) {
    if (actualVoiceChannelId(client, guildId) === channelId) return true;
    await sleep(500);
  }

  return actualVoiceChannelId(client, guildId) === channelId;
}

const originalEnsure247 = MusicManager.prototype.ensure247;

MusicManager.prototype.ensure247 = async function(guildId = this.musicGuildId) {
  if (!guildId || !this.musicVoiceChannelId) return null;

  const targetChannelId = this.musicVoiceChannelId;

  for (let attempt = 1; attempt <= 5; attempt++) {
    let player = null;

    try {
      const guild = this.client.guilds.cache.get(guildId);
      const channel = guild?.channels?.cache?.get(targetChannelId);

      if (!guild) {
        console.error(`❌ Voice repair: guild ${guildId} is not cached.`);
        return null;
      }

      if (!channel || !channel.isVoiceBased()) {
        console.error(`❌ Voice repair: channel ${targetChannelId} is unavailable or is not a voice channel.`);
        return null;
      }

      const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
      const permissions = me ? channel.permissionsFor(me) : null;

      if (permissions && (!permissions.has("Connect") || !permissions.has("Speak"))) {
        console.error(`❌ Voice repair: bot needs CONNECT and SPEAK in ${channel.name}.`);
        return null;
      }

      const before = actualVoiceChannelId(this.client, guildId);
      const existing = this.getPlayer(guildId);

      if (before === targetChannelId && existing) {
        this.getState(guildId).permanent = true;
        console.log(`♾️ Voice verified in Discord: ${guild.name} / ${channel.name}`);
        return existing;
      }

      if (existing) {
        console.warn(`🔄 Voice repair attempt ${attempt}/5: removing stale player.`);
        try { await existing.destroy(); } catch {}
        try { this.kazagumo.players.delete(guildId); } catch {}
        try { this.players.delete(guildId); } catch {}
        await sleep(1000);
      }

      console.log(`🔊 Voice repair attempt ${attempt}/5: joining ${channel.name} (${targetChannelId})`);

      player = await this.kazagumo.createPlayer({
        guildId,
        voiceId: targetChannelId,
        textId: targetChannelId,
        deaf: true,
        volume: this.defaultVolume
      });

      this.players.set(guildId, player);

      const joined = await waitForVoice(
        this.client,
        guildId,
        targetChannelId,
        15000
      );

      if (joined) {
        const state = this.getState(guildId);
        state.permanent = true;
        console.log(`✅ Discord voice VERIFIED: ${guild.name} / ${channel.name}`);
        return player;
      }

      const actual = actualVoiceChannelId(this.client, guildId);
      console.error(`❌ Voice attempt ${attempt} failed: Discord reports channel=${actual || "none"}.`);

      try { await player.destroy(); } catch {}
      try { this.kazagumo.players.delete(guildId); } catch {}
      try { this.players.delete(guildId); } catch {}
      await sleep(2000);
    } catch (error) {
      console.error(`❌ Voice repair attempt ${attempt} failed:`, error?.message || error);
      try { if (player) await player.destroy(); } catch {}
      try { this.kazagumo.players.delete(guildId); } catch {}
      try { this.players.delete(guildId); } catch {}
      await sleep(2000);
    }
  }

  console.error(`❌ Voice repair exhausted retries for guild ${guildId}.`);
  return null;
};

console.log("🛠️ DEATH voice runtime repair hooked MusicManager directly.");
