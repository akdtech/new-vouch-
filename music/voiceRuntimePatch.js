"use strict";

/*
 * DEATH Music runtime repair.
 *
 * Responsibilities:
 *  - verify the bot is really inside the configured Discord voice channel;
 *  - rebuild stale Kazagumo players when Discord reports no voice session;
 *  - remove the Discord voice-channel status text used by the old panel;
 *  - replace the old multi-row panel with a small, useful control row;
 *  - return useful button confirmations instead of "Music control updated";
 *  - prefer a matching SoundCloud copy when a search result points to a
 *    YouTube track, and fall back to SoundCloud after a YouTube playback error.
 */

console.log("🛠️ DEATH voice runtime repair preloaded.");

const MusicManager = require("./MusicManager");
const { Client } = require("discord.js");
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require("discord.js");

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

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalize(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function textMatches(query, track) {
  const q = normalize(query);
  const title = normalize(track?.info?.title || track?.title);
  const author = normalize(track?.info?.author || track?.author);

  if (!q || !title) return false;
  if (title === q || title.includes(q)) return true;

  const wanted = q.split(" ").filter(x => x.length > 1);
  if (!wanted.length) return false;

  const haystack = `${title} ${author}`;
  const hits = wanted.filter(word => haystack.includes(word)).length;
  return hits >= Math.max(1, wanted.length - 1);
}

function isYouTubeTrack(track) {
  const source = String(
    track?.info?.sourceName ||
    track?.sourceName ||
    ""
  ).toLowerCase();

  return source === "youtube" || source === "youtube music";
}

function isSoundCloudTrack(track) {
  const source = String(
    track?.info?.sourceName ||
    track?.sourceName ||
    ""
  ).toLowerCase();

  return source === "soundcloud";
}

function buildCompactPanel(manager, guildId) {
  const player = manager.getPlayer(guildId);
  const current = player?.queue?.current;

  const title = current
    ? manager.getTrackTitle(current)
    : "Nothing is playing";

  const author = current
    ? manager.getTrackAuthor(current)
    : "DEATH Music 24/7";

  const duration = current?.info?.length || current?.length || 0;
  const position = player?.position || 0;
  const volume = player?.volume ?? manager.defaultVolume;

  const embed = new EmbedBuilder()
    .setTitle("💀 DEATH Music 24/7")
    .setDescription(`**${title}**\nArtist: **${author}**`)
    .addFields(
      {
        name: "Duration",
        value: manager.formatDuration(duration),
        inline: true
      },
      {
        name: "Position",
        value: manager.formatDuration(position),
        inline: true
      },
      {
        name: "Volume",
        value: `${volume}%`,
        inline: true
      }
    )
    .setFooter({ text: "DEATH × GMAO • Music controls" });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("death_music_pause")
      .setLabel("Pause")
      .setEmoji("⏸️")
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId("death_music_resume")
      .setLabel("Resume")
      .setEmoji("▶️")
      .setStyle(ButtonStyle.Success),

    new ButtonBuilder()
      .setCustomId("death_music_skip")
      .setLabel("Skip")
      .setEmoji("⏭️")
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId("death_music_stop")
      .setLabel("Stop")
      .setEmoji("⏹️")
      .setStyle(ButtonStyle.Danger),

    new ButtonBuilder()
      .setCustomId("death_music_shuffle")
      .setLabel("Shuffle")
      .setEmoji("🔀")
      .setStyle(ButtonStyle.Secondary)
  );

  return {
    embeds: [embed],
    components: [row]
  };
}

/* Remove the old Discord voice-channel status (the "🎵 Song" text). */
MusicManager.prototype.updateVoiceStatus = async function() {
  return true;
};

/* Replace the old large panel with the compact five-button version. */
MusicManager.prototype.buildPanelPayload = function(guildId) {
  return buildCompactPanel(this, guildId);
};

const originalSearch = MusicManager.prototype.search;
MusicManager.prototype.search = async function(query, requester = null) {
  const result = await originalSearch.call(this, query, requester);

  if (!result?.tracks?.length) return result;
  if (/^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(clean(query))) {
    return result;
  }

  const best = result.tracks[0];
  if (!isYouTubeTrack(best)) return result;

  /* YouTube is currently prone to login/403 playback failures.
   * When the same song exists on SoundCloud, put that playable copy first.
   */
  try {
    const sc = await this.kazagumo.search(
      clean(query),
      { requester, source: "scsearch:" }
    );

    const match = (sc?.tracks || []).find(track => textMatches(query, track));

    if (match) {
      const rest = result.tracks.filter(track => track !== match);
      return {
        ...result,
        tracks: [match, ...rest]
      };
    }
  } catch (error) {
    console.warn("⚠️ SoundCloud fallback search failed:", error?.message || error);
  }

  return result;
};

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

/*
 * Handle music panel buttons before index.js sees them. This removes the
 * generic "Music control updated" response and gives each action a real
 * confirmation message.
 */
if (!Client.prototype.__deathMusicButtonPatch) {
  Client.prototype.__deathMusicButtonPatch = true;

  const originalEmit = Client.prototype.emit;

  Client.prototype.emit = function(event, ...args) {
    if (event === "interactionCreate") {
      const interaction = args[0];

      if (
        this.music &&
        interaction?.isButton?.() &&
        String(interaction.customId || "").startsWith("death_music_")
      ) {
        handleMusicButton(this.music, interaction).catch(error => {
          console.error("❌ Music button handler error:", error?.message || error);
        });
        return true;
      }
    }

    return originalEmit.call(this, event, ...args);
  };
}

async function handleMusicButton(music, interaction) {
  const guildId = interaction.guildId;

  if (!guildId) {
    return interaction.reply({
      content: "❌ Server only.",
      ephemeral: true
    });
  }

  const id = interaction.customId;

  try {
    let message = null;

    switch (id) {
      case "death_music_pause":
        await music.pause(guildId);
        message = "⏸️ Music paused.";
        break;

      case "death_music_resume":
        await music.resume(guildId);
        message = "▶️ Music resumed.";
        break;

      case "death_music_skip":
        await music.skip(guildId);
        message = "⏭️ Music skipped.";
        break;

      case "death_music_stop":
        await music.stop(guildId);
        message = "⏹️ Music stopped.";
        break;

      case "death_music_shuffle":
        await music.shuffle(guildId);
        message = "🔀 Music queue shuffled.";
        break;

      /* Old buttons can survive until the panel gets edited once. */
      default:
        message = "ℹ️ This music control was removed.";
        break;
    }

    await music.refreshPanel(guildId).catch(() => {});

    return interaction.reply({
      content: message,
      ephemeral: true
    });
  } catch (error) {
    return interaction.reply({
      content: `❌ ${error?.message || "Music control failed."}`,
      ephemeral: true
    });
  }
}

/*
 * Playback fallback: when YouTube refuses a track, try a matching SoundCloud
 * copy automatically instead of leaving the player silent.
 */
if (!MusicManager.prototype.__deathPlaybackFallbackPatch) {
  MusicManager.prototype.__deathPlaybackFallbackPatch = true;

  const fallbackBusy = new Set();

  const getSource = track => String(
    track?.info?.sourceName || track?.sourceName || ""
  ).toLowerCase();

  MusicManager.prototype.__deathHandlePlaybackException = async function(player) {
    const guildId = player?.guildId;
    if (!guildId || fallbackBusy.has(guildId)) return;

    const current = player?.queue?.current;
    if (!current || !isYouTubeTrack(current)) return;

    fallbackBusy.add(guildId);

    try {
      const title = this.getTrackTitle(current);
      const author = this.getTrackAuthor(current);
      const query = `${title} ${author}`.trim();

      const result = await this.kazagumo.search(
        query,
        {
          requester: this.client.user,
          source: "scsearch:"
        }
      );

      const match = (result?.tracks || []).find(track =>
        isSoundCloudTrack(track) && textMatches(title, track)
      );

      if (!match) {
        console.warn(`⚠️ No SoundCloud fallback found for: ${query}`);
        return;
      }

      console.log(`🔁 Playback fallback: ${title} → ${this.getTrackTitle(match)} [SoundCloud]`);

      player.queue.add(match);
      await sleep(250);
      await player.skip().catch(() => {});
    } catch (error) {
      console.warn("⚠️ Playback fallback failed:", error?.message || error);
    } finally {
      setTimeout(() => fallbackBusy.delete(guildId), 3000);
    }
  };

  /* The listener is attached per Kazagumo instance the first time a manager is used. */
  const originalStartRecoveryLoop = MusicManager.prototype.startRecoveryLoop;
  MusicManager.prototype.startRecoveryLoop = function(...args) {
    if (!this.__deathFallbackListenerAttached) {
      this.__deathFallbackListenerAttached = true;
      this.kazagumo.on("playerException", player => {
        this.__deathHandlePlaybackException(player).catch(() => {});
      });
    }

    return originalStartRecoveryLoop.apply(this, args);
  };
}

console.log("🛠️ DEATH voice runtime repair hooked MusicManager directly.");
console.log("🎛️ DEATH compact music panel enabled.");
console.log("🔊 DEATH playback fallback enabled.");
