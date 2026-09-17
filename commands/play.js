const { SlashCommandBuilder } = require("discord.js");

function userSafeMusicError(error) {
  const raw = String(error?.message || "Music error.");
  const lower = raw.toLowerCase();

  if (lower.includes("sign in to confirm") || lower.includes("not a bot")) {
    return "❌ YouTube is currently blocking playback from the Railway server IP. The music engine will retry later automatically.";
  }

  if (lower.includes("no playable youtube stream")) {
    return "❌ I couldn't get an audio stream from YouTube right now. Please try again in a moment.";
  }

  const compact = raw.replace(/\s+/g, " ").trim();
  return `❌ ${compact.slice(0, 1800)}${compact.length > 1800 ? "…" : ""}`;
}

function isTransientPlaybackFailure(error) {
  const text = String(error?.message || "").toLowerCase();
  return [
    "no pcm",
    "ffmpeg",
    "yt-dlp",
    "soundcloud",
    "youtube playback failed",
    "no audio bytes",
    "timed out",
    "exited null"
  ].some(marker => text.includes(marker));
}

async function replyAfterFailure(interaction, content) {
  try {
    if (interaction.replied || interaction.deferred) {
      return await interaction.editReply(content);
    }
    return await interaction.reply(content);
  } catch (error) {
    if (error?.code === 10008) {
      try { return await interaction.followUp(content); } catch {}
    }
    throw error;
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("play")
    .setDescription("Add a song or playlist to DEATH Music 24/7.")
    .addStringOption(option =>
      option
        .setName("query")
        .setDescription("Song name, artist, YouTube URL or playlist")
        .setRequired(true)
    ),

  async execute(interaction, { music }) {
    if (!interaction.guildId) {
      return interaction.reply({ content: "❌ Server only.", ephemeral: true });
    }

    const query = interaction.options.getString("query", true).trim();
    await interaction.deferReply();

    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const result = await music.play({
          guildId: interaction.guildId,
          voiceId: interaction.member?.voice?.channelId || music.getPermanentVoiceChannelId(),
          textId: interaction.channelId,
          query,
          requester: interaction.user
        });

        const track = result.track || result.tracks?.[0];
        const title = music.getTrackTitle(track);

        if (result.type === "playlist") {
          return interaction.editReply(
            result.startedNow
              ? `▶️ **Starting playlist:** ${result.tracks.length} tracks`
              : `🎵 **Added playlist to queue:** ${result.tracks.length} tracks`
          );
        }

        return interaction.editReply(
          result.startedNow
            ? `▶️ **Now playing:** ${title}`
            : `🎵 **Added to queue:** ${title}`
        );
      } catch (error) {
        lastError = error;
        console.error(`❌ /play attempt ${attempt}:`, error);
        if (attempt < 2 && isTransientPlaybackFailure(error)) {
          await new Promise(resolve => setTimeout(resolve, 1200));
          continue;
        }
        break;
      }
    }

    try {
      return await replyAfterFailure(interaction, userSafeMusicError(lastError));
    } catch (error) {
      if (error?.code !== 10008) console.error("❌ /play response error:", error);
      return null;
    }
  }
};
