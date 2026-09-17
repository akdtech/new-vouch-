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

  // Discord message content is limited to 2000 characters. Keep the user
  // response short while the full diagnostic remains in Railway logs.
  const compact = raw.replace(/\s+/g, " ").trim();
  return `❌ ${compact.slice(0, 1800)}${compact.length > 1800 ? "…" : ""}`;
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

    try {
      const result = await music.play({
        guildId: interaction.guildId,
        voiceId: interaction.member?.voice?.channelId || music.getPermanentVoiceChannelId(),
        textId: music.getPermanentVoiceChannelId(),
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
      console.error("❌ /play:", error);
      return interaction.editReply(userSafeMusicError(error));
    }
  }
};
