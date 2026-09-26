const { SlashCommandBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Pause Spotify playback."),
  async execute(interaction) {
    await interaction.client.spotify.pause(interaction.guildId, interaction.user.id);
    return interaction.reply("⏹️ Spotify playback paused.");
  }
};
