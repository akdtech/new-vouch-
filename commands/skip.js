const { SlashCommandBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("skip")
    .setDescription("Skip to the next track on Spotify."),
  async execute(interaction) {
    await interaction.client.spotify.next(interaction.guildId, interaction.user.id);
    return interaction.reply("⏭️ Skipped to the next Spotify track.");
  }
};
