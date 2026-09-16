const { SlashCommandBuilder } = require("discord.js");

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
      return interaction.editReply(
        `❌ ${error?.message || "Music error."}`
      );
    }
  }
};
