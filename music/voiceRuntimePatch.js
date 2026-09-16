"use strict";

/*
 * DEATH Music voice runtime repair.
 *
 * Kazagumo marks a player CONNECTED immediately after sending Discord's
 * voice-state payload. That does not guarantee that Discord actually put
 * the bot in the voice channel. A stale Shoukaku player can also remain in
 * Kazagumo.players after a websocket close, causing ensure247() to report
 * "voice connected" forever without the bot actually being in the call.
 *
 * This patch makes Discord's own GuildMember voice state the source of truth.
 * If the bot is not actually in the configured voice channel, the stale
 * player is destroyed and a fresh player is created with retries.
 */

console.log("🛠️ DEATH voice runtime repair preloaded.");

const Module = require("module");
const previousLoad = Module._load;
let patched = false;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function isDestroyed(player) {
  return !player || player.destroyed === true || player.state === "DESTROYED" || player.state === 5;
}

function channelIdFromMember(client, guildId) {
  try {
    const guild = client.guilds.cache.get(guildId);
    return guild?.members?.me?.voice?.channelId || null;
  } catch {
    return null;
  }
}

async function waitForDiscordVoice(client, guildId, channelId, timeout = 12000) {
  const started = Date.now();

  while (Date.now() - started < timeout) {
    const actual = channelIdFromMember(client, guildId);
    if (actual === channelId) return true;
    await sleep(500);
  }

  return channelIdFromMember(client, guildId) === channelId;
}

Module._load = function(request, parent, isMain) {
  const exported = previousLoad.apply(this, arguments);

  if (
    !patched &&
    typeof exported === "function" &&
    /(^|[\\/])music[\\/]MusicManager(?:\.js)?$/.test(request)
  ) {
    patched = true;

    const MusicManager = exported;
    const originalEnsure247 = MusicManager.prototype.ensure247;
    const originalCreatePlayer = MusicManager.prototype.createPlayer;

    MusicManager.prototype.createPlayer = async function(guildId, voiceId, textId = voiceId) {
      const player = await originalCreatePlayer.call(this, guildId, voiceId, textId);
      return player;
    };

    MusicManager.prototype.ensure247 = async function(guildId = this.musicGuildId) {
      if (!guildId || !this.musicVoiceChannelId) return null;

      const targetChannelId = this.musicVoiceChannelId;
      let player = null;

      for (let attempt = 1; attempt <= 4; attempt++) {
        try {
          const guild = this.client.guilds.cache.get(guildId);
          const channel = guild?.channels?.cache?.get(targetChannelId);

          if (!guild || !channel || !channel.isVoiceBased()) {
            console.error(`❌ Voice repair: configured channel ${targetChannelId} is unavailable.`);
            return null;
          }

          const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
          const permissions = me ? channel.permissionsFor(me) : null;

          if (permissions && (!permissions.has("Connect") || !permissions.has("Speak"))) {
            console.error(`❌ Voice repair: bot needs CONNECT and SPEAK in ${channel.name}.`);
            return null;
          }

          const actualBefore = channelIdFromMember(this.client, guildId);
          if (actualBefore === targetChannelId) {
            player = this.getPlayer(guildId);
            if (player) {
              console.log(`♾️ Voice verified in Discord: ${guild.name} / ${channel.name}`);
              return player;
            }
          }

          const stale = this.getPlayer(guildId);
          if (stale) {
            console.warn(`🔄 Voice repair attempt ${attempt}: removing stale player state.`);
            try { await stale.destroy(); } catch {}
            try { this.kazagumo.players.delete(guildId); } catch {}
            try { this.players.delete(guildId); } catch {}
            await sleep(1000);
          }

          console.log(`🔊 Voice repair attempt ${attempt}/4: joining ${channel.name} (${targetChannelId})`);

          player = await this.kazagumo.createPlayer({
            guildId,
            voiceId: targetChannelId,
            textId: targetChannelId,
            deaf: true,
            volume: this.defaultVolume
          });

          this.players.set(guildId, player);

          const joined = await waitForDiscordVoice(
            this.client,
            guildId,
            targetChannelId,
            12000
          );

          if (joined) {
            const state = this.getState(guildId);
            state.permanent = true;
            console.log(`✅ Discord voice VERIFIED: ${guild.name} / ${channel.name}`);
            return player;
          }

          const actual = channelIdFromMember(this.client, guildId);
          console.error(`❌ Voice attempt ${attempt} failed: Discord reports channel=${actual || "none"}.`);

          try { await player.destroy(); } catch {}
          try { this.kazagumo.players.delete(guildId); } catch {}
          try { this.players.delete(guildId); } catch {}
          await sleep(1500);
        } catch (error) {
          console.error(`❌ Voice repair attempt ${attempt} failed:`, error?.message || error);
          try { if (player) await player.destroy(); } catch {}
          try { this.kazagumo.players.delete(guildId); } catch {}
          try { this.players.delete(guildId); } catch {}
          await sleep(1500);
        }
      }

      console.error(`❌ Voice repair exhausted retries for guild ${guildId}.`);
      return null;
    };

    // A Shoukaku websocket close leaves a Kazagumo player object behind in
    // some failure modes. Destroy it and let the recovery loop recreate it.
    try {
      this.kazagumo.on("playerClosed", async player => {
        if (!player?.guildId) return;
        const guildId = player.guildId;
        if (guildId !== this.musicGuildId) return;

        console.warn(`🔌 Voice player closed; scheduling verified reconnect | guild=${guildId}`);

        try { await player.destroy(); } catch {}
        try { this.kazagumo.players.delete(guildId); } catch {}
        try { this.players.delete(guildId); } catch {}

        setTimeout(() => {
          this.ensure247(guildId).catch(error => {
            console.error("❌ Voice reconnect after player close failed:", error?.message || error);
          });
        }, 2000);
      });
    } catch (error) {
      console.warn("⚠️ Could not register playerClosed recovery:", error?.message || error);
    }

    console.log("🛠️ DEATH voice runtime repair hooked MusicManager.");
  }

  return exported;
};
