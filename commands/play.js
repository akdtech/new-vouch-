const { SlashCommandBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder().setName("play").setDescription("Play a track through your linked Spotify Connect device.").addStringOption(option => option.setName("query").setDescription("Song name or Spotify track link").setRequired(true)),
  async execute(interaction) {
    if (!interaction.guildId) return interaction.reply({ content: "Server only.", ephemeral: true });
    const query = interaction.options.getString("query", true).trim();
    await interaction.deferReply();
    try {
      const result = await interaction.client.spotify.playQuery(interaction.guildId, interaction.user.id, query);
      const track = result.track;
      const controller = result.controller;
      return interaction.editReply("▶️ **Now playing on Spotify**\\n🎵 **" + track.title + "** — " + track.author + "\\n🎧 Device: **your active Spotify device**\\n👤 Controller: **" + (controller.display_name || "Spotify") + "**\\n🔗 " + track.url);
    } catch (error) {
      console.error("play error:", error);
      return interaction.editReply("❌ " + String(error?.message || error).replace(/\\s+/g, " ").slice(0, 1800));
    }
  }
};
